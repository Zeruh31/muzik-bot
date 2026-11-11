// Sunucu başına kayıtlı çalma listeleri (/liste), data/listeler.json dosyasında.
// Her şarkı için yalnız Lavalink'in yeniden yükleyebileceği bilgi tutulur: adres, başlık, süre
// (Spotify gibi eşlenen kaynaklarda bir de çalınan YouTube videosunun adresi). Silme yetkisi
// için listeyi oluşturanın Discord kimliği saklanır. Sınırlar aşağıda (LIMITS).
// Yazım geçici dosya + ad değiştirme ile yapılır; yazılamazsa bellekteki listeler değişmez.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { komutlar } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';
import { readJsonOrBackup, writeJsonAtomic } from '../util/atomicFile.js';
import { escapeMarkdown } from '../util/format.js';

const M = komutlar.liste;

export const LIMITS = Object.freeze({ tracksPerList: 500, listsPerGuild: 50, nameLength: 32 });

const SNOWFLAKE = /^\d{17,20}$/;
// Letters and digits of any language, spaces, "-" and "_".
const NAME_PATTERN = /^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Names that would clash with JavaScript object internals ("__proto__", "constructor", ...).
const RESERVED_NAMES = new Set(
  ['__proto__', ...Object.getOwnPropertyNames(Object.prototype)].map((n) => n.toLowerCase()),
);
/** A prototype-free copy: user-chosen keys can never reach Object.prototype. */
const dict = (source) => Object.assign(Object.create(null), source);
/** object[key] only when it is the object's own property. */
const own = (object, key) => (object && Object.hasOwn(object, key) ? object[key] : undefined);
const httpUri = (value) =>
  typeof value === 'string' && value.length <= 500 && /^https?:\/\/[^\s]+$/i.test(value) ? value : null;

/**
 * Validates a list name typed by a user. Spaces are collapsed; the key ignores case (Turkish
 * rules), so "Yolculuk" and "yolculuk" are the same list.
 * @returns {{ name: string, key: string }}
 */
export function normalizeName(raw) {
  const name = String(raw ?? '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ');
  const key = name.toLocaleLowerCase('tr');
  if (!name || name.length > LIMITS.nameLength || !NAME_PATTERN.test(name)) {
    throw new MusicError(ErrorCodes.INVALID_VALUE, M.adGecersiz(LIMITS.nameLength));
  }
  if (RESERVED_NAMES.has(key)) throw new MusicError(ErrorCodes.INVALID_VALUE, M.adAyrilmis(escapeMarkdown(name)));
  return { name, key };
}

/**
 * The stored form of a track: { uri, title, duration } plus `sourceUri` (the YouTube video
 * really played) for mirrored sources such as Spotify. Accepts a MusicService track view.
 * @returns {object|null} null for tracks without a loadable http(s) address
 */
export function savedEntry(view) {
  if (!isPlainObject(view)) return null;
  const uri = httpUri(view.uri);
  if (!uri) return null;
  const entry = {
    uri,
    title: String(view.title ?? '').slice(0, 200) || uri,
    duration: Number.isSafeInteger(view.duration) && view.duration > 0 ? view.duration : 0,
  };
  const sourceUri = httpUri(view.sourceUri ?? view.mirror?.uri);
  if (sourceUri && sourceUri !== uri) entry.sourceUri = sourceUri;
  return entry;
}

function sanitizeList(raw) {
  if (!isPlainObject(raw) || typeof raw.name !== 'string' || !SNOWFLAKE.test(String(raw.ownerId))) return null;
  let name;
  try {
    name = normalizeName(raw.name);
  } catch {
    return null;
  }
  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).map(savedEntry).filter(Boolean);
  return {
    key: name.key,
    list: {
      name: name.name,
      ownerId: String(raw.ownerId),
      createdAt: Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0,
      updatedAt: Number.isSafeInteger(raw.updatedAt) ? raw.updatedAt : 0,
      tracks: tracks.slice(0, LIMITS.tracksPerList),
    },
  };
}

function sanitize(raw) {
  const out = Object.create(null);
  for (const [guildId, lists] of Object.entries(isPlainObject(raw?.guilds) ? raw.guilds : {})) {
    if (!SNOWFLAKE.test(guildId) || !isPlainObject(lists)) continue;
    const clean = Object.create(null);
    for (const value of Object.values(lists)) {
      const item = sanitizeList(value);
      if (item && Object.keys(clean).length < LIMITS.listsPerGuild) clean[item.key] = item.list;
    }
    if (Object.keys(clean).length) out[guildId] = clean;
  }
  return out;
}

const copyList = (list) => ({ ...list, tracks: list.tracks.map((t) => ({ ...t })) });

/**
 * { guilds: { "<guildId>": { "<key>": { name, ownerId, createdAt, updatedAt, tracks[] } } } }.
 * Every change is written right away (atomic). Methods throw MusicError with a Turkish message
 * (invalid name, limits, not found, not allowed, SAVE_FAILED when the file cannot be written).
 */
