// Sunucu başına kalıcı ayarlar (şimdilik yalnızca DJ rolü), data/sunucular.json dosyasında.
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
 * Small JSON store: { "<guildId>": { "djRoleId": "<roleId>", ...other fields } }.
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

  return {
    /** The DJ role id of a guild, or null when none is set. */
    getDjRole(guildId) {
      const roleId = data[guildId]?.djRoleId;
      return typeof roleId === 'string' && SNOWFLAKE.test(roleId) ? roleId : null;
    },

    /**
     * Sets (roleId) or clears (null) the DJ role. Other fields of the guild stay untouched.
     * Throws SettingsSaveError when the file cannot be written; nothing changes then.
     */
    setDjRole(guildId, roleId) {
      const entry = { ...data[guildId] };
      if (roleId) entry.djRoleId = roleId;
      else delete entry.djRoleId;
      const next = { ...data, [guildId]: entry };
      if (Object.keys(entry).length === 0) delete next[guildId];
      write(next);
      data = next;
    },
  };
}
