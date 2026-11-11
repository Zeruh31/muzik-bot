// Masaüstü uygulamasının okuduğu data/ dosyalarını yazar: atomik (geçici dosya + ad değiştirme), olaylar
// birkaç saniye toplanıp tek yazımla, içerik değişmediyse hiç yazmadan. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { basename } from 'node:path';
import { writeJsonAtomic } from '../../util/atomicFile.js';
import { konsol } from './mesajlar.js';

/**
 * @param {object} deps
 * @param {string} deps.file the data/ file
 * @param {() => object} deps.collect the whole object; its `guncellendi` field is left out of the comparison
 * @param {number} [deps.delayMs] how long poke() waits for more changes before writing
 */
export function createJsonFileWriter({ file, collect, logger, fs = nodeFs, timers = globalThis, delayMs = 3000 }) {
  let pending = null;
  let lastKey = null;
  let warned = false;

  function writeNow() {
    if (pending) timers.clearTimeout(pending);
    pending = null;
    try {
      const data = collect();
      const { guncellendi: _time, ...rest } = data;
      const key = JSON.stringify(rest);
      if (key === lastKey) return false;
      writeJsonAtomic(file, data, { fs });
      lastKey = key;
      warned = false;
      return true;
    } catch (error) {
      if (!warned) logger?.warn?.(konsol.yazilamadi(basename(file), error?.message ?? error));
      warned = true;
      return false;
    }
  }

  return {
    writeNow,
    /** Something changed: write once after `delayMs`, however many more changes come in the meantime. */
    poke() {
      if (pending) return;
      pending = timers.setTimeout(writeNow, delayMs);
      pending?.unref?.();
    },
    stop() {
      if (pending) timers.clearTimeout(pending);
      pending = null;
    },
  };
}
