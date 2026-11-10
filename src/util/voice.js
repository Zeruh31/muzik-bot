// Ses kanalı kontrolleri: kullanıcı ses kanalında mı, botla aynı kanalda mı, botun izinleri yeterli mi.
// Mesajları src/mesajlar.js içinde (ses bölümü).

import { PermissionFlagsBits } from 'discord.js';
import { ses } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';

// They live here (not in MusicService) because the web panel has its own access rules.

/** The member must be in a voice channel; returns that channel. */
export function requireMemberVoice(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) {
    throw new MusicError(ErrorCodes.VOICE_REQUIRED, ses.kanalaKatil);
  }
  return channel;
}

/**
 * For commands that control an existing player: the member must be in the bot's channel.
 * Returns the member's voice channel.
 */
export function requireSameVoice(interaction, music) {
  const channel = requireMemberVoice(interaction);
  const player = music.getPlayer(interaction.guildId);
  if (player?.voiceChannelId && player.voiceChannelId !== channel.id) {
    throw new MusicError(ErrorCodes.WRONG_CHANNEL, ses.ayniKanal(player.voiceChannelId));
  }
  return channel;
}

/** For commands that may create a player: checks channel match and the bot's permissions. */
export function requireJoinableVoice(interaction, music) {
  const channel = requireSameVoice(interaction, music);
  assertBotCanJoin(channel, { alreadyConnected: Boolean(music.getPlayer(interaction.guildId)) });
  return channel;
}

/**
 * Throws when the bot lacks the permissions to join and speak in a voice channel.
 * Shared by slash commands and the web panel. `mention` renders the channel as <#id>
 * (Discord) instead of its plain name (web).
 */
export function assertBotCanJoin(channel, { alreadyConnected = false, mention = true } = {}) {
  const me = channel.guild.members.me;
  const permissions = channel.permissionsFor(me);
  const label = mention ? `<#${channel.id}>` : `"${channel.name}"`;
  const missing = [];
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)) missing.push(ses.izinAdlari.gor);
  if (!permissions?.has(PermissionFlagsBits.Connect)) missing.push(ses.izinAdlari.baglan);
  if (!permissions?.has(PermissionFlagsBits.Speak)) missing.push(ses.izinAdlari.konus);
  if (missing.length) throw new MusicError(ErrorCodes.MISSING_PERMISSIONS, ses.izinEksik(label, missing.join(', ')));
  if (channel.full && !permissions.has(PermissionFlagsBits.MoveMembers) && !alreadyConnected) {
    throw new MusicError(ErrorCodes.MISSING_PERMISSIONS, ses.kanalDolu);
  }
}
