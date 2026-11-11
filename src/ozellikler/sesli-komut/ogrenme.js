// Anlaşılmayan sesli komutlar: YALNIZ tanı modunda (SESLI_KOMUT_TANI=true) data/sesli-komut-anlasilmayan.json
// dosyasına yazılır, yeni kalıp eklerken ne söylendiğini görmek için. Son 200 kayıt; yalnız metin ve zaman
// (kim söyledi, hangi sunucu yazılmaz). Görmek için: npm run sesli-komut:anlasilmayan
// Tanı modu kapalıyken bu dosyaya hiç yazılmaz.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../config.js';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';

export const UNKNOWN_FILE = join(PROJECT_ROOT, 'data', 'sesli-komut-anlasilmayan.json');
export const UNKNOWN_MAX = 200;

/** Reads the list (for the script and tests): [{ zaman, metin }], newest last. */
export function readUnknown(file = UNKNOWN_FILE, fs = nodeFs) {
  const { data } = readJsonOrBackup(file, {}, { fs });
  return Array.isArray(data.kayitlar)
    ? data.kayitlar.filter((k) => typeof k?.metin === 'string' && typeof k?.zaman === 'string')
    : [];
}

export function createUnknownLog({ file = UNKNOWN_FILE, fs = nodeFs, now = Date.now, logger } = {}) {
  let list = null;
  return {
    add(text) {
      const metin = String(text ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .trim()
        .slice(0, 300);
      if (!metin) return;
      list ??= readUnknown(file, fs);
      list.push({ zaman: new Date(now()).toISOString(), metin });
      if (list.length > UNKNOWN_MAX) list = list.slice(-UNKNOWN_MAX);
      try {
        writeJsonAtomic(file, { schemaVersion: 1, kayitlar: list }, { fs });
      } catch (error) {
        logger?.warn('Anlaşılmayan sesli komut dosyası yazılamadı:', error?.message ?? error);
      }
    },
  };
}
