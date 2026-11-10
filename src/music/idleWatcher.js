// Ses kanalında kimse kalmayınca botu belirli bir süre sonra kanaldan çıkarır (24/7 kapalıysa).
// Süre .env > LEAVE_WHEN_EMPTY_SECONDS, mesaj src/mesajlar.js > duyurular.

import { Events } from 'discord.js';
import { duyurular } from '../mesajlar.js';

/**
 * Leaves a voice channel some time after the last human leaves it.
 * Disabled entirely when 24/7 mode is on.
 */
export function startIdleWatcher({ client, music, config, logger, notify }) {
  if (config.music.twentyFourSeven) {
    logger.info('24/7 modu açık: bot boş kanallardan ayrılmayacak.');
    return { stop() {} };
  }

  const delayMs = config.music.leaveWhenEmptySeconds * 1000;
  const timers = new Map();

  const cancel = (guildId) => {
    const timer = timers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(guildId);
    }
  };

  const humansIn = (guild, channelId) => {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) return 0;
    return channel.members.filter((member) => !member.user.bot).size;
  };

  const evaluate = (guild) => {
    const player = music.getPlayer(guild.id);
    if (!player?.voiceChannelId) {
      cancel(guild.id);
      return;
    }
    if (humansIn(guild, player.voiceChannelId) > 0) {
      cancel(guild.id);
      return;
    }
    if (timers.has(guild.id)) return;
    timers.set(
      guild.id,
      setTimeout(async () => {
        timers.delete(guild.id);
        const current = music.getPlayer(guild.id);
        if (!current?.voiceChannelId || humansIn(guild, current.voiceChannelId) > 0) return;
        logger.info(`Ses kanalı boş kaldı, ayrılıyorum (sunucu ${guild.id}).`);
        await notify(guild.id, duyurular.bosKanaldanAyrildim);
        await current.destroy('Kanal boş kaldı').catch((error) => logger.warn('Oyuncu kapatılamadı:', error?.message));
      }, delayMs),
    );
  };

  const onVoiceState = (oldState, newState) => {
    const guild = newState.guild ?? oldState.guild;
    if (guild) evaluate(guild);
  };

  client.on(Events.VoiceStateUpdate, onVoiceState);
  music.on('playerDestroyed', cancel);

  return {
    stop() {
      client.off(Events.VoiceStateUpdate, onVoiceState);
      music.off('playerDestroyed', cancel);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
