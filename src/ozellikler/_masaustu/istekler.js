// Masaüstü uygulamasından gelen ayar istekleri (karar A1: port açılmaz, yalnız yerel dosyalar).
//   data/istekler/<uuid>.json  uygulama yazar: { surum: 1, guildId, modul, alan, deger, istenen }
//   data/yanitlar/<uuid>.json  bot yazar:      { surum: 1, id, ok, hata, yeniDeger, islendi }
// Bot klasörü fs.watch ile izler, yanında yoklama yedeği var. Her istek /ayar ile AYNI yoldan geçer
// (ayarlar/komut.js applySetting: sema.js validateValue + depo.js set): kanal türü, botun yazma izni, rol
// hiyerarşisi ve yasaklı izin denetimleri aynen geçerli. Bot isteği okumadan önce adını <uuid>.isleniyor yapar
// (sahiplenir); uygulama yalnız hâlâ <uuid>.json adındaki isteği geri alabilir. İşlenen istek silinir; yanıtlar
// 10 dakika sonra silinir.
//
// Rol ayarlarında "ayarlayan" (_kim) bot sahibidir (src/bot/owner.js). İstek botun çalıştığı bilgisayardan
// gelir; o bilgisayarı yöneten kişi botun sahibidir. Rol verilirken ayarlayanın hâlâ sunucuda olması, "Sunucuyu
// Yönet" iznini koruması ve rolün onun en yüksek rolünden aşağıda olması yeniden denetlenir (_roller.js); bu
// yüzden sahip o sunucuda değilse ya da izni yoksa rol ayarı reddedilir: sunucu sahibini ya da kimseyi
// kaydetmek bu kuralı delerdi. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { writeJsonAtomic } from '../../util/atomicFile.js';
import { ACTION_PATTERN, NAME_PATTERN, isReserved, own } from '../_ortak.js';
import { highestPosition } from '../_roller.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { applySetting } from '../ayarlar/komut.js';
import { SNOWFLAKE } from '../ayarlar/sema.js';
import { coveredKeys, plainText } from './gorunum.js';
import { hatalar, konsol } from './mesajlar.js';

export const REQUEST_VERSION = 1;
export const MAX_REQUEST_BYTES = 16 * 1024;
/** Only "<uuid>.json": anything else in the folder (the app's temporary files too) is left alone. */
export const REQUEST_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
/** A request the app took back (renamed away, then removed); left only when removing failed. */
export const WITHDRAWN_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.geri-alindi$/;
/** A request the bot has claimed (renamed before reading); the app never touches these. */
export const CLAIMED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.isleniyor$/;
/** At most this many requests per look at the folder, and at most this many waiting (older ones dropped). */
export const BATCH = 50;
export const BACKLOG = 500;
const FIELDS = ['surum', 'guildId', 'modul', 'alan', 'deger', 'istenen'];
const MAX_AGE_MS = 5 * 60_000;
const MAX_FUTURE_MS = 60_000;
const MAX_TEXT = 2000;
const MAX_LIST = 50;
const ANSWER_TTL_MS = 10 * 60_000;

/** A refused request; the message goes into the answer as it is. */
export class IstekHatasi extends Error {
  constructor(message) {
    super(message);
    this.name = 'IstekHatasi';
  }
}
const refuse = (text) => {
  throw new IstekHatasi(text);
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function checkValue(deger) {
  if (deger === null || typeof deger === 'boolean') return;
  if (typeof deger === 'number') {
    if (!Number.isSafeInteger(deger)) refuse(hatalar.bicim('sayı tam sayı olmalı'));
    return;
  }
  if (typeof deger === 'string') {
    if (deger.length > MAX_TEXT) refuse(hatalar.bicim(`metin en fazla ${MAX_TEXT} karakter`));
    return;
  }
  if (Array.isArray(deger)) {
    if (deger.length > MAX_LIST) refuse(hatalar.liste(MAX_LIST));
    if (!deger.every((id) => typeof id === 'string' && SNOWFLAKE.test(id)))
      refuse(hatalar.bicim('liste kimlik içermeli'));
    return;
  }
  refuse(hatalar.bicim('değer türü desteklenmiyor'));
}

/**
 * Parses and checks the text of one request file (size, JSON, exact fields, names, value shape, age).
 * Throws IstekHatasi with a Turkish reason.
 */
export function parseRequest(text, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  if (typeof text !== 'string') refuse(hatalar.bozukDosya);
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) refuse(hatalar.buyukDosya(MAX_REQUEST_BYTES / 1024));
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    refuse(hatalar.bozukDosya);
  }
  if (!isPlainObject(raw)) refuse(hatalar.bicim('bir JSON nesnesi bekleniyordu'));
  const keys = Object.keys(raw);
  const unknown = keys.find((key) => !FIELDS.includes(key));
  if (unknown !== undefined) refuse(hatalar.bicim(`bilinmeyen alan "${String(unknown).slice(0, 40)}"`));
  const missing = FIELDS.find((key) => !Object.hasOwn(raw, key));
  if (missing) refuse(hatalar.bicim(`"${missing}" alanı eksik`));
  if (raw.surum !== REQUEST_VERSION) refuse(hatalar.bicim('desteklenmeyen sürüm'));
  if (typeof raw.guildId !== 'string' || !SNOWFLAKE.test(raw.guildId)) refuse(hatalar.bicim('sunucu kimliği'));
  if (
    typeof raw.modul !== 'string' ||
    typeof raw.alan !== 'string' ||
    !NAME_PATTERN.test(raw.modul) ||
    !ACTION_PATTERN.test(raw.alan) ||
    isReserved(raw.modul) ||
    isReserved(raw.alan)
  ) {
    refuse(hatalar.bicim('modül ya da ayar adı geçersiz ya da ayrılmış'));
  }
  checkValue(raw.deger);
  const at = typeof raw.istenen === 'string' ? Date.parse(raw.istenen) : NaN;
  if (!Number.isFinite(at) || at - now > MAX_FUTURE_MS) refuse(hatalar.bicim('istek zamanı'));
  if (now - at > maxAgeMs) refuse(hatalar.eski);
  return { guildId: raw.guildId, modul: raw.modul, alan: raw.alan, deger: raw.deger, istenen: at };
}

