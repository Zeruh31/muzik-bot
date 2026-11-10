// Botun sunucuda ihtiyaç duyduğu izinler (/invite bağlantısı bunları ister).
import { PermissionFlagsBits } from 'discord.js';

/**
 * Everything the bot needs in a server: see channels, post now-playing embeds,
 * join and speak in voice. Used by /invite and printed in README (value 3165184).
 */
export const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];
