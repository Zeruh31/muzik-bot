// Üyelik kuralları (Membership Screening) ekranında bekleyenler data/karsilama-bekleyen.json dosyasında:
// sunucu, kullanıcı kimliği ve katılma zamanı. Otomatik rol YALNIZ bu listedekilere, kuralları kabul edince
// verilir; verilince kişi listeden çıkar. 7 günden eski kayıtlar, ayrılanlar ve rolünü alanlar silinir.
// Bot kapalıyken kabul edenler açılışta rolünü alır. Yazım geçici dosya + ad değiştirme iledir.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';

export const PENDING_SCHEMA_VERSION = 1;
/** Someone who has not passed screening within this long is forgotten (no role later). */
export const PENDING_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING = 10_000;
const SNOWFLAKE = /^\d{17,20}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keyOf = (guildId, userId) => `${guildId}:${userId}`;

/**
 * @param {object} deps
 * @param {string} deps.file data/karsilama-bekleyen.json
 * @param {() => number} deps.now
 */
export function createPendingStore({ file, now, logger, fs = nodeFs }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error)
    logger?.warn?.(`Bekleyen üyeler dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  const readOnly = Number(data.schemaVersion ?? 1) > PENDING_SCHEMA_VERSION;
  /** "guild:user" -> joined at (ms) */
  const entries = new Map();
  for (const [key, at] of Object.entries(!readOnly && isPlainObject(data.bekleyenler) ? data.bekleyenler : {})) {
    const [guildId, userId] = key.split(':');
    if (SNOWFLAKE.test(guildId ?? '') && SNOWFLAKE.test(userId ?? '') && Number.isFinite(at)) entries.set(key, at);
  }

  function write() {
    if (readOnly) return;
    const bekleyenler = Object.create(null);
    for (const [key, at] of entries) bekleyenler[key] = at;
    try {
      writeJsonAtomic(file, { schemaVersion: PENDING_SCHEMA_VERSION, bekleyenler }, { fs });
    } catch (writeError) {
      logger?.warn?.('Bekleyen üyeler dosyası yazılamadı:', writeError?.message ?? writeError);
    }
  }

  function sweep() {
    let changed = false;
    for (const [key, at] of entries) {
      if (now() - at > PENDING_KEEP_MS) {
        entries.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  return {
    /** Remembers someone waiting for screening (joinedAt: when they joined). */
    ekle(guildId, userId, joinedAt = now()) {
      if (!SNOWFLAKE.test(String(guildId)) || !SNOWFLAKE.test(String(userId))) return;
      sweep();
      if (entries.size >= MAX_PENDING) entries.delete(entries.keys().next().value);
      entries.set(keyOf(guildId, userId), Number.isFinite(joinedAt) ? joinedAt : now());
      write();
    },
    /** Whether they are on the list (and not too old). */
    var(guildId, userId) {
      const at = entries.get(keyOf(guildId, userId));
      return at !== undefined && now() - at <= PENDING_KEEP_MS;
    },
    /** Takes them off the list; true when they were on it (and not too old). Taking is the "give once" step. */
    al(guildId, userId) {
      const key = keyOf(guildId, userId);
      const at = entries.get(key);
      if (at === undefined) return false;
      entries.delete(key);
      write();
      return now() - at <= PENDING_KEEP_MS;
    },
    /** [{ guildId, userId }] still waiting (old ones are dropped first). */
    hepsi() {
      if (sweep()) write();
      return [...entries.keys()].map((key) => {
        const [guildId, userId] = key.split(':');
        return { guildId, userId };
      });
    },
  };
}