/** The channel or role object (or primitive) validateValue expects, from what the app sent. */
function rawValue(alan, deger, guild) {
  switch (alan.tur) {
    case 'kanal':
      if (typeof deger !== 'string') refuse(hatalar.deger);
      return guild.channels?.cache?.get(deger) ?? refuse(hatalar.kanalYok);
    case 'rol':
      if (typeof deger !== 'string') refuse(hatalar.deger);
      return guild.roles?.cache?.get(deger) ?? refuse(hatalar.rolYok);
    case 'metin':
      return typeof deger === 'string' ? deger : refuse(hatalar.deger);
    case 'sayi':
      return Number.isInteger(deger) ? deger : refuse(hatalar.deger);
    case 'bayrak':
      return typeof deger === 'boolean' ? deger : refuse(hatalar.deger);
    default:
      return refuse(hatalar.deger);
  }
}

/**
 * The bot owner as a member of the guild, with "Sunucuyu Yönet": recorded as who set a role setting. With
 * several owners, the qualifying one with the highest role (the guild owner first).
 * Throws IstekHatasi when no owner qualifies.
 */
export async function ownerMember(context, guild) {
  const ids = (await context.isOwner?.ids?.().catch(() => [])) ?? [];
  if (!ids.length) refuse(hatalar.sahipBilinmiyor);
  let inGuild = false;
  let best = null;
  let bestPosition = -Infinity;
  for (const id of new Set(ids)) {
    const member = guild.members?.cache?.get(id) ?? (await guild.members?.fetch?.(id).catch(() => null)) ?? null;
    if (!member) continue;
    inGuild = true;
    if (guild.ownerId !== id && !member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) continue;
    // Several owners (a team): the one with the highest role, so the widest role choice is checked against them.
    const position = guild.ownerId === id ? Infinity : highestPosition(guild, member);
    if (position > bestPosition) [best, bestPosition] = [member, position];
  }
  return best ?? refuse(inGuild ? hatalar.sahipYetkisiz : hatalar.sahipUyeDegil);
}

/** Applies a parsed request; returns the value in effect afterwards. Throws IstekHatasi or OzellikHatasi. */
export async function applyRequest(context, istek) {
  const { ozellikler, client } = context;
  const guild = client.guilds?.cache?.get(istek.guildId);
  if (!guild) refuse(hatalar.sunucuYok);
  const module = ozellikler.moduller.get(istek.modul);
  if (!module) refuse(hatalar.modulYok);
  const off = ozellikler.disabledReason(istek.modul);
  if (off) throw new OzellikHatasi(off);

  const list = own(module.ayarListeleri, istek.alan);
  if (list) {
    if (list.tur === 'ozel' || list.yalnizDiscord) refuse(hatalar.yalnizDiscord(list.yalnizDiscord));
    const ids = istek.deger ?? [];
    if (!Array.isArray(ids)) refuse(hatalar.deger);
    if (new Set(ids).size > list.enFazla) refuse(hatalar.liste(list.enFazla));
    return list.uygula(context, guild, ids);
  }

  const alan = own(module.ayarlar, istek.alan);
  if (!alan || coveredKeys(module).has(istek.alan)) refuse(hatalar.ayarYok);
  const where = { guild, modul: istek.modul, anahtar: istek.alan, gizliDahil: true };
  if (istek.deger === null) return applySetting(context, { ...where, sifirla: true }).value;
  const raw = rawValue(alan, istek.deger, guild);
  const member = alan.tur === 'rol' ? await ownerMember(context, guild) : null;
  return applySetting(context, { ...where, raw, member, kim: member?.id ?? null }).value;
}

