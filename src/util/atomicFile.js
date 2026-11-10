// Dosyaları yarım kalmadan yazar: önce geçici dosyaya, sonra adını değiştirerek.
// Normalde bu dosyaya dokunmana gerek yok.

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';

// Windows: an antivirus or an editor holding the file open makes rename fail for a moment.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [25, 50, 100, 200];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `data` as JSON to a temporary file and renames it over `file`, so a crash or power
 * cut never leaves a half-written file. Retries briefly on EPERM/EBUSY/EACCES; throws when
 * the file still cannot be written. `fs` can be replaced in tests.
 */
export function writeJsonAtomic(file, data, { fs = nodeFs } = {}) {
  // Unique per process and call: two writers (or a crashed earlier run) never share a temp file.
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.yaziliyor`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.mkdirSync(dirname(file), { recursive: true });
      fs.writeFileSync(temp, text, 'utf8');
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt >= RETRY_DELAYS_MS.length) {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          // nothing to clean up
        }
        throw error;
      }
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Reads a JSON object. A missing file gives `fallback`; an unreadable or invalid one is
 * renamed to "<file>.bozuk-<time>" (kept for inspection) and `fallback` is returned.
 * @returns {{ data: object, backup: string|null, error: Error|null }}
 */
export function readJsonOrBackup(file, fallback, { fs = nodeFs, now = Date.now } = {}) {
  if (!fs.existsSync(file)) return { data: fallback, backup: null, error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return { data: parsed, backup: null, error: null };
    throw new Error('beklenen bir JSON nesnesi değil');
  } catch (error) {
    const backup = `${file}.bozuk-${now()}`;
    try {
      fs.renameSync(file, backup);
    } catch {
      return { data: fallback, backup: null, error };
    }
    return { data: fallback, backup, error };
  }
}
