// Botun kendiliğinden kanala yazdığı mesajlar: "Şimdi çalıyor" (kontrol düğmeleriyle), hata, kuyruk bitti.
// Yazılar src/mesajlar.js içinde (duyurular ve kontrol bölümleri); düğmeler src/bot/controls.js içinde.

import { PermissionFlagsBits } from 'discord.js';
import { duyurular, etiketler, kontrol } from '../mesajlar.js';
import { baseEmbed, errorEmbed, requesterMention, trackDuration, trackLink } from '../util/embeds.js';
import { AUTOPLAY_MAX_FAILURES } from '../music/MusicService.js';
import { escapeMarkdown } from '../util/format.js';
import { controlRows, controlSignature } from './controls.js';

/** How long state changes are collected before the now-playing message is edited once. */
const REFRESH_DELAY_MS = 600;

/** The "now playing" embed for a track view and the guild's current state. */
export function nowPlayingEmbed(track, state) {
  const embed = baseEmbed()
    .setAuthor({ name: duyurular.simdiCaliyor })
    .setDescription(
      [
        `${trackLink(track, 200)}\n${escapeMarkdown(track.author)}`,
        // Spotify & co.: say which YouTube video is really playing.
        track.mirror
          ? duyurular.youtubeKaynagi(trackLink({ ...track.mirror, title: track.mirror.title ?? '?' }, 120))
          : null,
        track.autoplay ? duyurular.otomatikCalmadan : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .addFields(
      { name: etiketler.sure, value: trackDuration(track), inline: true },
      {
        name: etiketler.isteyen,
        value: track.autoplay ? etiketler.otomatikCalma : requesterMention(track),
        inline: true,
      },
    )
    .setFooter({
      text: kontrol.durum(etiketler.tekrar[state?.repeatMode] ?? etiketler.tekrar.off, Boolean(state?.paused)),
    });
  if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);
  return embed;
}

/** The parts of a player the buttons depend on, without building a whole getState(). */
function playerSignature(player) {
  if (!player) return 'yok';
  return controlSignature({
    current: player.queue.current,
    paused: player.paused,
    repeatMode: player.repeatMode,
    hasPrevious: (player.queue.previous?.length ?? 0) > 0,
    queue: player.queue.tracks,
  });
}

/**
 * Posts "now playing" and queue messages to the text channel a player was started from.
 * The previous now-playing message is deleted so the channel does not fill up (if that fails,
 * its buttons are removed). While a song plays its message is edited when the buttons'
 * state changes (pause, repeat, queue). Sets `context.nowPlaying.isCurrent(guildId, messageId)`
 * so the button handler can refuse clicks on old messages.
 */
export function startAnnouncer(context) {
  const { client, music, config, logger } = context;
  /** guildId -> { message, track, signature, timer } */
  const current = new Map();
  /** guildId -> number of the latest trackStarted, so a slow send never wins over a newer one */
  const starts = new Map();

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
    const entry = current.get(guildId);
    current.delete(guildId);
    if (!entry) return;
    clearTimeout(entry.timer);
    await entry.message.delete().catch(() => entry.message.edit({ components: [] }).catch(() => {}));
  }

  function scheduleRefresh(guildId) {
    const entry = current.get(guildId);
    if (!entry || entry.timer) return;
    if (playerSignature(music.getPlayer(guildId)) === entry.signature) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (current.get(guildId) !== entry) return;
      const state = music.getState(guildId);
      if (!state?.current) {
        // The song ended and nothing replaced it (yet): its buttons would do nothing now.
        entry.signature = 'yok';
        entry.message.edit({ components: [] }).catch(() => {});
        return;
      }
      entry.signature = playerSignature(music.getPlayer(guildId));
      entry.message
        .edit({ embeds: [nowPlayingEmbed(entry.track, state)], components: controlRows(state) })
        .catch((error) => logger.debug('"Şimdi çalıyor" güncellenemedi:', error?.message ?? error));
    }, REFRESH_DELAY_MS);
    entry.timer.unref?.();
  }

  context.nowPlaying = {
    /** True when `messageId` is the guild's live "now playing" message. */
    isCurrent(guildId, messageId) {
      const entry = current.get(guildId);
      return Boolean(entry && messageId && entry.message.id === messageId);
    },
  };

  music.on('trackStarted', async (guildId, track) => {
    const seq = (starts.get(guildId) ?? 0) + 1;
    starts.set(guildId, seq);
    await deleteLast(guildId);
    const state = music.getState(guildId);
    const message = await send(guildId, {
      embeds: [nowPlayingEmbed(track, state)],
      components: controlRows(state),
      allowedMentions: { parse: [] },
    });
    if (!message) return;
    // Another track may have started while this message was being sent.
    if (starts.get(guildId) !== seq) {
      await message.delete().catch(() => {});
      return;
    }
    current.set(guildId, { message, track, signature: playerSignature(music.getPlayer(guildId)), timer: null });
    scheduleRefresh(guildId);
  });

  music.on('stateChanged', (guildId) => scheduleRefresh(guildId));

  music.on('autoplayStopped', async (guildId) => {
    await send(guildId, { embeds: [baseEmbed().setDescription(duyurular.otomatikCalmaDurdu(AUTOPLAY_MAX_FAILURES))] });
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
    starts.delete(guildId);
    deleteLast(guildId);
  });

  /** Sends a plain notice to a guild's music text channel (used by the idle watcher). */
  return async function notify(guildId, text) {
    await send(guildId, { embeds: [baseEmbed().setDescription(text)] });
  };
}
