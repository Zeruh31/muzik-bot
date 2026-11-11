// Sunucu başına kalıcı ayarlar (DJ rolü, otomatik çalma, şarkılar arası geçiş), data/sunucular.json dosyasında.
// Dosya bozulursa bot çökmez: bozuk dosyayı yedekleyip boş ayarlarla devam eder.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';

const SNOWFLAKE = /^\d{17,20}$/;
// Windows: an antivirus or an editor holding the file open makes rename fail for a moment.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [25, 50, 100, 200];

/** Thrown when the settings could not be written; the in-memory settings are left unchanged. */
export class SettingsSaveError extends Error {
  constructor(cause) {
    super(`data/sunucular.json yazılamadı: ${cause?.code ?? cause?.message ?? cause}`, { cause });
    this.name = 'SettingsSaveError';
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Small JSON store: { "<guildId>": { "djRoleId": "<roleId>", "autoplay": true, ...other fields } }.
 * Writes go to a temporary file that is then renamed, so a crash mid-write cannot leave a
 * half-written file. Memory is only updated after the file was written successfully.
 * `fs` can be replaced in tests.
 */
export function createServerSettings({ file, logger, fs = nodeFs }) {
  let data = load();

  function load() {
    if (!fs.existsSync(file)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      throw new Error('beklenen bir JSON nesnesi değil');
    } catch (error) {
      const backup = `${file}.bozuk-${Date.now()}`;
      try {
        fs.renameSync(file, backup);
      } catch {
        // could not back up; it is overwritten on the next save
      }
      logger?.warn(`Sunucu ayarları okunamadı (${error.message}); boş ayarlarla devam ediliyor. Eski dosya: ${backup}`);
      return {};
    }
  }

  function write(next) {
    const temp = `${file}.yaziliyor`;
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.mkdirSync(dirname(file), { recursive: true });
        fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        fs.renameSync(temp, file);
        return;
      } catch (error) {
        if (!RETRY_CODES.has(error?.code) || attempt >= RETRY_DELAYS_MS.length) {
          logger?.warn('Sunucu ayarları kaydedilemedi:', error?.message ?? error);
          throw new SettingsSaveError(error);
        }
        sleepSync(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /** A guild's own entry (never something inherited from Object.prototype). */
  function entryOf(guildId) {
    return Object.hasOwn(data, guildId) ? data[guildId] : undefined;
  }

  /** Sets (value) or removes (null/false) one field of a guild; memory changes only after the write. */
  function setField(guildId, key, value) {
    const entry = { ...entryOf(guildId) };
    if (value) entry[key] = value;
    else delete entry[key];
    const next = { ...data, [guildId]: entry };
    if (Object.keys(entry).length === 0) delete next[guildId];
    write(next);
    data = next;
  }

  return {
    /** The DJ role id of a guild, or null when none is set. */
    getDjRole(guildId) {
      const roleId = entryOf(guildId)?.djRoleId;
      return typeof roleId === 'string' && SNOWFLAKE.test(roleId) ? roleId : null;
    },

    /**
     * Sets (roleId) or clears (null) the DJ role. Other fields of the guild stay untouched.
     * Throws SettingsSaveError when the file cannot be written; nothing changes then.
     */
    setDjRole(guildId, roleId) {
      setField(guildId, 'djRoleId', roleId || null);
    },

    /** Whether /autoplay is on in a guild (off by default). */
    getAutoplay(guildId) {
      return entryOf(guildId)?.autoplay === true;
    },

    /** Turns /autoplay on or off. Throws SettingsSaveError like setDjRole. */
    setAutoplay(guildId, enabled) {
      setField(guildId, 'autoplay', enabled === true);
    },

    /** Crossfade seconds of a guild (0 = off, the default); MusicService validates the range. */
    getCrossfade(guildId) {
      const seconds = entryOf(guildId)?.crossfade;
      return Number.isInteger(seconds) && seconds > 0 && seconds <= 60 ? seconds : 0;
    },

    /** Sets the crossfade seconds (0 removes the field). Throws SettingsSaveError like setDjRole. */
    setCrossfade(guildId, seconds) {
      setField(guildId, 'crossfade', Number.isInteger(seconds) && seconds > 0 ? seconds : null);
    },
  };
}
