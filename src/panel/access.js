// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Web panelinde kimin neyi görebileceğini ve yönetebileceğini
// sunucu tarafında denetler (tarayıcıya güvenmez): sunucu üyeliği, aynı ses kanalı kuralı ve
// Discord komutlarıyla aynı DJ rolü kuralı (src/bot/dj.js). Mesajlar src/mesajlar.js > panel.
// ---------------------------------------------------------------------------------------

import { PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { DJ_COMMANDS, isAloneWithBot, isDjAllowed, memberRoleIds } from '../bot/dj.js';
import { panel as M } from '../mesajlar.js';

const SNOWFLAKE = /^\d{17,20}$/;
const MEMBER_CACHE_MS = 60_000;

export class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AccessError';
    this.status = status;
  }
}

export function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE.test(value);
}

/**
 * Server-side permission rules for the panel. The browser is never trusted:
 * membership and roles come from Discord (bot REST call) and voice channels from the gateway cache.
 *
 *  - view:    the user is a member of a server the bot is in
 *  - control: view + the user sits in the SAME voice channel as the bot
 *             (when the bot is not in voice yet, any voice channel: the bot joins it)
 *             + the DJ rule for actions listed in DJ_COMMANDS (when the server has a DJ role)
 */
export function createAccess({ client, music, settings = null }) {
  // userId:guildId -> { member: { roleIds, canManageGuild } | null, at }; avoids one REST call per request.
  const memberCache = new Map();

  async function fetchMember(guild, userId, fresh = false) {
    const key = `${userId}:${guild.id}`;
    const cached = memberCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < MEMBER_CACHE_MS) return cached.member;
    let member;
    try {
      // force: discord.js never evicts cached members without the privileged GuildMembers intent,
      // so a cached member could be someone who already left. Our own cache limits REST calls.
      const found = await guild.members.fetch({ user: userId, cache: false, force: true });
      member = found
        ? {
            roleIds: memberRoleIds(found),
            canManageGuild: Boolean(found.permissions?.has?.(PermissionFlagsBits.ManageGuild)),
          }
        : null;
    } catch (error) {
      if (error?.code === RESTJSONErrorCodes.UnknownMember || error?.code === RESTJSONErrorCodes.UnknownUser)
        member = null;
      else throw error;
    }
    memberCache.set(key, { member, at: Date.now() });
    if (memberCache.size > 10_000) memberCache.delete(memberCache.keys().next().value);
    return member;
  }

  function botChannelOf(guild) {
    return music.getPlayer(guild.id)?.voiceChannelId ?? guild.members.me?.voice?.channelId ?? null;
  }

  /** DJ rule with the member data from the last membership check (at most a minute old). */
  function djAllowed(guild, userId) {
    const djRoleId = settings?.getDjRole(guild.id) ?? null;
    if (!djRoleId) return true;
    const member = memberCache.get(`${userId}:${guild.id}`)?.member;
    return isDjAllowed({
      djRoleId,
      roleIds: member?.roleIds ?? [],
      canManageGuild: member?.canManageGuild ?? false,
      aloneWithBot: isAloneWithBot(guild, userId, botChannelOf(guild)),
    });
  }

  /** Same-voice-channel rule only. */
  function voiceRule(guild, userId) {
    const userChannelId = guild.voiceStates.cache.get(userId)?.channelId ?? null;
    const botChannelId = botChannelOf(guild);
    const channelName = (id) => (id ? (guild.channels.cache.get(id)?.name ?? null) : null);

    let canControl = false;
    let reason = null;
    if (!userChannelId) {
      reason = M.kanalaKatil;
    } else if (botChannelId && botChannelId !== userChannelId) {
      reason = M.botunKanalinaKatil(channelName(botChannelId) ?? M.botunKanali);
    } else {
      canControl = true;
    }
    return {
      canControl,
      reason,
      userVoiceChannelId: userChannelId,
      userVoiceChannel: channelName(userChannelId),
      botVoiceChannelId: botChannelId,
      botVoiceChannel: channelName(botChannelId),
    };
  }

  /** Voice facts for one user, synchronous (gateway cache only). Shown in the panel. */
  function voiceAccess(guild, userId) {
    const voice = voiceRule(guild, userId);
    if (voice.canControl && !djAllowed(guild, userId)) return { ...voice, canControl: false, reason: M.djGerekli };
    return voice;
  }

  /**
   * Resolves guild + view rights or throws AccessError (400/404/403).
   * fresh=true skips the member cache and asks Discord again (used by long-lived streams).
   */
  async function requireView(userId, guildId, { fresh = false } = {}) {
    if (!isSnowflake(guildId)) throw new AccessError(400, M.gecersizSunucu);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new AccessError(404, M.botSunucudaDegil);
    if (!(await fetchMember(guild, userId, fresh))) throw new AccessError(403, M.uyeDegilsin);
    return guild;
  }

  /** requireView + same-voice-channel rule + DJ rule for `action`. Returns { guild, voice }. */
  async function requireControl(userId, guildId, action) {
    const guild = await requireView(userId, guildId);
    const voice = voiceRule(guild, userId);
    if (!voice.canControl) throw new AccessError(403, voice.reason);
    if (DJ_COMMANDS.has(action) && !djAllowed(guild, userId)) throw new AccessError(403, M.djGerekli);
    return { guild, voice };
  }

  return {
    requireView,
    requireControl,
    voiceAccess,
    forget(userId) {
      for (const key of memberCache.keys()) if (key.startsWith(`${userId}:`)) memberCache.delete(key);
    },
  };
}
