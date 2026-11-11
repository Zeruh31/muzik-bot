// Çekilişler data/cekilisler.json dosyasında. Katılımcıların Discord kimlikleri yalnız çekiliş sürerken ve
// bittikten sonra SAKLAMA_MS boyunca ("Yeniden çek" için) tutulur; sonra çekilişin kaydı bütünüyle silinir.
// Yazım geçici dosya + ad değiştirme ile yapılır; yazılamazsa bellekteki kayıt değişmez.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { cevaplar } from './mesajlar.js';

export const GIVEAWAY_SCHEMA_VERSION = 1;
/** How long a finished giveaway (and its participant ids) is kept for "Yeniden çek". */
export const SAKLAMA_MS = 24 * 60 * 60 * 1000;
export const MAX_KATILIMCI = 10_000;
export const GIVEAWAY_ID = /^[a-f0-9]{10}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ids = (value) => (Array.isArray(value) ? [...new Set(value.filter((v) => SNOWFLAKE.test(String(v))))] : []);

function sanitize(raw) {
  if (!isPlainObject(raw) || !GIVEAWAY_ID.test(String(raw.id))) return null;
  if (!SNOWFLAKE.test(String(raw.guildId)) || !SNOWFLAKE.test(String(raw.kanalId))) return null;
  if (!Number.isFinite(raw.bitis) || typeof raw.odul !== 'string') return null;
  return {
    id: raw.id,
    guildId: raw.guildId,
    kanalId: raw.kanalId,
    mesajId: SNOWFLAKE.test(String(raw.mesajId)) ? raw.mesajId : null,
    sahipId: SNOWFLAKE.test(String(raw.sahipId)) ? raw.sahipId : null,
    odul: raw.odul.slice(0, 200),
    kazananSayisi: Number.isInteger(raw.kazananSayisi) && raw.kazananSayisi > 0 ? raw.kazananSayisi : 1,
    rolId: SNOWFLAKE.test(String(raw.rolId)) ? raw.rolId : null,
    olusma: Number.isFinite(raw.olusma) ? raw.olusma : raw.bitis,
    bitis: raw.bitis,
    durum: raw.durum === 'bitti' ? 'bitti' : 'acik',
    katilimcilar: ids(raw.katilimcilar).slice(0, MAX_KATILIMCI),
    kazananlar: ids(raw.kazananlar),
    cekilenler: ids(raw.cekilenler),
    bittiAt: Number.isFinite(raw.bittiAt) ? raw.bittiAt : null,
    duyuruldu: raw.duyuruldu === true,
  };
}

/**
 * @param {object} deps
 * @param {string} deps.file data/cekilisler.json
 * @param {() => number} [deps.now]
 */
export function createGiveawayStore({ file, now = () => Date.now(), logger, fs = nodeFs }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error) logger?.warn(`Çekiliş dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  const readOnly = Number(data.schemaVersion ?? 1) > GIVEAWAY_SCHEMA_VERSION;
  if (readOnly) logger?.warn('data/cekilisler.json daha yeni bir bot sürümüne ait; dosyaya dokunulmuyor.');

  /** id -> giveaway */
  let giveaways = new Map();
  for (const raw of Object.values(!readOnly && isPlainObject(data.cekilisler) ? data.cekilisler : {})) {
    const giveaway = sanitize(raw);
    if (giveaway) giveaways.set(giveaway.id, giveaway);
  }

  function write(next) {
    if (readOnly) throw new OzellikHatasi(cevaplar.yeniSurum);
    const cekilisler = Object.create(null);
    for (const [id, giveaway] of next) cekilisler[id] = giveaway;
    try {
      writeJsonAtomic(file, { schemaVersion: GIVEAWAY_SCHEMA_VERSION, cekilisler }, { fs });
    } catch (writeError) {
      logger?.warn('Çekiliş dosyası yazılamadı:', writeError?.message ?? writeError);
      throw new OzellikHatasi(cevaplar.kaydedilemedi);
    }
    giveaways = next;
  }

  const store = {
    saltOkunur: readOnly,

    /** A copy of a giveaway, or null. */
    get(id) {
      const giveaway = giveaways.get(id);
      return giveaway ? structuredClone(giveaway) : null;
    },

    all() {
      return [...giveaways.values()].map((g) => structuredClone(g));
    },

    /** Stores a new giveaway (throws when the file cannot be written; nothing changed then). */
    create(giveaway) {
      const clean = sanitize(giveaway);
      if (!clean || giveaways.has(clean.id)) throw new Error('Geçersiz çekiliş');
      write(new Map(giveaways).set(clean.id, clean));
      return structuredClone(clean);
    },

    /**
     * Changes a giveaway in one synchronous step: `change` gets a copy and edits it. Returns the saved copy,
     * or null when there is no such giveaway. Two calls can never interleave (no await in between).
     */
    update(id, change) {
      const current = giveaways.get(id);
      if (!current) return null;
      const copy = structuredClone(current);
      change(copy);
      const clean = sanitize(copy);
      write(new Map(giveaways).set(id, clean));
      return structuredClone(clean);
    },

    remove(id) {
      if (!giveaways.has(id)) return false;
      const next = new Map(giveaways);
      next.delete(id);
      write(next);
      return true;
    },

    /** Deletes finished giveaways kept longer than SAKLAMA_MS (their participant ids go with them). */
    sweep() {
      const expired = [...giveaways.values()].filter(
        (g) => g.durum === 'bitti' && (g.bittiAt ?? g.bitis) + SAKLAMA_MS <= now(),
      );
      if (!expired.length || readOnly) return 0;
      const next = new Map(giveaways);
      for (const g of expired) next.delete(g.id);
      try {
        write(next);
      } catch {
        return 0;
      }
      return expired.length;
    },
  };
  store.sweep();
  return store;
}
