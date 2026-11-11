// XP kayıtları data/xp.json dosyasında, sunucu ve kullanıcı başına { xp, level, mesajSon, sesDakika }.
// Ayrıca sunucu başına seviye rolleri (seviye -> { rol, kim }: rolü kimin bağladığı, rol verilirken onun
// yetkisi yeniden denetlenir) ve XP almayan kanal/rol listeleri.
// KİŞİSEL VERİ: Discord kullanıcı kimlikleri ve sayaçlar saklanır; mesaj içeriği ve kullanıcı adı saklanmaz.
//
// Yazım: XP değişiklikleri bellekte toplanır ve TOPLU yazılır (ilk değişiklikten birkaç saniye sonra tek
// yazım). Bot kapanırken kalan yazılır. Yazım geçici dosya + ad değiştirme iledir (yarım dosya kalmaz);
// bot çökerse en çok son birkaç saniyenin XP'si kaybolur. Yönetici işlemleri (ver/al/sıfırla, rol ve hariç
// listeleri) hemen yazılır; yazılamazsa bellekteki değişiklik geri alınır ve hata gösterilir.
// Bozuk dosya "*.bozuk-<zaman>" adıyla saklanır; daha yeni bir bot sürümünün dosyasına dokunulmaz.
// Kimlikler yalnız 17-20 haneli Discord kimliği olabilir ("__proto__" gibi ayrılmış adlar kabul edilmez).
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { levelForXp, MAX_SEVIYE, MAX_XP } from './xp.js';

export const XP_SCHEMA_VERSION = 1;
export const FLUSH_DELAY_MS = 5000;
export const MAX_LEVEL_ROLES = 25;
export const MAX_EXCLUDED = 25;
const SNOWFLAKE = /^\d{17,20}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && SNOWFLAKE.test(value);
const clampXp = (xp) => Math.max(0, Math.min(MAX_XP, Math.floor(Number(xp) || 0)));
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** The written messages (Turkish) this store throws with. */
export const DEPO_HATALARI = {
  kaydedilemedi:
    'XP kayıtları kaydedilemedi (data/xp.json yazılamadı; dosya başka bir programda açık olabilir). Değişiklik geri alındı, biraz sonra tekrar deneyin.',
  yeniSurum:
    'Seviye verileri şu an değiştirilemiyor: data/xp.json daha yeni bir bot sürümüne ait. Bot sahibi botu güncellemeli.',
};

function emptyGuild() {
  return { users: new Map(), roles: new Map(), haricKanallar: new Set(), haricRoller: new Set() };
}

function sanitizeUser(raw) {
  if (!isPlainObject(raw)) return null;
  const xp = clampXp(raw.xp);
  return {
    xp,
    level: levelForXp(xp),
    mesajSon: Number.isFinite(raw.mesajSon) && raw.mesajSon > 0 ? raw.mesajSon : 0,
    sesDakika: count(raw.sesDakika),
  };
}

function sanitizeGuild(raw) {
  const guild = emptyGuild();
  if (!isPlainObject(raw)) return guild;
  for (const [userId, user] of Object.entries(isPlainObject(raw.kullanicilar) ? raw.kullanicilar : {})) {
    const clean = isId(userId) ? sanitizeUser(user) : null;
    if (clean) guild.users.set(userId, clean);
  }
  for (const [level, entry] of Object.entries(isPlainObject(raw.roller) ? raw.roller : {})) {
    const l = Number(level);
    if (!Number.isInteger(l) || l < 1 || l > MAX_SEVIYE || guild.roles.size >= MAX_LEVEL_ROLES) continue;
    if (isPlainObject(entry) && isId(entry.rol))
      guild.roles.set(l, { rol: entry.rol, kim: isId(entry.kim) ? entry.kim : null });
  }
  for (const id of Array.isArray(raw.haricKanallar) ? raw.haricKanallar : []) {
    if (isId(id) && guild.haricKanallar.size < MAX_EXCLUDED) guild.haricKanallar.add(id);
  }
  for (const id of Array.isArray(raw.haricRoller) ? raw.haricRoller : []) {
    if (isId(id) && guild.haricRoller.size < MAX_EXCLUDED) guild.haricRoller.add(id);
  }
  return guild;
}

function serializeGuild(guild) {
  const kullanicilar = Object.create(null);
  for (const [userId, user] of guild.users) kullanicilar[userId] = { ...user };
  const roller = Object.create(null);
  for (const [level, entry] of [...guild.roles].sort((a, b) => a[0] - b[0])) roller[level] = { ...entry };
  return { kullanicilar, roller, haricKanallar: [...guild.haricKanallar], haricRoller: [...guild.haricRoller] };
}

const cloneGuild = (guild) => ({
  users: new Map([...guild.users].map(([id, user]) => [id, { ...user }])),
  roles: new Map([...guild.roles].map(([level, entry]) => [level, { ...entry }])),
  haricKanallar: new Set(guild.haricKanallar),
  haricRoller: new Set(guild.haricRoller),
});

