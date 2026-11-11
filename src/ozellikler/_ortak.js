// Özellik modüllerinin ortak yardımcıları: modül tanımını denetler, komut kurar, kalıcı customId üretir.
// Adı "_" ile başlayan dosyalar modül olarak yüklenmez. Normalde bu dosyaya dokunmana gerek yok.
//
// Bir modül (src/ozellikler/<ad>/index.js) varsayılan olarak şu nesneyi dışa aktarır:
//   ad          küçük harf, rakam ve "-" (ör. "menu"); customId ve ayar anahtarlarında kullanılır
//   mesajlar    modülün kendi yazıları (src/ozellikler/<ad>/mesajlar.js); baslik ve emoji burada
//   komutlar    [{ data, execute, autocomplete?, kategori?, ust? }] ya da (tümModüller) => [...]
//               ust: 'oyun' ise komut /oyun altına alt komut olarak girer (ozSubcommand ile kurulur)
//   bilesenler  { eylem: async (interaction, context, args) => {} }  "oz:<ad>:<eylem>:..." ile çağrılır
//   ayarlar     ayar şeması (src/ozellikler/ayarlar/sema.js): /ayar alt komutları bundan üretilir
//   menu        { sira, gorunurluk: 'herkes'|'dj'|'yonetici', kategori?, gorunur?(ctx), ciz(ctx) } kontrol
//               merkezi bölümü (ya da birkaç bölümün dizisi); aynı kategorideki bölümler tek başlıkta toplanır
//               (_mesajlar.js > menuKategorileri)
//   olaylar     (context) => (kapatma işlevi | undefined)  Discord ve müzik olay dinleyicileri
//   isler       { tur: async (veri, context) => {} }  kalıcı zamanlayıcının iş türleri
//   intentler   ['GuildMembers', ...] modülün gereken gateway intent'leri
//   istegeBagliIntentler ['MessageContent', ...] olmasa da modülün çalıştığı (ayrıcalıklı) intent'ler: Discord
//               vermezse modül kapanmaz, yalnız onlara bağlı işlerini kapatır (intentPlan.names'e bakarak)
//   partials    ['Message', ...] önbellekte olmayan nesneler için de olay almak gerekiyorsa (discord.js Partials)
//   ayarKomutlari [{ data: SlashCommandSubcommandGroupBuilder, execute, autocomplete? }] /ayar altına eklenen
//               kendi alt komut grupları (şemaya sığmayan ayarlar için, ör. /ayar rol-menusu olustur)
//   ayarUyarilari async (guild, context) => ['⚠️ ...'] /ayar goster'de modülün kendi uyarı satırları
//   ayarListeleri { anahtar: { tur, aciklama, oku, uygula?, kanalTurleri?, enFazla?, kapsar?, yalnizDiscord? } }
//               listeli ayarlar (masaüstü uygulamasının ayar şemasına girer, src/ozellikler/_masaustu):
//               tur 'kanal-listesi' | 'rol-listesi': oku(context, guildId) => [id...], uygula(context, guild, [id...])
//               => [id...] (Discord komutundaki doğrulamanın aynısıyla); tur 'ozel': yalnızca Discord'dan
//               değişir (yalnizDiscord: '/komut'), oku(context, guildId) => ['gösterilecek satır', ...].
//               kapsar: listenin sakladığı (gizli) ayar anahtarları; masaüstü onları tek tek değiştirmez
//   ayarDegisti (context, guildId, anahtar, deger) => {}  şemadaki bir ayar /ayar ya da masaüstünden değişince
//   izinler     ['ManageRoles', ...] botun sunucuda bu modül için istediği izinler (davet bağlantısına eklenir;
//               Administrator istenemez)
//   kapat       () => {}  bot kapanırken

import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from 'discord.js';
import { menuKategorileri } from './_mesajlar.js';

/** Every persistent component of a feature module has a customId starting with this. */
export const OZ_PREFIX = 'oz:';
/** Discord's customId limit. */
export const CUSTOM_ID_MAX = 100;

export const NAME_PATTERN = /^[a-z][a-z0-9-]{1,19}$/;
export const ACTION_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Names that would clash with JavaScript object internals or with /ayar's own subcommands.
 * A module or setting may not use them ("ayrılmış ad").
 */
export const RESERVED_NAMES = new Set([
  ...['__proto__', ...Object.getOwnPropertyNames(Object.prototype)].map((n) => n.toLowerCase()),
  'prototype',
  'goster',
  'panel',
  'oz',
]);

