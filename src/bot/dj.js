// DJ rolü kuralı. Bir sunucuda /dj ile rol ayarlandıysa aşağıdaki listedeki komutları yalnızca
//   - o role sahip olanlar,
//   - "Sunucuyu Yönet" izni olanlar (sunucu yöneticileri),
//   - botla aynı ses kanalında tek başına olan kişi
// kullanabilir. Rol ayarlı değilse herkes kullanabilir. Web paneli ve "Şimdi çalıyor" mesajının
// düğmeleri de aynı listeyi kullanır.
//
// Bir komutu DJ'ye özel yapmak ya da serbest bırakmak için aşağıdaki listeye adını ekle/çıkar.

import { PermissionFlagsBits } from 'discord.js';

export const DJ_COMMANDS = new Set([
  'autoplay',
  'bassboost',
  'clear',
  'crossfade',
  'disconnect',
  'loop',
  'loopqueue',
  'move',
  'pause',
  'playfirst',
  'previous',
  'remove',
  'resume',
  'seek',
  'shuffle',
  'skip',
  'skipto',
  'stop',
  'volume',
]);

/** Pure rule, shared by slash commands and the web panel. */
export function isDjAllowed({ djRoleId, roleIds = [], canManageGuild = false, aloneWithBot = false }) {
  if (!djRoleId) return true;
  return canManageGuild || aloneWithBot || roleIds.includes(djRoleId);
}

/** Ids of the people (not bots) in a voice channel, from the gateway cache. */
export function humansInVoice(guild, channelId) {
  if (!channelId) return [];
  const botId = guild.members?.me?.id;
  return [...guild.voiceStates.cache.entries()]
    .filter(([userId, state]) => state.channelId === channelId && userId !== botId && !state.member?.user?.bot)
    .map(([userId]) => userId);
}

/** True when the user is the only person in the bot's voice channel. */
export function isAloneWithBot(guild, userId, botChannelId) {
  const humans = humansInVoice(guild, botChannelId);
  return humans.length === 1 && humans[0] === userId;
}

/** Role ids of a GuildMember or of the raw member object Discord sends with interactions. */
export function memberRoleIds(member) {
  if (!member) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...(member.roles?.cache?.keys?.() ?? [])];
}

/**
 * DJ check for a slash command (or a control button, which passes the command it stands for as
 * `commandName`). Returns the DJ role id that is missing, or null when allowed (also when the
 * command does not need DJ rights at all).
 */
export function missingDjRole(interaction, { settings, music }, commandName = interaction.commandName) {
  if (!DJ_COMMANDS.has(commandName)) return null;
  const djRoleId = settings.getDjRole(interaction.guildId);
  if (!djRoleId || !interaction.guild) return null;
  const botChannelId =
    music.getPlayer(interaction.guildId)?.voiceChannelId ?? interaction.guild.members?.me?.voice?.channelId;
  const allowed = isDjAllowed({
    djRoleId,
    roleIds: memberRoleIds(interaction.member),
    canManageGuild: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
    aloneWithBot: isAloneWithBot(interaction.guild, interaction.user.id, botChannelId),
  });
  return allowed ? null : djRoleId;
}
