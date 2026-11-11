// Duyurulan ücretsiz oyunlar data/ucretsiz-oyunlar.json dosyasında: sunucu başına oyun anahtarı ve duyuru
// zamanı (kaynaklar.js > oyunAnahtari). Aynı oyun bir sunucuda iki kez duyurulmaz. Kişisel veri yoktur.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';

export const FREE_GAMES_SCHEMA_VERSION = 1;
/** A key no source lists any more is forgotten after this long (so the game can be announced next time). */
export const UNUTMA_MS = 14 * 24 * 60 * 60 * 1000;
const SNOWFLAKE = /^\d{17,20}$/;
const KEY = /^[a-z]+:[\p{L}\p{N}-]{0,60}$/u;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createFreeGamesStore({ file, logger, fs = nodeFs }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error)
    logger?.warn(`Ücretsiz oyun dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  const readOnly = Number(data.schemaVersion ?? 1) > FREE_GAMES_SCHEMA_VERSION;
  if (readOnly) logger?.warn('data/ucretsiz-oyunlar.json daha yeni bir bot sürümüne ait; duyuru yapılmıyor.');

  /** guildId -> Map(key -> time) from one section of the file. */
  function section(raw) {
    const out = new Map();
    for (const [guildId, entry] of Object.entries(!readOnly && isPlainObject(raw) ? raw : {})) {
      if (!SNOWFLAKE.test(guildId) || !isPlainObject(entry)) continue;
      const keys = new Map(Object.entries(entry).filter(([key, at]) => KEY.test(key) && Number.isFinite(at)));
      if (keys.size) out.set(guildId, keys);
    }
    return out;
  }
  /** Announced games: guildId -> Map(key -> announced at) */
  const guilds = section(data.sunucular);
  /** Games Discord refused for good (e.g. a card it calls invalid): never tried again. */
  const failed = section(data.duyurulamayanlar);
  const plain = (map) => {
    const out = Object.create(null);
    for (const [guildId, keys] of map) out[guildId] = Object.fromEntries(keys);
    return out;
  };
  const mark = (map, guildId, key, at) => (map.get(guildId) ?? map.set(guildId, new Map()).get(guildId)).set(key, at);
  let lastCheck = Number.isFinite(data.sonKontrol) ? data.sonKontrol : null;

  /** Throws when the file cannot be written. */
  function save() {
    if (readOnly) throw new Error('data/ucretsiz-oyunlar.json daha yeni bir bot sürümüne ait');
    writeJsonAtomic(
      file,
      {
        schemaVersion: FREE_GAMES_SCHEMA_VERSION,
        sonKontrol: lastCheck,
        sunucular: plain(guilds),
        duyurulamayanlar: plain(failed),
      },
      { fs },
    );
  }

  return {
    saltOkunur: readOnly,
    get sonKontrol() {
      return lastCheck;
    },
    /** Whether the game was announced in the server, or refused by Discord for good. */
    duyuruldu: (guildId, key) => Boolean(guilds.get(guildId)?.has(key) || failed.get(guildId)?.has(key)),

    /** Remembers an announcement and saves at once (a crash right after sending repeats at most one card). */
    isaretle(guildId, key, at) {
      mark(guilds, guildId, key, at);
      save();
    },

    /** Remembers a game whose card Discord refused for good, so it does not block the others every check. */
    duyurulamadi(guildId, key, at) {
      mark(failed, guildId, key, at);
      save();
    },

    /** Forgets keys of `platform` that the source no longer lists and that are older than UNUTMA_MS. */
    unut(guildId, platform, currentKeys, now) {
      let removed = 0;
      for (const map of [guilds, failed]) {
        const keys = map.get(guildId);
        if (!keys) continue;
        for (const [key, at] of keys) {
          if (key.startsWith(`${platform}:`) && !currentKeys.has(key) && now - at > UNUTMA_MS) {
            keys.delete(key);
            removed += 1;
          }
        }
        if (!keys.size) map.delete(guildId);
      }
      return removed;
    },

    /** Saves the time of the check (and what unut() removed). */
    kontrolEdildi(now) {
      lastCheck = now;
      save();
    },
  };
}