const isEmptyGuild = (guild) =>
  !guild.users.size && !guild.roles.size && !guild.haricKanallar.size && !guild.haricRoller.size;

/**
 * @param {object} deps
 * @param {string} deps.file data/xp.json
 * @param {{ setTimeout: Function, clearTimeout: Function }} [deps.timers] the bot clock (a fake one in tests)
 * @param {number} [deps.flushDelayMs] how long changes are collected before one write
 */
export function createXpStore({ file, logger, fs = nodeFs, timers = globalThis, flushDelayMs = FLUSH_DELAY_MS }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error) logger?.warn?.(`XP dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  const readOnly = Number(data.schemaVersion ?? 1) > XP_SCHEMA_VERSION;
  if (readOnly) logger?.warn?.('data/xp.json daha yeni bir bot sürümüne ait; dosyaya dokunulmuyor, XP verilmiyor.');

  /** guildId -> { users: Map(userId -> record), roles: Map(level -> { rol, kim }), haricKanallar, haricRoller } */
  const guilds = new Map();
  for (const [guildId, raw] of Object.entries(!readOnly && isPlainObject(data.sunucular) ? data.sunucular : {})) {
    if (!isId(guildId)) continue;
    const guild = sanitizeGuild(raw);
    if (!isEmptyGuild(guild)) guilds.set(guildId, guild);
  }

  let timer = null;
  let dirty = false;
  let warned = false;
  let writes = 0;

  function writeNow() {
    const sunucular = Object.create(null);
    for (const [guildId, guild] of guilds) if (!isEmptyGuild(guild)) sunucular[guildId] = serializeGuild(guild);
    writeJsonAtomic(file, { schemaVersion: XP_SCHEMA_VERSION, sunucular }, { fs });
    writes += 1;
    dirty = false;
  }

  /** Writes pending changes; a failed write keeps them for the next try (warned once). */
  function flush() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (!dirty || readOnly) return true;
    try {
      writeNow();
      warned = false;
      return true;
    } catch (writeError) {
      if (!warned) logger?.warn?.('XP dosyası yazılamadı; sonra tekrar denenecek:', writeError?.message ?? writeError);
      warned = true;
      schedule();
      return false;
    }
  }

  function schedule() {
    dirty = true;
    if (timer || readOnly) return;
    timer = timers.setTimeout(() => {
      timer = null;
      flush();
    }, flushDelayMs);
    timer?.unref?.();
  }

  const guildOf = (guildId, create = false) => {
    if (!isId(guildId)) throw new Error('Geçersiz sunucu kimliği');
    let guild = guilds.get(guildId);
    if (!guild && create) guilds.set(guildId, (guild = emptyGuild()));
    return guild ?? null;
  };

  const userOf = (guild, userId, create = false) => {
    if (!isId(userId)) throw new Error('Geçersiz kullanıcı kimliği');
    let user = guild.users.get(userId);
    if (!user && create) guild.users.set(userId, (user = { xp: 0, level: 0, mesajSon: 0, sesDakika: 0 }));
    return user ?? null;
  };

  /**
   * Runs an admin change and writes it at once. When the file cannot be written the guild goes back to
   * how it was and OzellikHatasi is thrown. `change` must be synchronous (nothing can interleave).
   */
  function transaction(guildId, change) {
    if (readOnly) throw new OzellikHatasi(DEPO_HATALARI.yeniSurum);
    const before = guilds.has(guildId) ? cloneGuild(guilds.get(guildId)) : null;
    const result = change(guildOf(guildId, true));
    try {
      writeNow();
      if (timer) timers.clearTimeout(timer);
      timer = null;
    } catch (writeError) {
      if (before) guilds.set(guildId, before);
      else guilds.delete(guildId);
      logger?.warn?.('XP dosyası yazılamadı:', writeError?.message ?? writeError);
      throw new OzellikHatasi(DEPO_HATALARI.kaydedilemedi);
    }
    if (isEmptyGuild(guilds.get(guildId))) guilds.delete(guildId);
    return result;
  }

  function setXp(user, xp) {
    const onceki = user.level;
    user.xp = clampXp(xp);
    user.level = levelForXp(user.xp);
    return { onceki, sonraki: user.level, xp: user.xp };
  }

  /** Users of a guild sorted by XP (ties: the smaller id first, so the order is stable). */
  function ranked(guild) {
    return [...guild.users]
      .filter(([, user]) => user.xp > 0)
      .sort((a, b) => b[1].xp - a[1].xp || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1));
  }

  return {
    saltOkunur: readOnly,

    /** How many times the file was written (tests check the batching with it). */
    get yazimSayisi() {
      return writes;
    },

    /** A copy of a user's record, or null. */
    kayit(guildId, userId) {
      const guild = guildOf(guildId);
      const user = guild ? userOf(guild, userId) : null;
      return user ? { ...user } : null;
    },

    /**
     * Gives message XP when the cooldown is over (checked and updated in one synchronous step).
     * @returns {{ onceki: number, sonraki: number, xp: number }|null} null when still cooling down
     */
    mesajXp(guildId, userId, { now, amount, waitMs, cooldownOver }) {
      if (readOnly) return null;
      const user = userOf(guildOf(guildId, true), userId, true);
      if (!cooldownOver(now, user.mesajSon, waitMs)) return null;
      user.mesajSon = now;
      const result = setXp(user, user.xp + amount);
      schedule();
      return result;
    },

    /** Gives one minute of voice XP. */
    sesXp(guildId, userId, amount) {
      if (readOnly) return null;
      const user = userOf(guildOf(guildId, true), userId, true);
      user.sesDakika += 1;
      const result = setXp(user, user.xp + amount);
      schedule();
      return result;
    },

    /** Admin: adds (or with a negative amount takes away) XP; written at once. */
    xpDegistir(guildId, userId, delta) {
      return transaction(guildId, (guild) => {
        const user = userOf(guild, userId, true);
        return setXp(user, user.xp + delta);
      });
    },

    /** Admin: deletes one user's record (also used when a member leaves and the setting says so). */
    sil(guildId, userId, { hemen = true } = {}) {
      const guild = guildOf(guildId);
      if (!guild || !isId(userId) || !guild.users.has(userId)) return false;
      if (!hemen) {
        guild.users.delete(userId);
        schedule();
        return true;
      }
      return transaction(guildId, (g) => g.users.delete(userId));
    },

    /** Admin: deletes every user record of a guild (level roles and excluded lists stay). @returns {number} */
    sunucuyuSifirla(guildId) {
      if (!guildOf(guildId)?.users.size) return 0;
      return transaction(guildId, (guild) => {
        const n = guild.users.size;
        guild.users.clear();
        return n;
      });
    },

    /** { satirlar: [{ userId, xp, level, sira }], toplam } for a leaderboard page (sayfa from 0). */
    liderlik(guildId, sayfa = 0, boyut = 10) {
      const guild = guildOf(guildId);
      const list = guild ? ranked(guild) : [];
      const start = Math.max(0, sayfa) * boyut;
      return {
        satirlar: list
          .slice(start, start + boyut)
          .map(([userId, user], i) => ({ userId, xp: user.xp, level: user.level, sira: start + i + 1 })),
        toplam: list.length,
      };
    },

    /** The 1-based rank of a user (null without XP). */
    sira(guildId, userId) {
      const guild = guildOf(guildId);
      if (!guild || !(guild.users.get(userId)?.xp > 0)) return null;
      return ranked(guild).findIndex(([id]) => id === userId) + 1;
    },

    /** Level roles: Map(level -> roleId), sorted by level. */
    roller(guildId) {
      return new Map(
        [...(guildOf(guildId)?.roles ?? [])].sort((a, b) => a[0] - b[0]).map(([level, { rol }]) => [level, rol]),
      );
    },

    /** Who linked a role to a level (null when unknown); the role is checked against them when given. */
    rolAyarlayan(guildId, roleId) {
      for (const { rol, kim } of guildOf(guildId)?.roles?.values() ?? []) if (rol === roleId) return kim;
      return null;
    },

    /** Admin: sets (or with null removes) the role of a level; written at once. */
    rolAyarla(guildId, level, roleId, kim = null) {
      if (!Number.isInteger(level) || level < 1 || level > MAX_SEVIYE) throw new Error('Geçersiz seviye');
      if (roleId !== null && (!isId(roleId) || !isId(kim))) throw new Error('Geçersiz rol ya da ayarlayan');
      return transaction(guildId, (guild) => {
        if (roleId === null) return guild.roles.delete(level);
        if (!guild.roles.has(level) && guild.roles.size >= MAX_LEVEL_ROLES) return false;
        guild.roles.set(level, { rol: roleId, kim });
        return true;
      });
    },

    /** { kanallar: Set, roller: Set } that earn no XP. */
    haric(guildId) {
      const guild = guildOf(guildId);
      return { kanallar: new Set(guild?.haricKanallar ?? []), roller: new Set(guild?.haricRoller ?? []) };
    },

    /**
     * Admin: adds the id to (or removes it from) an excluded list; written at once.
     * @param {'kanal'|'rol'} tur
     * @returns {'eklendi'|'cikarildi'|'dolu'}
     */
    haricDegistir(guildId, tur, id) {
      if (!isId(id) || (tur !== 'kanal' && tur !== 'rol')) throw new Error('Geçersiz kimlik');
      return transaction(guildId, (guild) => {
        const set = tur === 'kanal' ? guild.haricKanallar : guild.haricRoller;
        if (set.has(id)) {
          set.delete(id);
          return 'cikarildi';
        }
        if (set.size >= MAX_EXCLUDED) return 'dolu';
        set.add(id);
        return 'eklendi';
      });
    },

    flush,
    kapat() {
      flush();
    },
  };
}
