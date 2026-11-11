// Rol panelleri, oyun rolleri ve açık takım arama ilanları data/roller-ve-ara.json dosyasında.
// Rol panelinde kanal/mesaj/rol kimlikleri, başlık ve her rolü panele koyan yöneticinin kimliği; oyun rolünde oyun adı ve rol kimliği; ilanda ilanı açanın
// ve katılanların Discord kimlikleri tutulur. İlan kapanınca kaydı silinir. Yazım geçici dosya + ad değiştirme
// ile yapılır; yazılamazsa bellekteki kayıt değişmez. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { cevaplar } from './mesajlar.js';

export const ROLES_SCHEMA_VERSION = 1;
export const PANEL_ID = /^[a-f0-9]{8}$/;
export const ILAN_ID = /^[a-f0-9]{10}$/;
export const PANEL_ROL_EN_FAZLA = 25;
export const KISI_EN_AZ = 2;
export const KISI_EN_FAZLA = 16;
const SNOWFLAKE = /^\d{17,20}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const ids = (value) => (Array.isArray(value) ? [...new Set(value.filter((v) => SNOWFLAKE.test(String(v))))] : []);

function sanitizePanel(raw) {
  if (!isPlainObject(raw) || !PANEL_ID.test(String(raw.id))) return null;
  if (!SNOWFLAKE.test(String(raw.guildId)) || !SNOWFLAKE.test(String(raw.kanalId))) return null;
  const roller = (Array.isArray(raw.roller) ? raw.roller : [])
    .filter((r) => isPlainObject(r) && SNOWFLAKE.test(String(r.id)))
    .map((r) => ({
      id: r.id,
      ad: text(r.ad, 80) || r.id,
      emoji: text(r.emoji, 64) || null,
      // Who put the role on the panel (checked on every click); null for panels made before it was stored.
      kim: SNOWFLAKE.test(String(r.kim)) ? r.kim : null,
    }))
    .filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i)
    .slice(0, PANEL_ROL_EN_FAZLA);
  return {
    id: raw.id,
    guildId: raw.guildId,
    kanalId: raw.kanalId,
    mesajId: SNOWFLAKE.test(String(raw.mesajId)) ? raw.mesajId : null,
    baslik: text(raw.baslik, 100) || '?',
    stil: raw.stil === 'menu' ? 'menu' : 'dugme',
    coklu: raw.coklu !== false,
    roller,
  };
}

function sanitizeIlan(raw) {
  if (!isPlainObject(raw) || !ILAN_ID.test(String(raw.id))) return null;
  if (!SNOWFLAKE.test(String(raw.guildId)) || !SNOWFLAKE.test(String(raw.kanalId))) return null;
  if (!SNOWFLAKE.test(String(raw.sahipId)) || !Number.isFinite(raw.bitis)) return null;
  const kisi = Number.isInteger(raw.kisi) ? Math.min(Math.max(raw.kisi, KISI_EN_AZ), KISI_EN_FAZLA) : KISI_EN_AZ;
  return {
    id: raw.id,
    guildId: raw.guildId,
    kanalId: raw.kanalId,
    mesajId: SNOWFLAKE.test(String(raw.mesajId)) ? raw.mesajId : null,
    sahipId: raw.sahipId,
    oyun: text(raw.oyun, 50) || '?',
    kisi,
    not: text(raw.not, 200) || null,
    rolId: SNOWFLAKE.test(String(raw.rolId)) ? raw.rolId : null,
    katilanlar: ids(raw.katilanlar).slice(0, kisi),
    olusma: Number.isFinite(raw.olusma) ? raw.olusma : raw.bitis,
    bitis: raw.bitis,
    durum: ['acik', 'dolu', 'kapandi'].includes(raw.durum) ? raw.durum : 'acik',
  };
}