/**
 * One request file's text -> its answer { ok, hata, yeniDeger }. Never throws: an unexpected error is logged
 * and answered with a general reason.
 */
export async function processRequest(context, text, { now = Date.now(), logger = context.logger } = {}) {
  let istek = null;
  try {
    istek = parseRequest(text, { now });
    const yeniDeger = await applyRequest(context, istek);
    logger?.info?.(konsol.uygulandi(istek.guildId, `${istek.modul}.${istek.alan}`));
    return { ok: true, hata: null, yeniDeger: yeniDeger ?? null, istek };
  } catch (error) {
    const known = error instanceof IstekHatasi || error instanceof OzellikHatasi;
    const guild = istek ? context.client.guilds?.cache?.get(istek.guildId) : null;
    const hata = known ? plainText(error.message, guild) : hatalar.beklenmeyen;
    if (!known) logger?.error?.('Masaüstü ayar isteği işlenemedi:', error?.stack ?? error);
    else if (istek) logger?.warn?.(konsol.reddedildi(istek.guildId, `${istek.modul}.${istek.alan}`, hata));
    return { ok: false, hata, yeniDeger: null, istek };
  }
}

/** Removes a file or a link (never what a link points to); quiet when it is already gone. */
async function removeEntry(fsp, file, stat) {
  try {
    if (stat?.isDirectory?.() && !stat.isSymbolicLink?.()) return false; // a real folder is never removed
    await fsp.unlink(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    try {
      await fsp.rmdir(file); // a directory symlink or junction on Windows: removes the link itself
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Reads at most MAX_REQUEST_BYTES + 1 bytes of a claimed request, from an open handle that is checked to be
 * the regular file lstat saw (no link swapped in between). Throws IstekHatasi.
 */
async function readClaimed(fsp, file, linkStat, flags) {
  const handle = await fsp.open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== linkStat.ino || stat.dev !== linkStat.dev) refuse(hatalar.baglanti);
    const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_REQUEST_BYTES) refuse(hatalar.buyukDosya(MAX_REQUEST_BYTES / 1024));
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Watches data/istekler and answers in data/yanitlar. Requests are handled one at a time, oldest first,
 * at most `perSecond` a second and `batch` per look at the folder. Before reading, a request is claimed by
 * renaming it to "<uuid>.isleniyor": the app can only take back a request still named "<uuid>.json", so a
 * request is either withdrawn or applied, never both. More than `backlog` waiting requests: the oldest are
 * removed unread (with one warning) so a flood cannot hold the bot up.
 */
export function createRequestProcessor({
  context,
  dir,
  answersDir,
  logger = context.logger,
  fs = nodeFs,
  timers = globalThis,
  now = Date.now,
  perSecond = 5,
  batch = BATCH,
  backlog = BACKLOG,
  pollMs = 2000,
  answerTtlMs = ANSWER_TTL_MS,
  onApplied,
}) {
  const fsp = fs.promises;
  const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let stopped = true;
  let running = null;
  let again = false;
  let scheduled = null;
  let watcher = null;
  let poll = null;
  let sweeper = null;
  let floodWarned = false;
  /** Processed requests whose file could not be removed (e.g. a folder named like one): not answered again. */
  const stuck = new Set();
  /** When the last requests were handled (rate limit). */
  const recent = [];

  /** The oldest waiting requests (claimed ones left by a crash first), at most `batch`; trims a flood. */
  async function pending() {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const waiting = [];
    for (const name of names) {
      const claimed = CLAIMED_NAME.test(name);
      if (!claimed && !REQUEST_NAME.test(name)) continue;
      const id = name.slice(0, name.lastIndexOf('.'));
      if (!stuck.has(id)) waiting.push({ id, name, claimed });
    }
    const stats = [];
    for (let i = 0; i < waiting.length; i += 100) {
      const chunk = waiting.slice(i, i + 100);
      const results = await Promise.all(chunk.map((w) => fsp.lstat(join(dir, w.name)).catch(() => null)));
      chunk.forEach((w, j) => results[j] && stats.push({ ...w, stat: results[j] }));
    }
    stats.sort((a, b) => b.claimed - a.claimed || a.stat.mtimeMs - b.stat.mtimeMs || a.id.localeCompare(b.id));
    if (stats.length > backlog) {
      const dropped = stats.splice(0, stats.length - backlog).filter((w) => !w.claimed);
      for (const w of dropped) await removeEntry(fsp, join(dir, w.name), w.stat);
      if (!floodWarned) logger?.warn?.(konsol.birikti(dropped.length, backlog));
      floodWarned = true;
    } else if (stats.length < backlog / 2) {
      floodWarned = false;
    }
    return stats.slice(0, batch);
  }

  async function answer(id, result) {
    try {
      writeJsonAtomic(
        join(answersDir, `${id}.json`),
        {
          surum: REQUEST_VERSION,
          id,
          ok: result.ok,
          hata: result.hata,
          yeniDeger: result.yeniDeger,
          islendi: new Date(now()).toISOString(),
        },
        { fs },
      );
    } catch (error) {
      logger?.warn?.(konsol.yazilamadi(`yanitlar/${id}.json`, error?.message ?? error));
    }
  }

  async function handle({ id, name, claimed }) {
    const file = join(dir, `${id}.isleniyor`);
    if (!claimed) {
      try {
        await fsp.rename(join(dir, name), file);
      } catch {
        return; // the app took it back (or it is gone): nothing to answer
      }
    }
    let stat;
    try {
      stat = await fsp.lstat(file);
    } catch {
      return;
    }
    let result;
    try {
      if (stat.isSymbolicLink() || !stat.isFile()) refuse(hatalar.baglanti);
      if (stat.size > MAX_REQUEST_BYTES) refuse(hatalar.buyukDosya(MAX_REQUEST_BYTES / 1024));
      const text = await readClaimed(fsp, file, stat, openFlags);
      result = await processRequest(context, text, { now: now(), logger });
      if (result.ok) onApplied?.(result.istek);
    } catch (error) {
      result = {
        ok: false,
        hata: error instanceof IstekHatasi ? error.message : hatalar.baglanti,
        yeniDeger: null,
      };
    }
    if (!(await removeEntry(fsp, file, stat))) stuck.add(id);
    await answer(id, result);
  }

  async function drainOnce() {
    for (;;) {
      if (stopped) return;
      const list = await pending();
      if (!list.length) return;
      for (const next of list) {
        if (stopped) return;
        const at = now();
        while (recent.length && at - recent[0] >= 1000) recent.shift();
        if (recent.length >= perSecond) {
          schedule(1000 - (at - recent[0]));
          return;
        }
        recent.push(at);
        await handle(next);
      }
    }
  }

  /** Handles everything waiting now; resolves when done (tests await it). */
  function drain() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await drainOnce();
      } while (again && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule(ms = 30) {
    if (scheduled || stopped) return;
    scheduled = timers.setTimeout(() => {
      scheduled = null;
      drain();
    }, ms);
    scheduled?.unref?.();
  }

  /**
   * Removes answers older than `answerTtlMs` (the app reads its answer within seconds) and requests the app took
   * back but could not remove (*.geri-alindi; never applied).
   */
  async function sweep() {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!WITHDRAWN_NAME.test(name)) continue;
      const file = join(dir, name);
      const stat = await fsp.lstat(file).catch(() => null);
      if (stat) await removeEntry(fsp, file, stat);
    }
    let names;
    try {
      names = await fsp.readdir(answersDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!REQUEST_NAME.test(name)) continue;
      const file = join(answersDir, name);
      const stat = await fsp.lstat(file).catch(() => null);
      if (stat && (stat.isSymbolicLink() || now() - stat.mtimeMs > answerTtlMs)) await removeEntry(fsp, file, stat);
    }
  }

  function watch() {
    try {
      watcher = fs.watch(dir, () => schedule());
      watcher.on?.('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch (error) {
      watcher = null;
      logger?.warn?.(konsol.izlenemiyor(error?.message ?? error));
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      for (const folder of [dir, answersDir]) {
        try {
          fs.mkdirSync(folder, { recursive: true });
        } catch {
          // polling still looks; the app reports it cannot write
        }
      }
      watch();
      poll = timers.setInterval(() => {
        if (!watcher) watch();
        schedule(0);
      }, pollMs);
      poll?.unref?.();
      sweeper = timers.setInterval(() => sweep(), 60_000);
      sweeper?.unref?.();
      sweep();
      schedule(0);
    },
    stop() {
      stopped = true;
      watcher?.close();
      watcher = null;
      timers.clearInterval(poll);
      timers.clearInterval(sweeper);
      if (scheduled) timers.clearTimeout(scheduled);
      scheduled = null;
    },
    drain,
    sweep,
  };
}
