// Masaüstü uygulamasının ayar formu için iki dosya:
//   data/ayar-semasi.json     kayıtlı modüllerin ayar şeması (alanlar, türler, etiketler, sınırlar, kategori);
//                             uygulama alan listesini kopyalamaz, bu dosyadan form üretir
//   data/ayarlar-gorunum.json sunucu başına şimdiki değerler, listeler ve "rol verilmiyor" uyarıları
// İçinde token, şifre ya da kullanıcı bilgisi YOKTUR. Şema `hassas: true` dediği bir değer olursa maskelenir
// (şu an hiçbir ayar hassas değil). Normalde bu dosyaya dokunmana gerek yok.

import { whyNotAssignableCached } from '../_roller.js';
import { kategoriler, modulKategorisi } from './mesajlar.js';

export const SCHEMA_EXPORT_VERSION = 1;
export const VIEW_SCHEMA_VERSION = 1;
export const MASK = '••••••';

/** Modules with settings the desktop app shows, in loading order. */
const settingModules = (ozellikler) =>
  [...ozellikler.moduller.values()].filter(
    (m) => Object.keys(m.ayarlar ?? {}).length || Object.keys(m.ayarListeleri ?? {}).length,
  );

/** Keys a list setting stores (e.g. kayit haric-1..5): shown as that one list, not one by one. */
export const coveredKeys = (module) =>
  new Set(Object.values(module.ayarListeleri ?? {}).flatMap((l) => l.kapsar ?? []));

/** "Hoş geldin metni: {kullanıcı}, ..." -> label "Hoş geldin metni", the whole text stays the description. */
export function labelOf(text) {
  const cut = String(text).search(/ \(|: |, ör\./);
  return cut > 0 ? text.slice(0, cut) : text;
}

/**
 * Discord markup to plain text for the desktop app: <#id> -> #kanal, <@&id> -> @rol, no ** or `.
 * Names come from the guild cache; an unknown id stays a short placeholder.
 */
export function plainText(text, guild) {
  return String(text ?? '')
    .replace(/<#(\d{17,20})>/g, (_m, id) => `#${guild?.channels?.cache?.get(id)?.name ?? 'silinmiş-kanal'}`)
    .replace(/<@&(\d{17,20})>/g, (_m, id) => `@${guild?.roles?.cache?.get(id)?.name ?? 'silinmiş-rol'}`)
    .replace(/<@!?(\d{17,20})>/g, '@kullanıcı')
    .replace(/\*\*|`/g, '')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,)])/g, '$1$2')
    .replace(/\\([*_`~|>\\])/g, '$1')
    .replace(/^[•-]\s+/, '')
    .trim();
}

function fieldExport(module, anahtar, alan) {
  const aciklama = module.mesajlar?.ayarlar?.[anahtar] ?? anahtar;
  const out = {
    anahtar,
    tur: alan.tur,
    etiket: labelOf(aciklama),
    aciklama,
    varsayilan: alan.hassas ? null : (alan.varsayilan ?? null),
    yalnizDiscord: null,
  };
  if (alan.hassas) out.hassas = true;
  if (alan.tur === 'kanal') out.kanalTurleri = [...(alan.kanalTurleri ?? ['metin'])];
  if (alan.tur === 'rol') out.verilebilir = Boolean(alan.verilebilir);
  if (alan.tur === 'metin') Object.assign(out, { enAz: alan.enAz ?? 1, enFazla: alan.enFazla ?? 200 });
  if (alan.tur === 'sayi') Object.assign(out, { enAz: alan.enAz, enFazla: alan.enFazla });
  return out;
}

function listExport(anahtar, list) {
  const out = {
    anahtar,
    tur: list.tur,
    etiket: labelOf(list.aciklama),
    aciklama: list.aciklama,
    varsayilan: list.tur === 'ozel' ? null : [],
    yalnizDiscord: list.tur === 'ozel' || list.yalnizDiscord ? list.yalnizDiscord : null,
  };
  if (list.tur === 'kanal-listesi') out.kanalTurleri = [...(list.kanalTurleri ?? ['metin'])];
  if (list.tur !== 'ozel') out.enFazla = list.enFazla;
  return out;
}

/** The whole data/ayar-semasi.json object. */
export function buildSchemaExport(ozellikler, { now = Date.now() } = {}) {
  return {
    schemaVersion: SCHEMA_EXPORT_VERSION,
    guncellendi: new Date(now).toISOString(),
    kategoriler,
    moduller: settingModules(ozellikler).map((module) => {
      const covered = coveredKeys(module);
      return {
        ad: module.ad,
        baslik: module.mesajlar?.baslik ?? module.ad,
        emoji: module.mesajlar?.emoji ?? '',
        kategori: modulKategorisi[module.ad] ?? 'Diğer',
        kapali: ozellikler.disabledReason(module.ad),
        alanlar: [
          ...Object.entries(module.ayarlar ?? {})
            .filter(([key]) => !covered.has(key))
            .map(([key, alan]) => fieldExport(module, key, alan)),
          ...Object.entries(module.ayarListeleri ?? {}).map(([key, list]) => listExport(key, list)),
        ],
      };
    }),
  };
}

function guildView(context, guild) {
  const { ozellikler } = context;
  const store = ozellikler.ayarlar;
  const degerler = {};
  const ayarli = [];
  const uyarilar = {};
  const listeler = {};
  for (const module of settingModules(ozellikler)) {
    const covered = coveredKeys(module);
    for (const [key, alan] of Object.entries(module.ayarlar ?? {})) {
      if (covered.has(key)) continue;
      const id = `${module.ad}.${key}`;
      const value = store.get(guild.id, module.ad, key);
      degerler[id] = alan.hassas && value !== null ? MASK : value;
      if (store.isSet(guild.id, module.ad, key)) ayarli.push(id);
      if (alan.tur === 'rol' && alan.verilebilir && value) {
        const neden = whyNotAssignableCached(guild, value, { setterId: store.setBy(guild.id, module.ad, key) });
        if (neden) uyarilar[id] = neden;
      }
    }
    for (const [key, list] of Object.entries(module.ayarListeleri ?? {})) {
      if (ozellikler.disabledReason(module.ad)) continue;
      let items;
      try {
        items = list.oku(context, guild.id) ?? [];
      } catch {
        items = [];
      }
      listeler[`${module.ad}.${key}`] =
        list.tur === 'ozel' ? items.map((line) => plainText(line, guild)).filter(Boolean) : [...items];
    }
  }
  return { degerler, ayarli, uyarilar, listeler };
}

/** The whole data/ayarlar-gorunum.json object: per guild the values in effect, set by the guild or default. */
export function buildSettingsView(context, { now = Date.now() } = {}) {
  const sunucular = {};
  for (const guild of context.client.guilds?.cache?.values() ?? []) sunucular[guild.id] = guildView(context, guild);
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    guncellendi: new Date(now).toISOString(),
    saltOkunur: Boolean(context.ozellikler.ayarlar.saltOkunur),
    sunucular,
  };
}
