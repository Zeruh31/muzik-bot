// Sesli komutta kendini hariç tutanlar, sunucu başına, data/sesli-komut.json dosyasında (yalnız Discord kimlikleri;
// ses ya da metin hiç yazılmaz). Yazım geçici dosya + ad değiştirme ile; yazılamazsa bellekteki liste değişmez.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { cevaplar } from './mesajlar.js';

export const EXCLUSION_SCHEMA_VERSION = 1;
const SNOWFLAKE = /^\d{17,20}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** @param {{ file: string }} deps data/sesli-komut.json */
export function createExclusionStore({ file, logger, fs = nodeFs }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error)
    logger?.warn(`Sesli komut dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  const readOnly = Number(data.schemaVersion ?? 1) > EXCLUSION_SCHEMA_VERSION;
  if (readOnly) logger?.warn('data/sesli-komut.json daha yeni bir bot sürümüne ait; dosyaya dokunulmuyor.');

  /** guildId -> Set(userId) */
  let excluded = new Map();
  for (const [guildId, ids] of Object.entries(isPlainObject(data.haric) ? data.haric : {})) {
    if (!SNOWFLAKE.test(guildId) || !Array.isArray(ids)) continue;
    const set = new Set(ids.filter((id) => typeof id === 'string' && SNOWFLAKE.test(id)));
    if (set.size) excluded.set(guildId, set);
  }

  function write(next) {
    if (readOnly) throw new OzellikHatasi(cevaplar.yeniSurum);
    const haric = Object.create(null);
    for (const [guildId, set] of next) if (set.size) haric[guildId] = [...set].sort();
    try {
      writeJsonAtomic(file, { schemaVersion: EXCLUSION_SCHEMA_VERSION, haric }, { fs });
    } catch (writeError) {
      logger?.warn('Sesli komut dosyası yazılamadı:', writeError?.message ?? writeError);
      throw new OzellikHatasi(cevaplar.kaydedilemedi);
    }
    excluded = next;
  }

  return {
    has: (guildId, userId) => excluded.get(guildId)?.has(userId) ?? false,
    /** Sets whether a person is excluded; returns false when nothing changed. Throws when it cannot be saved. */
    set(guildId, userId, value) {
      if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(userId)) throw new Error('Geçersiz kimlik');
      if ((excluded.get(guildId)?.has(userId) ?? false) === value) return false;
      const next = new Map([...excluded].map(([g, set]) => [g, new Set(set)]));
      const set = next.get(guildId) ?? new Set();
      if (value) set.add(userId);
      else set.delete(userId);
      next.set(guildId, set);
      write(next);
      return true;
    },
  };
}