function sanitizeGames(raw) {
  const games = Object.create(null);
  for (const [key, entry] of Object.entries(isPlainObject(raw) ? raw : {})) {
    if (!/^[\p{L}\p{N} .:+'-]{1,50}$/u.test(key) || !isPlainObject(entry)) continue;
    if (!SNOWFLAKE.test(String(entry.rolId))) continue;
    games[key] = { ad: text(entry.ad, 50) || key, rolId: entry.rolId };
  }
  return games;
}

/**
 * @param {object} deps
 * @param {string} deps.file data/roller-ve-ara.json
 */
export function createRolesStore({ file, logger, fs = nodeFs }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error) logger?.warn(`Rol dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  const readOnly = Number(data.schemaVersion ?? 1) > ROLES_SCHEMA_VERSION;
  if (readOnly) logger?.warn('data/roller-ve-ara.json daha yeni bir bot sürümüne ait; dosyaya dokunulmuyor.');
  const source = readOnly ? {} : data;

  let state = { paneller: new Map(), ilanlar: new Map(), oyunRolleri: new Map() };
  for (const raw of Object.values(isPlainObject(source.paneller) ? source.paneller : {})) {
    const panel = sanitizePanel(raw);
    if (panel) state.paneller.set(panel.id, panel);
  }
  for (const raw of Object.values(isPlainObject(source.ilanlar) ? source.ilanlar : {})) {
    const entry = sanitizeIlan(raw);
    if (entry) state.ilanlar.set(entry.id, entry);
  }
  for (const [guildId, raw] of Object.entries(isPlainObject(source.oyunRolleri) ? source.oyunRolleri : {})) {
    if (SNOWFLAKE.test(guildId)) state.oyunRolleri.set(guildId, sanitizeGames(raw));
  }

  function write(next) {
    if (readOnly) throw new OzellikHatasi(cevaplar.yeniSurum);
    const out = { schemaVersion: ROLES_SCHEMA_VERSION, paneller: {}, ilanlar: {}, oyunRolleri: {} };
    for (const [id, panel] of next.paneller) out.paneller[id] = panel;
    for (const [id, entry] of next.ilanlar) out.ilanlar[id] = entry;
    for (const [guildId, games] of next.oyunRolleri) if (Object.keys(games).length) out.oyunRolleri[guildId] = games;
    try {
      writeJsonAtomic(file, out, { fs });
    } catch (writeError) {
      logger?.warn('Rol dosyası yazılamadı:', writeError?.message ?? writeError);
      throw new OzellikHatasi(cevaplar.kaydedilemedi);
    }
    state = next;
  }

  /** Writes a copy of the state where one map changed. */
  function change(key, edit) {
    const map = new Map(state[key]);
    edit(map);
    write({ ...state, [key]: map });
  }

  return {
    saltOkunur: readOnly,

    panel(id) {
      const panel = state.paneller.get(id);
      return panel ? structuredClone(panel) : null;
    },
    panelsOf(guildId) {
      return [...state.paneller.values()].filter((p) => p.guildId === guildId).map((p) => structuredClone(p));
    },
    /** Stores a panel (new or changed); null removes it. @returns {object|null} the stored copy */
    setPanel(id, panel) {
      const clean = panel ? sanitizePanel({ ...panel, id }) : null;
      if (panel && !clean) throw new Error('Geçersiz panel');
      change('paneller', (map) => (clean ? map.set(id, clean) : map.delete(id)));
      return clean ? structuredClone(clean) : null;
    },

    ilan(id) {
      const entry = state.ilanlar.get(id);
      return entry ? structuredClone(entry) : null;
    },
    ilanlar() {
      return [...state.ilanlar.values()].map((entry) => structuredClone(entry));
    },
    /** Changes a posting in one synchronous step (`edit` gets a copy); null when there is none. */
    updateIlan(id, edit) {
      const current = state.ilanlar.get(id);
      if (!current) return null;
      const copy = structuredClone(current);
      edit(copy);
      const clean = sanitizeIlan({ ...copy, id });
      change('ilanlar', (map) => map.set(id, clean));
      return structuredClone(clean);
    },
    setIlan(id, entry) {
      const clean = entry ? sanitizeIlan({ ...entry, id }) : null;
      if (entry && !clean) throw new Error('Geçersiz ilan');
      if (!entry && !state.ilanlar.has(id)) return null;
      change('ilanlar', (map) => (clean ? map.set(id, clean) : map.delete(id)));
      return clean ? structuredClone(clean) : null;
    },

    /** { key: { ad, rolId } } of a guild. */
    gameRoles(guildId) {
      return { ...(state.oyunRolleri.get(guildId) ?? {}) };
    },
    setGameRole(guildId, key, entry) {
      const games = Object.assign(Object.create(null), state.oyunRolleri.get(guildId));
      if (entry) games[key] = { ad: entry.ad, rolId: entry.rolId };
      else delete games[key];
      change('oyunRolleri', (map) => map.set(guildId, sanitizeGames(games)));
    },
  };
}
