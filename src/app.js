// Botun bütün parçalarını birleştirir (Discord, Lavalink, komutlar, duyurular, ayarlar).
// Normalde bu dosyaya dokunmana gerek yok.

import { join } from 'node:path';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { startAnnouncer } from './bot/announcer.js';
import { registerInteractionHandler } from './bot/interactions.js';
import { createOwnerCheck } from './bot/owner.js';
import { startPresence } from './bot/presence.js';
import { attachStatusFile } from './bot/durumDosyasi.js';
import { createStatsStore } from './bot/istatistik.js';
import { createServerSettings } from './bot/serverSettings.js';
import { loadCommands } from './commands/index.js';
import { PROJECT_ROOT } from './config.js';
import { durum } from './gorunum.js';
import { createVoiceEngine } from './music/engine.js';
import { findFfmpeg } from './music/ffmpeg.js';
import { startIdleWatcher } from './music/idleWatcher.js';
import { createLavalinkManager } from './music/lavalink.js';
import { MusicService } from './music/MusicService.js';
import { startNodeRecovery } from './music/recovery.js';
import { setEmbedColor } from './util/embeds.js';

/** Where per-server settings such as the DJ role are kept. */
export const SETTINGS_FILE = join(PROJECT_ROOT, 'data', 'sunucular.json');
/** Live status for the desktop app (servers, statistics); see src/bot/durumDosyasi.js. */
export const STATUS_FILE = join(PROJECT_ROOT, 'data', 'durum.json');
/** Play/command counters kept across restarts; see src/bot/istatistik.js. */
export const STATS_FILE = join(PROJECT_ROOT, 'data', 'istatistik.json');

/**
 * Builds the whole bot without logging in. The returned context is what commands and the
 * web panel receive: they talk to `context.music` (MusicService), never to the voice engine or Lavalink.
 */
export async function createApp({ config, logger }) {
  setEmbedColor(config.embedColor);

  // Only non-privileged intents: slash commands do not need Message Content.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  // Lavalink is used over REST only (search, YouTube audio stream, lyrics); the voice engine
  // sends the audio to Discord itself (README > Teknik notlar).
  const lavalink = createLavalinkManager(client, config, logger.child('lavalink'));
  const engine = createVoiceEngine({ client, rest: lavalink, config, logger: logger.child('ses') });
  const music = new MusicService({ lavalink, engine, config, logger: logger.child('müzik') });
  const commands = await loadCommands();
  const settings = createServerSettings({ file: SETTINGS_FILE, logger: logger.child('ayarlar') });
  const isOwner = createOwnerCheck({ client, overrideIds: config.discord.ownerIds, logger });
  const stats = createStatsStore({ file: STATS_FILE, logger: logger.child('istatistik') });

  const context = {
    client,
    lavalink,
    engine,
    music,
    commands,
    config,
    logger,
    settings,
    isOwner,
    stats,
    status: null, // data/durum.json writer; started on login, stopped by index.js on shutdown
    presence: null, // set on login; index.js stops its timer on shutdown
    startedAt: Date.now(),
  };

  registerInteractionHandler(context);
  context.status = attachStatusFile(context, { file: STATUS_FILE });
  const notify = startAnnouncer(context);
  startIdleWatcher({ client, music, config, logger: logger.child('boşta'), notify });
  startNodeRecovery({ lavalink, engine, music, config, logger: logger.child('kurtarma'), notify });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Discord'a giriş yapıldı: ${readyClient.user.tag} (${readyClient.guilds.cache.size} sunucu)`);
    context.presence = startPresence(readyClient, durum, logger);
    context.status.start();
    lavalink.start();
    const ffmpeg = await findFfmpeg();
    if (ffmpeg) logger.info(`ffmpeg: ${ffmpeg === 'ffmpeg' ? 'sistemdeki ffmpeg' : ffmpeg}`);
    else
      logger.error('ffmpeg bulunamadı: ses çalınamaz. ffmpeg kurun ya da "npm install" ile ffmpeg-static indirilsin.');
  });

  client.on(Events.Error, (error) => logger.error('Discord istemci hatası:', error?.message ?? error));
  client.on(Events.Warn, (message) => logger.warn('Discord uyarısı:', message));

  return context;
}
