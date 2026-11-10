'use strict';

// Saving the settings form into .env safely:
//  - only keys the form knows, or keys already in .env / .env.example, are accepted
//  - the file is re-read right before writing; changes made outside the app since the form
//    was opened (e.g. scripts/youtube-token.js storing the token) are kept, and a key changed
//    both outside and in the form is reported as a conflict instead of silently overwritten
//  - the file is written to a temporary file and renamed over .env, so a crash or power cut
//    never leaves a half-written .env

const crypto = require('node:crypto');
const fs = require('node:fs');
const { parseEnv, envKeys, updateEnvText } = require('./envFile');
const { FIELDS, validateValues } = require('./envSchema');

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hashText(text) {
  return crypto
    .createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex');
}

/**
 * Works out what to write.
 * @param {{ currentText: string, exampleText?: string, changes: Record<string,string>, base?: Record<string,string> }} input
 *   `base` holds the values the form showed when it was opened.
 * @returns {{ ok: boolean, errors: object, conflicts: string[], changed: string[], nextText: string|null }}
 */
function planEnvSave({ currentText, exampleText = '', changes, base = {} }) {
  const allowed = new Set([...FIELDS.keys(), ...envKeys(currentText), ...envKeys(exampleText)]);
  const errors = {};
  const clean = {};
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (!KEY_PATTERN.test(key) || !allowed.has(key)) {
      errors[key] =
        'Bilinmeyen ayar anahtarı; yalnız formdaki ya da .env/.env.example dosyasındaki ayarlar kaydedilebilir.';
    } else if (typeof value !== 'string') {
      errors[key] = 'Geçersiz değer.';
    } else {
      clean[key] = value;
    }
  }
  Object.assign(errors, validateValues(clean));
  if (Object.keys(errors).length) return { ok: false, errors, conflicts: [], changed: [], nextText: null };

  const current = parseEnv(currentText);
  const changed = Object.keys(clean).filter((key) => (current[key] ?? '') !== clean[key]);
  const conflicts = changed.filter((key) => key in base && (current[key] ?? '') !== (base[key] ?? ''));
  if (!changed.length) return { ok: true, errors: {}, conflicts: [], changed: [], nextText: currentText };
  const nextText = updateEnvText(currentText, Object.fromEntries(changed.map((key) => [key, clean[key]])));
  return { ok: true, errors: {}, conflicts, changed, nextText };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Writes through a temporary file and renames it over the target. Windows reports
 * EPERM/EBUSY/EACCES while another program (an editor, antivirus) holds the file, so the
 * rename is retried; as a last resort the file is written in place.
 */
function writeFileAtomic(file, text, { fsImpl = fs, retries = 6, delayMs = 80 } = {}) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(temp, text, 'utf8');
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        fsImpl.renameSync(temp, file);
        return 'renamed';
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        if (attempt >= retries) break;
        sleepSync(delayMs * (attempt + 1));
      }
    }
    fsImpl.writeFileSync(file, text, 'utf8');
    return 'in-place';
  } finally {
    try {
      fsImpl.rmSync(temp, { force: true });
    } catch {
      // already renamed
    }
  }
}

module.exports = { planEnvSave, writeFileAtomic, hashText };
