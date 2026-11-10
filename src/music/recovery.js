// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Bu dosya Lavalink (ses KAYNAĞI) kapanıp yeniden açılınca çalan
// müziği kaldığı yerden sürdürür; olmazsa kanala Türkçe haber verir. Kanala yazdığı mesajlar
// src/mesajlar.js > duyurular içinde, onları oradan değiştirebilirsin.
// ---------------------------------------------------------------------------------------
//
// The bot's Discord voice connection no longer depends on Lavalink (the bot sends the audio
// itself), so a Lavalink restart only cuts the SOURCE stream of the track that is playing.
// What happens then:
//  1. The player notices the broken source while Lavalink is unreachable ('sourceLost'), or
//     the REST monitor reports the drop first: the player is suspended at its position and
//     flagged "recovering" (MusicService refuses control commands except /stop meanwhile).
//  2. When Lavalink is reachable again, the same track is restarted at that position
//     (paused stays paused) and the channel is told. If the restart fails, the next track plays.
//  3. If Lavalink does not come back within `waitTimeoutMs`: in 24/7 mode the bot stays in the
//     channel with its queue (playback stops), otherwise it leaves. Both are announced.
// /stop (also from the panel), a kick or any other destroy cancels a pending recovery.

import { duyurular } from '../mesajlar.js';
import { trackLink } from '../util/embeds.js';
import { toTrackView } from './MusicService.js';

export function startNodeRecovery({ lavalink, engine, music, config, logger, notify, waitTimeoutMs = 60_000 }) {
  /** guildId -> { player, snapshot: { position, paused }, timer, attempting } */
  const recoveries = new Map();
  let stopped = false;

  function setRecovering(player, value) {
    player?.setData?.('recovering', value);
  }

  function finish(rec) {
    if (recoveries.get(rec.player.guildId) === rec) recoveries.delete(rec.player.guildId);
    clearTimeout(rec.timer);
    if (!rec.player.destroyed) setRecovering(rec.player, false);
  }

  function cancel(guildId, reason) {
    const rec = recoveries.get(guildId);
    if (!rec) return false;
    finish(rec);
    logger.info(`Kaynak kurtarması iptal edildi (${guildId}): ${reason}`);
    return true;
  }

  async function begin(player, snapshot) {
    if (stopped || player.destroyed || !player.queue.current) return;
    const existing = recoveries.get(player.guildId);
    if (existing) {
      // Already waiting with the first, accurate position. If the source is lost again while a
      // restart is in progress, remember it: that attempt's "resumed" would otherwise be final.
      if (existing.attempting) existing.lostAgain = snapshot;
      return;
    }
    const rec = { player, snapshot, timer: null, attempting: false, lostAgain: null };
    recoveries.set(player.guildId, rec);
    setRecovering(player, true);
    await player.suspend().catch(() => {});
    logger.warn(
      `Ses kaynağı koptu (${player.guildId}); ${Math.round(snapshot.position / 1000)}. saniyede bekliyorum, Lavalink dönünce sürecek.`,
    );
    rec.timer = setTimeout(
      () => onTimeout(rec).catch((error) => logger.error('Kurtarma zaman aşımı hatası:', error)),
      waitTimeoutMs,
    );
    rec.timer.unref?.();
    if (lavalink.connected) await attempt(rec);
  }

  async function attempt(rec) {
    if (rec.attempting || recoveries.get(rec.player.guildId) !== rec) return;
    rec.attempting = true;
    const { player, snapshot } = rec;
    const track = player.queue.current;
    try {
      await player.restartCurrent(snapshot.position, { paused: snapshot.paused });
      if (recoveries.get(player.guildId) !== rec) return; // cancelled meanwhile (/stop, kick)
      finish(rec);
      if (rec.lostAgain) {
        // Dropped again during the restart: start over from the newer position.
        await begin(player, rec.lostAgain);
        return;
      }
      logger.info(`Lavalink geri geldi; ${player.guildId} sunucusundaki parça kaldığı yerden sürüyor.`);
      await notify(player.guildId, duyurular.kurtarildi).catch(() => {});
    } catch (error) {
      if (recoveries.get(player.guildId) !== rec) return;
      finish(rec);
      logger.warn(`Parça kaldığı yerden sürdürülemedi (${player.guildId}): ${error?.message ?? error}`);
      await notify(player.guildId, duyurular.kurtarilamadiParca(trackLink(toTrackView(track)))).catch(() => {});
      await player.skip().catch(() => {});
    } finally {
      rec.attempting = false;
    }
  }

  async function onTimeout(rec) {
    if (recoveries.get(rec.player.guildId) !== rec) return;
    finish(rec);
    const { player } = rec;
    if (config.music.twentyFourSeven) {
      logger.warn(
        `Lavalink ${waitTimeoutMs / 1000} sn içinde dönmedi (${player.guildId}); 24/7 açık, kanalda kalıyorum.`,
      );
      await notify(player.guildId, duyurular.kurtarilamadiBekliyorum).catch(() => {});
      await player.stopPlaying().catch(() => {});
    } else {
      logger.warn(`Lavalink ${waitTimeoutMs / 1000} sn içinde dönmedi (${player.guildId}); kanaldan ayrılıyorum.`);
      await notify(player.guildId, duyurular.kurtarilamadiAyrildim).catch(() => {});
      await player.destroy('Müzik sunucusu geri gelmedi').catch(() => {});
    }
  }

  // ------------------------------------------------------------ events

  const onSourceLost = (player, snapshot) => {
    begin(player, snapshot).catch((error) => logger.error('Kaynak kurtarma hatası:', error));
  };
  const onDisconnect = () => {
    for (const player of engine.players.values()) {
      if (!player.queue.current || recoveries.has(player.guildId)) continue;
      begin(player, { position: player.position, paused: player.paused }).catch((error) =>
        logger.error('Kaynak kurtarma hatası:', error),
      );
    }
  };
  const onConnect = () => {
    for (const rec of [...recoveries.values()]) attempt(rec).catch((error) => logger.error('Kurtarma hatası:', error));
  };
  const onPlayerDestroy = (player, reason) => {
    const rec = recoveries.get(player.guildId);
    if (rec && rec.player === player) cancel(player.guildId, `oynatıcı kapatıldı (${reason})`);
  };

  engine.on('sourceLost', onSourceLost);
  engine.on('playerDestroy', onPlayerDestroy);
  lavalink.on('disconnect', onDisconnect);
  lavalink.on('connect', onConnect);
  music.onStopRequest?.((guildId) => cancel(guildId, 'kullanıcı durdurdu'));

  return {
    /** Cancels a pending recovery for a guild. Returns true when one was cancelled. */
    cancel,
    isRecovering: (guildId) => recoveries.has(guildId),
    stop() {
      stopped = true;
      for (const rec of [...recoveries.values()]) finish(rec);
      engine.off('sourceLost', onSourceLost);
      engine.off('playerDestroy', onPlayerDestroy);
      lavalink.off('disconnect', onDisconnect);
      lavalink.off('connect', onConnect);
    },
  };
}
