// Botun sunucuda ihtiyaç duyduğu izinler (/invite bağlantısı bunları ister; README'deki sayı da budur).
// Müziğin izinleri burada; her özellik modülü kendi izinlerini tanımındaki `izinler` alanıyla ekler
// (src/ozellikler/_ortak.js). Böylece bir izin ancak onu kullanan özellik eklendiğinde istenir.
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/**
 * What music needs: see channels, post now-playing embeds, join and speak in voice (value 3165184).
 */
export const MUSIC_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);

/**
 * Music's permissions plus those the given feature modules list in `izinler` (permission flag names).
 * @param {Iterable<{ izinler?: string[] }>} modules
 * @returns {bigint[]}
 */
export function botPermissions(modules = []) {
  const flags = new Set(MUSIC_PERMISSIONS);
  for (const module of modules) {
    for (const name of module.izinler ?? []) flags.add(PermissionFlagsBits[name]);
  }
  return [...flags];
}

/** The number in the invite link's "permissions=" part. */
export const permissionsValue = (flags) => new PermissionsBitField(flags).bitfield.toString();
