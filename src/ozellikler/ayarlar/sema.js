// Ayar şeması: bir modülün hangi ayarları olduğunu ve her ayarın türünü tanımlar. /ayar komutunun alt
// komutları ve doğrulama bu tanımlardan üretilir; masaüstü uygulaması da ileride aynı doğrulayıcıyı kullanacak.
//
// Bir modülün `ayarlar` alanı: { 'anahtar': { tur, varsayilan?, ... } }, açıklaması modülün
// mesajlar.ayarlar['anahtar'] metni. Türler:
//   kanal  { kanalTurleri: ['metin'|'ses'|'kategori'] }   değer: kanal kimliği
//   rol    { verilebilir: true }  bot bu rolü üyelere verecekse (hiyerarşi ve tehlikeli izin denetimi)
//   metin  { enAz = 1, enFazla = 200 }
//   sayi   { enAz, enFazla }  tam sayı
//   bayrak {}  açık/kapalı
// Her türde `gizli: true` olan ayarın /ayar alt komutu olmaz (komut küçük kalsın; Discord sınırı 8000 karakter);
// modül onu kendi komutuyla ya da kontrol merkezinden değiştirir, /ayar goster yine gösterir.

import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ACTION_PATTERN, isReserved } from '../_ortak.js';
import { forbiddenPermissionText, hasForbiddenPermission, setterRefusal } from '../_roller.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { cevaplar, hatalar, turAdlari } from './mesajlar.js';

export const SETTING_TYPES = Object.freeze(['kanal', 'rol', 'metin', 'sayi', 'bayrak']);
export const SNOWFLAKE = /^\d{17,20}$/;
const TEXT_MAX = 1000;
// Control characters other than tab and newline.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export const CHANNEL_TYPES = Object.freeze({
  metin: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  ses: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
  kategori: [ChannelType.GuildCategory],
});

/** Checks a module's settings schema; throws with the module and key on a mistake. */
export function checkSchema(moduleName, ayarlar, mesajlar) {
  const keys = Object.keys(ayarlar ?? {});
  if (keys.length > 25) throw new Error(`${moduleName}: en fazla 25 ayar olabilir (Discord alt komut sınırı).`);
  for (const key of keys) {
    const where = `${moduleName}.${key}`;
    const alan = ayarlar[key];
    if (!ACTION_PATTERN.test(key) || isReserved(key)) throw new Error(`${where}: ayar adı geçersiz ya da ayrılmış.`);
    if (!SETTING_TYPES.includes(alan?.tur)) throw new Error(`${where}: tür ${SETTING_TYPES.join(', ')} olmalı.`);
    const aciklama = mesajlar?.ayarlar?.[key];
    if (typeof aciklama !== 'string' || aciklama.length < 1 || aciklama.length > 100) {
      throw new Error(`${where}: mesajlar.ayarlar içinde 1-100 karakterlik açıklama gerekli.`);
    }
    if (alan.tur === 'kanal') {
      const turler = alan.kanalTurleri ?? ['metin'];
      if (!turler.length || turler.some((t) => !Object.hasOwn(CHANNEL_TYPES, t))) {
        throw new Error(`${where}: kanalTurleri metin, ses ya da kategori olmalı.`);
      }
    }
    if (
      alan.tur === 'sayi' &&
      !(Number.isInteger(alan.enAz) && Number.isInteger(alan.enFazla) && alan.enAz <= alan.enFazla)
    ) {
      throw new Error(`${where}: sayı ayarı için enAz ve enFazla tam sayı olmalı.`);
    }
    if (alan.tur === 'metin' && (alan.enFazla ?? 200) > TEXT_MAX)
      throw new Error(`${where}: metin en fazla ${TEXT_MAX}.`);
    if (alan.varsayilan !== undefined && alan.varsayilan !== null && !isStoredValueValid(alan, alan.varsayilan)) {
      throw new Error(`${where}: varsayılan değer türüne uymuyor.`);
    }
  }
}

/** Adds the "deger" option of the right type to an /ayar subcommand builder. */
export function addValueOption(subcommand, alan, aciklama) {
  switch (alan.tur) {
    case 'kanal':
      return subcommand.addChannelOption((o) =>
        o
          .setName('deger')
          .setDescription(aciklama)
          .addChannelTypes(...(alan.kanalTurleri ?? ['metin']).flatMap((t) => CHANNEL_TYPES[t])),
      );
    case 'rol':
      return subcommand.addRoleOption((o) => o.setName('deger').setDescription(aciklama));
    case 'metin':
      return subcommand.addStringOption((o) =>
        o
          .setName('deger')
          .setDescription(aciklama)
          .setMinLength(alan.enAz ?? 1)
          .setMaxLength(alan.enFazla ?? 200),
      );
    case 'sayi':
      return subcommand.addIntegerOption((o) =>
        o.setName('deger').setDescription(aciklama).setMinValue(alan.enAz).setMaxValue(alan.enFazla),
      );
    default:
      return subcommand.addBooleanOption((o) => o.setName('deger').setDescription(aciklama));
  }
}

