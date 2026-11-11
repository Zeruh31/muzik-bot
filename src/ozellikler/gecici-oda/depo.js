// Botun açtığı geçici odalar data/gecici-odalar.json dosyasında: kanal kimliği, sunucu, kategori, sahibin
// Discord kimliği, açılış zamanı, kilit (ve kilitten önceki kanal izinleri) ve kontrol mesajı. Bot yalnız bu
// listedeki kanalları düzenler ve siler. Oda silinince kaydı da silinir. Yazım geçici dosya + ad değiştirme ile yapılır; yazılamazsa bellekteki
// kayıt değişmez. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { cevaplar } from './mesajlar.js';

export const ROOMS_SCHEMA_VERSION = 1;
const SNOWFLAKE = /^\d{17,20}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const BITS = /^\d{1,20}$/;

/** The overwrites a lock changed, as they were before it: id -> { tip, allow, deny } or null (there was none). */
function sanitizeSaved(raw) {
  const saved = Object.create(null);
  for (const [id, entry] of Object.entries(isPlainObject(raw) ? raw : {})) {
    if (!SNOWFLAKE.test(id)) continue;
    if (entry === null) saved[id] = null;
    else if (isPlainObject(entry) && [0, 1].includes(entry.tip) && BITS.test(entry.allow) && BITS.test(entry.deny))
      saved[id] = { tip: entry.tip, allow: entry.allow, deny: entry.deny };
  }
  return saved;
}

function sanitize(raw) {
  if (!isPlainObject(raw) || !SNOWFLAKE.test(String(raw.id)) || !SNOWFLAKE.test(String(raw.guildId))) return null;
  if (!SNOWFLAKE.test(String(raw.sahipId))) return null;
  return {
    id: raw.id,
    guildId: raw.guildId,
    sahipId: raw.sahipId,
    olusma: Number.isFinite(raw.olusma) ? raw.olusma : 0,
    kategoriId: SNOWFLAKE.test(String(raw.kategoriId)) ? raw.kategoriId : null,
    kilitli: raw.kilitli === true,
    kilitOncesi: raw.kilitli === true ? sanitizeSaved(raw.kilitOncesi) : {},
    kontrolMesajId: SNOWFLAKE.test(String(raw.kontrolMesajId)) ? raw.kontrolMesajId : null,
  };
}

/**
 * @param {object} deps
 * @param {string} deps.file data/gecici-odalar.json
 */
export function createRoomStore({ file, logger, fs = nodeFs }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error)
    logger?.warn(`Geçici oda dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  const readOnly = Number(data.schemaVersion ?? 1) > ROOMS_SCHEMA_VERSION;
  if (readOnly) logger?.warn('data/gecici-odalar.json daha yeni bir bot sürümüne ait; dosyaya dokunulmuyor.');

  /** channel id -> room */
  let rooms = new Map();
  for (const raw of Object.values(!readOnly && isPlainObject(data.odalar) ? data.odalar : {})) {
    const room = sanitize(raw);
    if (room) rooms.set(room.id, room);
  }

  function write(next) {
    if (readOnly) throw new OzellikHatasi(cevaplar.yeniSurum);
    const odalar = Object.create(null);
    for (const [id, room] of next) odalar[id] = room;
    try {
      writeJsonAtomic(file, { schemaVersion: ROOMS_SCHEMA_VERSION, odalar }, { fs });
    } catch (writeError) {
      logger?.warn('Geçici oda dosyası yazılamadı:', writeError?.message ?? writeError);
      throw new OzellikHatasi(cevaplar.kaydedilemedi);
    }
    rooms = next;
  }

  return {
    saltOkunur: readOnly,

    /** A copy of a room the bot opened, or null (also for every channel the bot did not open). */
    get(id) {
      const room = rooms.get(String(id));
      return room ? { ...room } : null;
    },

    all() {
      return [...rooms.values()].map((room) => ({ ...room }));
    },

    /** The room a person owns in a guild, or null. */
    ofOwner(guildId, userId) {
      const room = [...rooms.values()].find((r) => r.guildId === guildId && r.sahipId === userId);
      return room ? { ...room } : null;
    },

    /** Records a new room (throws when the file cannot be written; nothing changed then). */
    add(room) {
      const clean = sanitize(room);
      if (!clean || rooms.has(clean.id)) throw new Error('Geçersiz oda');
      write(new Map(rooms).set(clean.id, clean));
      return { ...clean };
    },

    /** Changes a room in one synchronous step; null when there is no such room. */
    update(id, change) {
      const current = rooms.get(id);
      if (!current) return null;
      const copy = { ...current };
      change(copy);
      const clean = sanitize({ ...copy, id: current.id, guildId: current.guildId });
      if (!clean) throw new Error('Geçersiz oda');
      write(new Map(rooms).set(id, clean));
      return { ...clean };
    },

    remove(id) {
      if (!rooms.has(id)) return false;
      const next = new Map(rooms);
      next.delete(id);
      write(next);
      return true;
    },
  };
}
