// Özellik ayarları, sunucu başına, data/ozellikler.json dosyasında (müzik ayarları data/sunucular.json'da kalır).
// Yazım geçici dosya + ad değiştirme ile yapılır; yazılamazsa bellekteki ayarlar değişmez. Bozuk dosya
// "*.bozuk-<zaman>" adıyla saklanır ve boş ayarlarla devam edilir. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';
import { ACTION_PATTERN, NAME_PATTERN, isReserved, own } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { cevaplar } from './mesajlar.js';
import { isStoredValueValid, SNOWFLAKE } from './sema.js';

export const SETTINGS_SCHEMA_VERSION = 1;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const KEY_PATTERN = /^[a-z][a-z0-9-]{1,19}\.[a-z][a-z0-9-]{0,31}$/;
/**
 * Per guild, who set each role setting ("modul.anahtar" -> user id). A role handed out by a feature is
 * checked against that person again when it is given (src/ozellikler/_roller.js).
 */
const SETTER_FIELD = '_kim';

/** Thrown when data/ozellikler.json cannot be written; nothing changed then. */
export class AyarKaydedilemedi extends OzellikHatasi {
  constructor(cause) {
    super(cevaplar.kaydedilemedi);
    this.name = 'AyarKaydedilemedi';
    this.cause = cause;
  }
}

/** "modul.anahtar", only for names that can never reach Object.prototype. */
export function settingKey(modul, anahtar) {
  if (!NAME_PATTERN.test(modul) || !ACTION_PATTERN.test(anahtar) || isReserved(modul) || isReserved(anahtar)) {
    throw new Error(`Geçersiz ayar adı: ${modul}.${anahtar}`);
  }
  return `${modul}.${anahtar}`;
}

/** Brings an older file up to the current schema (version 1 is the first; files without a version count as 1). */
export function migrate(raw) {
  const version = Number(raw?.schemaVersion ?? 1);
  const guilds = isPlainObject(raw?.sunucular) ? raw.sunucular : {};
  return { version, guilds };
}

/**
 * @param {object} deps
 * @param {string} deps.file data/ozellikler.json
 * @param {Map<string, object>} deps.schemas module name -> its `ayarlar` schema
 */
export function createFeatureSettings({ file, schemas, logger, fs = nodeFs }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error)
    logger?.warn(
      `Özellik ayarları okunamadı (${error.message}); boş ayarlarla devam ediliyor. Eski dosya: ${backup ?? '-'}`,
    );
  const { version, guilds: rawGuilds } = migrate(data);
  // A file from a newer bot version is never written back in an older format: it stays untouched,
  // every setting uses its default and /ayar refuses changes until the bot is updated.
  const readOnly = version > SETTINGS_SCHEMA_VERSION;
  if (readOnly) logger?.warn(cevaplar.yeniSurumKonsol(version));

  /** guildId -> prototype-free { "modul.anahtar": value } */
  let guilds = Object.create(null);
  for (const [guildId, entry] of Object.entries(readOnly ? {} : rawGuilds)) {
    if (!SNOWFLAKE.test(guildId) || !isPlainObject(entry)) continue;
    // Unknown keys (a removed or switched-off module) are kept as they are.
    const clean = Object.create(null);
    for (const [key, value] of Object.entries(entry)) {
      if (KEY_PATTERN.test(key) && !isReserved(key.split('.')[1])) clean[key] = value;
    }
    if (isPlainObject(entry[SETTER_FIELD])) {
      const setters = Object.create(null);
      for (const [key, userId] of Object.entries(entry[SETTER_FIELD])) {
        if (KEY_PATTERN.test(key) && typeof userId === 'string' && SNOWFLAKE.test(userId)) setters[key] = userId;
      }
      if (Object.keys(setters).length) clean[SETTER_FIELD] = setters;
    }
    guilds[guildId] = clean;
  }

  function fieldOf(modul, anahtar) {
    return own(schemas.get(modul), anahtar);
  }

  function write(next) {
    if (readOnly) throw new OzellikHatasi(cevaplar.yeniSurum);
    try {
      writeJsonAtomic(file, { schemaVersion: SETTINGS_SCHEMA_VERSION, sunucular: next }, { fs });
    } catch (writeError) {
      logger?.warn('Özellik ayarları kaydedilemedi:', writeError?.message ?? writeError);
      throw new AyarKaydedilemedi(writeError);
    }
  }

  return {
    /** Whether data/ozellikler.json belongs to a newer bot version (defaults only, no changes). */
    saltOkunur: readOnly,

    /** The stored value, or the field's default when unset or no longer valid. */
    get(guildId, modul, anahtar) {
      const alan = fieldOf(modul, anahtar);
      if (!alan) throw new Error(`Bilinmeyen ayar: ${modul}.${anahtar}`);
      const value = own(own(guilds, guildId), settingKey(modul, anahtar));
      return value !== undefined && isStoredValueValid(alan, value) ? value : (alan.varsayilan ?? null);
    },

    /** Whether the guild has its own value (not the default). */
    isSet(guildId, modul, anahtar) {
      const alan = fieldOf(modul, anahtar);
      const value = own(own(guilds, guildId), settingKey(modul, anahtar));
      return Boolean(alan) && value !== undefined && isStoredValueValid(alan, value);
    },

    /** Who set a setting (a user id), when it was recorded; null otherwise. */
    setBy(guildId, modul, anahtar) {
      return own(own(own(guilds, guildId), SETTER_FIELD), settingKey(modul, anahtar)) ?? null;
    },

    /**
     * Stores an already validated value; null removes it (back to the default). `kim` records who set it.
     * Throws AyarKaydedilemedi when the file cannot be written; memory stays unchanged then.
     */
    set(guildId, modul, anahtar, value, { kim = null } = {}) {
      const alan = fieldOf(modul, anahtar);
      if (!SNOWFLAKE.test(String(guildId))) throw new Error('Geçersiz sunucu kimliği');
      if (!alan) throw new Error(`Bilinmeyen ayar: ${modul}.${anahtar}`);
      if (value !== null && !isStoredValueValid(alan, value)) throw new Error(`Geçersiz değer: ${modul}.${anahtar}`);
      const key = settingKey(modul, anahtar);
      const entry = Object.assign(Object.create(null), own(guilds, guildId));
      const setters = Object.assign(Object.create(null), own(entry, SETTER_FIELD));
      if (value === null) delete entry[key];
      else entry[key] = value;
      if (value !== null && typeof kim === 'string' && SNOWFLAKE.test(kim)) setters[key] = kim;
      else delete setters[key];
      if (Object.keys(setters).length) entry[SETTER_FIELD] = setters;
      else delete entry[SETTER_FIELD];
      const next = Object.assign(Object.create(null), guilds);
      if (Object.keys(entry).length) next[guildId] = entry;
      else delete next[guildId];
      write(next);
      guilds = next;
    },
  };
}