export function createPlaylistStore({ file, logger, fs = nodeFs, now = Date.now }) {
  const loaded = readJsonOrBackup(file, null, { fs });
  if (loaded.error) {
    logger?.warn(
      `Çalma listeleri okunamadı (${loaded.error.message}); boş başlıyor.${loaded.backup ? ` Eski dosya: ${loaded.backup}` : ''}`,
    );
  }
  let guilds = sanitize(loaded.data);

  function commit(guildId, lists) {
    const next = dict(guilds);
    next[guildId] = lists;
    if (Object.keys(lists).length === 0) delete next[guildId];
    try {
      writeJsonAtomic(file, { schemaVersion: 1, guilds: next }, { fs });
    } catch (error) {
      logger?.warn('Çalma listeleri kaydedilemedi:', error?.message ?? error);
      throw new MusicError(ErrorCodes.SAVE_FAILED, M.kaydedilemedi);
    }
    guilds = next;
  }

  function findList(guildId, rawName) {
    const { name, key } = normalizeName(rawName);
    const list = own(own(guilds, guildId), key);
    if (!list) throw new MusicError(ErrorCodes.NOT_FOUND, M.yok(escapeMarkdown(name)));
    return { key, list };
  }

  return {
    /** Summaries of a guild's lists, sorted by name. */
    list(guildId) {
      return Object.values(own(guilds, guildId) ?? {})
        .map(({ name, ownerId, tracks, createdAt, updatedAt }) => ({
          name,
          ownerId,
          count: tracks.length,
          duration: tracks.reduce((sum, t) => sum + t.duration, 0),
          createdAt,
          updatedAt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    },

    /** A copy of one list. Throws NOT_FOUND. */
    get(guildId, rawName) {
      return copyList(findList(guildId, rawName).list);
    },

    /** Up to 25 list names for autocomplete, those starting with `typed` first. */
    suggest(guildId, typed = '') {
      const needle = String(typed).trim().toLocaleLowerCase('tr');
      const names = Object.values(own(guilds, guildId) ?? {}).map((l) => l.name);
      const starts = names.filter((n) => n.toLocaleLowerCase('tr').startsWith(needle));
      const contains = names.filter((n) => !starts.includes(n) && n.toLocaleLowerCase('tr').includes(needle));
      const byName = (a, b) => a.localeCompare(b, 'tr');
      return [...starts.sort(byName), ...contains.sort(byName)].slice(0, 25);
    },

    /**
     * Creates a new list from track views. Tracks past the limit are left out.
     * @returns {{ name: string, saved: number, dropped: number }}
     */
    create(guildId, rawName, ownerId, views) {
      const { name, key } = normalizeName(rawName);
      const lists = dict(own(guilds, guildId));
      if (own(lists, key)) throw new MusicError(ErrorCodes.INVALID_VALUE, M.zatenVar(escapeMarkdown(lists[key].name)));
      if (Object.keys(lists).length >= LIMITS.listsPerGuild) {
        throw new MusicError(ErrorCodes.QUEUE_FULL, M.cokFazlaListe(LIMITS.listsPerGuild));
      }
      const entries = views.map(savedEntry).filter(Boolean);
      if (!entries.length) throw new MusicError(ErrorCodes.EMPTY_QUEUE, M.kaydedilecekYok);
      const tracks = entries.slice(0, LIMITS.tracksPerList);
      const at = now();
      lists[key] = { name, ownerId: String(ownerId), createdAt: at, updatedAt: at, tracks };
      commit(guildId, lists);
      return { name, saved: tracks.length, dropped: entries.length - tracks.length };
    },

    /**
     * Adds one track view to a list; the list is created (owned by `ownerId`) when missing.
     * @returns {{ name: string, count: number, created: boolean }}
     */
    append(guildId, rawName, ownerId, view) {
      const { name, key } = normalizeName(rawName);
      const entry = savedEntry(view);
      if (!entry) throw new MusicError(ErrorCodes.EMPTY_QUEUE, M.kaydedilecekYok);
      const lists = dict(own(guilds, guildId));
      const existing = own(lists, key);
      if (!existing) {
        if (Object.keys(lists).length >= LIMITS.listsPerGuild) {
          throw new MusicError(ErrorCodes.QUEUE_FULL, M.cokFazlaListe(LIMITS.listsPerGuild));
        }
        const at = now();
        lists[key] = { name, ownerId: String(ownerId), createdAt: at, updatedAt: at, tracks: [entry] };
        commit(guildId, lists);
        return { name, count: 1, created: true };
      }
      if (existing.tracks.some((t) => t.uri === entry.uri)) {
        throw new MusicError(
          ErrorCodes.INVALID_VALUE,
          M.zatenListede(`"${escapeMarkdown(entry.title)}"`, escapeMarkdown(existing.name)),
        );
      }
      if (existing.tracks.length >= LIMITS.tracksPerList) {
        throw new MusicError(ErrorCodes.QUEUE_FULL, M.listeDolu(escapeMarkdown(existing.name), LIMITS.tracksPerList));
      }
      lists[key] = { ...existing, updatedAt: now(), tracks: [...existing.tracks, entry] };
      commit(guildId, lists);
      return { name: existing.name, count: existing.tracks.length + 1, created: false };
    },

    /** Deletes a list: only its owner or someone with "Manage Server". Returns its name. */
    remove(guildId, rawName, { userId, canManageGuild = false }) {
      const { key, list } = findList(guildId, rawName);
      if (!canManageGuild && list.ownerId !== String(userId)) {
        throw new MusicError(ErrorCodes.MISSING_PERMISSIONS, M.silmeYetkisiYok);
      }
      const lists = dict(own(guilds, guildId));
      delete lists[key];
      commit(guildId, lists);
      return list.name;
    },
  };
}