export const isReserved = (name) => RESERVED_NAMES.has(String(name).toLowerCase());

/** A persistent customId "oz:<modul>:<eylem>[:arg...]"; throws when it would exceed 100 characters. */
export function ozId(modul, eylem, ...args) {
  if (!NAME_PATTERN.test(modul) || !ACTION_PATTERN.test(eylem)) {
    throw new Error(`Geçersiz customId parçası: ${modul}:${eylem}`);
  }
  for (const arg of args) {
    if (String(arg).includes(':')) throw new Error(`customId argümanı ":" içeremez: ${arg}`);
  }
  const id = [`${OZ_PREFIX}${modul}`, eylem, ...args.map(String)].join(':');
  if (id.length > CUSTOM_ID_MAX) throw new Error(`customId ${CUSTOM_ID_MAX} karakteri aşıyor: ${id}`);
  return id;
}

/** { modul, eylem, args } for an "oz:" customId, or null for any other id. */
export function parseOzId(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(OZ_PREFIX) || customId.length > CUSTOM_ID_MAX) return null;
  const [modul, eylem, ...args] = customId.slice(OZ_PREFIX.length).split(':');
  if (!NAME_PATTERN.test(modul ?? '') || !ACTION_PATTERN.test(eylem ?? '')) return null;
  return { modul, eylem, args };
}

/** A guild-only slash command whose description comes from a module's own messages. */
export function ozCommand(name, aciklama) {
  return new SlashCommandBuilder().setName(name).setDescription(aciklama).setContexts(InteractionContextType.Guild);
}

/**
 * A subcommand of a shared parent command (e.g. /oyun zar). A module lists it in `komutlar` as
 * { ust: 'oyun', data: ozSubcommand('zar', ...), execute }; the parent is built in src/ozellikler/index.js.
 */
export function ozSubcommand(name, aciklama) {
  return new SlashCommandSubcommandBuilder().setName(name).setDescription(aciklama);
}

/** Names an option and sets its description (from a module's messages). */
export function ozDescribe(option, name, aciklama) {
  return option.setName(name).setDescription(aciklama);
}

const MENU_VISIBILITY = new Set(['herkes', 'dj', 'yonetici']);
/** List setting types (ayarListeleri); "ozel" ones are only changed from Discord. */
export const LIST_TYPES = Object.freeze(['kanal-listesi', 'rol-listesi', 'ozel']);

function checkLists(where, definition) {
  const lists = definition.ayarListeleri;
  if (lists === undefined) return;
  if (!lists || typeof lists !== 'object' || Array.isArray(lists))
    throw new Error(`${where}: ayarListeleri bir nesne olmalı.`);
  for (const [key, list] of Object.entries(lists)) {
    const at = `${where}: ayarListeleri.${key}`;
    if (!ACTION_PATTERN.test(key) || isReserved(key) || Object.hasOwn(definition.ayarlar ?? {}, key))
      throw new Error(`${at}: ad geçersiz, ayrılmış ya da bir ayarla çakışıyor.`);
    if (!LIST_TYPES.includes(list?.tur)) throw new Error(`${at}: tür ${LIST_TYPES.join(', ')} olmalı.`);
    if (typeof list.aciklama !== 'string' || list.aciklama.length < 1 || list.aciklama.length > 100)
      throw new Error(`${at}: 1-100 karakterlik açıklama gerekli.`);
    if (typeof list.oku !== 'function') throw new Error(`${at}: oku işlevi gerekli.`);
    const discordOnly = list.tur === 'ozel' || list.yalnizDiscord !== undefined;
    if (discordOnly && !/^\/[a-z]/.test(list.yalnizDiscord ?? ''))
      throw new Error(`${at}: yalnizDiscord "/komut" biçiminde olmalı.`);
    if (!discordOnly && (typeof list.uygula !== 'function' || !Number.isInteger(list.enFazla) || list.enFazla < 1))
      throw new Error(`${at}: uygula işlevi ve enFazla gerekli.`);
    for (const covered of list.kapsar ?? []) {
      if (!Object.hasOwn(definition.ayarlar ?? {}, covered))
        throw new Error(`${at}: kapsar "${covered}" bir ayar değil.`);
    }
  }
}
const KNOWN_FIELDS = new Set([
  'ad',
  'mesajlar',
  'komutlar',
  'bilesenler',
  'ayarlar',
  'menu',
  'olaylar',
  'isler',
  'intentler',
  'istegeBagliIntentler',
  'partials',
  'ayarKomutlari',
  'ayarUyarilari',
  'ayarListeleri',
  'ayarDegisti',
  'izinler',
  'kapat',
]);

