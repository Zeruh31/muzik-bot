// Botun kendiliğinden kanala yazdığı mesajlar: "Şimdi çalıyor", hata, kuyruk bitti.
// Yazılar src/mesajlar.js içinde (duyurular bölümü).

import { PermissionFlagsBits } from 'discord.js';
import { duyurular, etiketler } from '../mesajlar.js';
import { baseEmbed, errorEmbed, requesterMention, trackDuration, trackLink } from '../util/embeds.js';
import { escapeMarkdown } from '../util/format.js';

/**
 * Posts "now playing" and queue messages to the text channel a player was started from.
 * The previous now-playing message is deleted so the channel does not fill up.
 */
export function startAnnouncer({ client, music, config, logger }) {
  const lastMessage = new Map();

  async function send(guildId, payload) {
    const player = music.getPlayer(guildId);
    const channelId = player?.textChannelId;
    if (!channelId) return null;
    const channel = client.channels.cache.get(channelId);
    if (!channel?.isTextBased() || !channel.isSendable?.()) return null;
    const me = channel.guild?.members.me;
    if (me && !channel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
      return null;
    try {
      return await channel.send(payload);
    } catch (error) {
      logger.debug('Duyuru gönderilemedi:', error?.message ?? error);
      return null;
    }
  }

  async function deleteLast(guildId) {
    const message = lastMessage.get(guildId);
    lastMessage.delete(guildId);
    if (message) await message.delete().catch(() => {});
  }

  music.on('trackStarted', async (guildId, track) => {
    await deleteLast(guildId);
    const embed = baseEmbed()
      .setAuthor({ name: duyurular.simdiCaliyor })
      .setDescription(
        [
          `${trackLink(track, 200)}\n${escapeMarkdown(track.author)}`,
          // Spotify & co.: say which YouTube video is really playing.
          track.mirror
            ? duyurular.youtubeKaynagi(trackLink({ ...track.mirror, title: track.mirror.title ?? '?' }, 120))
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .addFields(
        { name: etiketler.sure, value: trackDuration(track), inline: true },
        { name: etiketler.isteyen, value: requesterMention(track), inline: true },
      );
    if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);
    const message = await send(guildId, { embeds: [embed], allowedMentions: { parse: [] } });
    if (message) lastMessage.set(guildId, message);
  });

  music.on('trackFailed', async (guildId, track, reason) => {
    const title = track ? `${trackLink(track)}: ` : '';
    await send(guildId, { embeds: [errorEmbed(`${title}${reason}`)] });
  });

  music.on('trackRetried', async (guildId, failed, reason, next) => {
    const text = duyurular.sonrakiSonucDeneniyor(trackLink(failed), reason, trackLink(next));
    await send(guildId, { embeds: [baseEmbed().setDescription(text)] });
  });

  music.on('queueEnded', async (guildId) => {
    await deleteLast(guildId);
    const tail = config.music.twentyFourSeven ? '' : duyurular.ayrilacagim(config.music.leaveAfterQueueEndSeconds);
    await send(guildId, { embeds: [baseEmbed().setDescription(`${duyurular.kuyrukBitti}${tail}`)] });
  });

  music.on('playerDestroyed', (guildId) => {
    deleteLast(guildId);
  });

  /** Sends a plain notice to a guild's music text channel (used by the idle watcher). */
  return async function notify(guildId, text) {
    await send(guildId, { embeds: [baseEmbed().setDescription(text)] });
  };
}