/** The raw "deger" option of an /ayar interaction, or null when it was left empty. */
export function readValueOption(interaction, alan) {
  const { options } = interaction;
  switch (alan.tur) {
    case 'kanal':
      return options.getChannel('deger');
    case 'rol':
      return options.getRole('deger');
    case 'metin':
      return options.getString('deger');
    case 'sayi':
      return options.getInteger('deger');
    default:
      return options.getBoolean('deger');
  }
}

/** Whether a value read back from data/ozellikler.json still fits its field. */
export function isStoredValueValid(alan, value) {
  switch (alan.tur) {
    case 'kanal':
    case 'rol':
      return typeof value === 'string' && SNOWFLAKE.test(value);
    case 'metin':
      return (
        typeof value === 'string' &&
        value.length >= (alan.enAz ?? 1) &&
        value.length <= (alan.enFazla ?? 200) &&
        !CONTROL_CHARS.test(value)
      );
    case 'sayi':
      return Number.isInteger(value) && value >= alan.enAz && value <= alan.enFazla;
    case 'bayrak':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

const fail = (text) => {
  throw new OzellikHatasi(text);
};

function checkChannel(alan, channel, guild) {
  if (!channel || !SNOWFLAKE.test(String(channel.id))) fail(hatalar.kanalBaskaSunucu);
  const channelGuildId = channel.guildId ?? channel.guild?.id ?? channel.guild_id;
  if (guild && channelGuildId && channelGuildId !== guild.id) fail(hatalar.kanalBaskaSunucu);
  const kinds = alan.kanalTurleri ?? ['metin'];
  if (!kinds.some((kind) => CHANNEL_TYPES[kind].includes(channel.type))) {
    fail(hatalar.kanalTuru(kinds.map((k) => turAdlari[k]).join(', ')));
  }
  const me = guild?.members?.me;
  if (kinds.includes('metin') && me && typeof channel.permissionsFor === 'function') {
    const allowed = channel
      .permissionsFor(me)
      ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    if (!allowed) fail(hatalar.kanalIzni(channel.id));
  }
  return channel.id;
}

function checkRole(alan, role, guild, member) {
  if (!role || !SNOWFLAKE.test(String(role.id))) fail(hatalar.rolHerkes);
  if (guild && role.id === guild.id) fail(hatalar.rolHerkes);
  if (role.managed) fail(hatalar.rolYonetilen);
  if (alan.verilebilir) {
    // The forbidden list and the setter rule live in src/ozellikler/_roller.js (also checked when giving).
    if (hasForbiddenPermission(role)) fail(forbiddenPermissionText(role, `<@&${role.id}> rolünde`));
    const highest = guild?.members?.me?.roles?.highest;
    if (highest && Number(role.position) >= Number(highest.position)) fail(hatalar.rolHiyerarsi(role.id));
    // Who sets it up must be above it (the owner excepted): nobody hands out a role higher than their own.
    if (member && setterRefusal(guild, role, member)) fail(hatalar.rolKisiHiyerarsi(role.id));
  }
  return role.id;
}

/**
 * Validates a value given with /ayar (or, later, from the desktop app) and returns what is stored.
 * Throws OzellikHatasi with a Turkish reason when it is refused.
 * @param {object} alan the field from the schema
 * @param {*} raw a channel or role object, a string, a number or a boolean
 * @param {{ guild?: object, member?: object }} where the guild the setting belongs to (for channel, role and
 *   hierarchy checks) and who sets it (a role to hand out must be below their highest role, owner excepted)
 */
export function validateValue(alan, raw, { guild, member } = {}) {
  switch (alan.tur) {
    case 'kanal':
      return checkChannel(alan, raw, guild);
    case 'rol':
      return checkRole(alan, raw, guild, member);
    case 'metin': {
      const text = String(raw ?? '').trim();
      const min = alan.enAz ?? 1;
      const max = alan.enFazla ?? 200;
      if (text.length < min || text.length > max) fail(hatalar.metinUzunlugu(min, max));
      if (CONTROL_CHARS.test(text)) fail(hatalar.metinKarakteri);
      return text;
    }
    case 'sayi':
      if (!Number.isInteger(raw) || raw < alan.enAz || raw > alan.enFazla)
        fail(hatalar.sayiAraligi(alan.enAz, alan.enFazla));
      return raw;
    case 'bayrak':
      if (typeof raw !== 'boolean') fail(hatalar.bayrak);
      return raw;
    default:
      return fail(hatalar.bayrak);
  }
}

/** How a stored value is shown in /ayar goster and the menu. */
export function formatValue(alan, value) {
  if (value === null || value === undefined) return cevaplar.bos;
  switch (alan.tur) {
    case 'kanal':
      return `<#${value}>`;
    case 'rol':
      return `<@&${value}>`;
    case 'metin':
      return `\`${String(value).replaceAll('`', 'ˋ').slice(0, 100)}\``;
    case 'bayrak':
      return value ? cevaplar.acik : cevaplar.kapali;
    default:
      return String(value);
  }
}