/**
 * Checks a module definition and returns it frozen. Mistakes are found when the bot starts
 * (and by "npm test"), not when somebody clicks a button.
 */
export function defineModule(definition) {
  const where = `src/ozellikler/${definition?.ad ?? '?'}`;
  if (!definition || typeof definition !== 'object') throw new Error(`${where}: modül tanımı bir nesne olmalı.`);
  const { ad } = definition;
  if (!NAME_PATTERN.test(ad ?? '') || isReserved(ad)) throw new Error(`${where}: modül adı geçersiz ya da ayrılmış.`);
  for (const key of Object.keys(definition)) {
    if (!KNOWN_FIELDS.has(key)) throw new Error(`${where}: bilinmeyen alan "${key}".`);
  }
  for (const eylem of Object.keys(definition.bilesenler ?? {})) {
    if (!ACTION_PATTERN.test(eylem)) throw new Error(`${where}: bileşen eylemi geçersiz: "${eylem}".`);
    if (typeof definition.bilesenler[eylem] !== 'function') throw new Error(`${where}: "${eylem}" bir işlev olmalı.`);
  }
  for (const tur of Object.keys(definition.isler ?? {})) {
    if (!ACTION_PATTERN.test(tur)) throw new Error(`${where}: iş türü geçersiz: "${tur}".`);
  }
  // One section, or a list of them (each may go under another kategori).
  const menus = Array.isArray(definition.menu) ? definition.menu : definition.menu ? [definition.menu] : [];
  for (const menu of menus) {
    const { gorunurluk = 'herkes', ciz } = menu ?? {};
    if (!MENU_VISIBILITY.has(gorunurluk))
      throw new Error(`${where}: menü görünürlüğü herkes, dj ya da yonetici olmalı.`);
    if (typeof ciz !== 'function') throw new Error(`${where}: menü bölümünün ciz(ctx) işlevi olmalı.`);
    if (!definition.mesajlar?.baslik) throw new Error(`${where}: menü bölümü için mesajlar.baslik gerekli.`);
    if (menu.kategori !== undefined && !own(menuKategorileri, menu.kategori)) {
      throw new Error(`${where}: menü kategorisi src/ozellikler/_mesajlar.js > menuKategorileri içinde yok.`);
    }
  }
  for (const name of definition.izinler ?? []) {
    if (typeof PermissionFlagsBits[name] !== 'bigint') throw new Error(`${where}: bilinmeyen izin "${name}".`);
    // The invite link must never ask for full control: every module names the permissions it uses.
    if (name === 'Administrator')
      throw new Error(`${where}: "Administrator" izni istenemez; gereken izinleri tek tek yazın.`);
  }
  for (const field of ['intentler', 'istegeBagliIntentler', 'partials', 'ayarKomutlari']) {
    if (definition[field] && !Array.isArray(definition[field])) throw new Error(`${where}: ${field} bir dizi olmalı.`);
  }
  checkLists(where, definition);
  if (definition.ayarDegisti !== undefined && typeof definition.ayarDegisti !== 'function')
    throw new Error(`${where}: ayarDegisti bir işlev olmalı.`);
  for (const extra of definition.ayarKomutlari ?? []) {
    if (!extra?.data?.name || typeof extra.execute !== 'function')
      throw new Error(`${where}: her ayar komutunun "data" ve "execute" alanı olmalı.`);
  }
  return Object.freeze({ ...definition });
}

/** Whether the user of an interaction has "Sunucuyu Yönet" (the bot's meaning of "yönetici"). */
export const canManageGuild = (interaction) =>
  Boolean(interaction?.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));

/** Own property lookup that never reaches Object.prototype (customIds come from Discord). */
export const own = (object, key) => (object && Object.hasOwn(object, key) ? object[key] : undefined);

/**
 * Splits a typed list of options: by "|" or line breaks when the text has any (so options may contain commas),
 * otherwise by commas. Parts are trimmed and empty ones dropped.
 */
export const listeyiAyir = (text) => {
  const value = String(text ?? '');
  return value
    .split(/[|\r\n]/.test(value) ? /[|\r\n]+/ : ',')
    .map((s) => s.trim())
    .filter(Boolean);
};
