// Botun bütün parçalarını birleştirir (Discord, Lavalink, komutlar, duyurular, ayarlar).
// Normalde bu dosyaya dokunmana gerek yok.

import { join } from 'node:path';
import { Client, Events } from 'discord.js';
import { startAnnouncer } from './bot/announcer.js';
import { registerInteractionHandler } from './bot/interactions.js';
import { createOwnerCheck } from './bot/owner.js';
import { startPresence } from './bot/presence.js';
import { humansInVoice } from './bot/dj.js';
import { attachStatusFile } from './bot/durumDosyasi.js';
import { createHistoryStore } from './bot/gecmis.js';
import { createStatsStore } from './bot/istatistik.js';
import { createPlaylistStore } from './bot/listeler.js';
import { createServerSettings } from './bot/serverSettings.js';
import { loadCommands } from './commands/index.js';
import { PROJECT_ROOT } from './config.js';
import { durum } from './gorunum.js';
import { createVoiceEngine } from './music/engine.js';
import { findFfmpeg } from './music/ffmpeg.js';
import { startIdleWatcher } from './music/idleWatcher.js';
import { createLavalinkManager } from './music/lavalink.js';
import { MusicService } from './music/MusicService.js';
import { planIntents } from './ozellikler/_intentler.js';
import { createOzellikler, loadModules } from './ozellikler/index.js';
import { attachDesktopBridge } from './ozellikler/_masaustu/kopru.js';
import { startNodeRecovery } from './music/recovery.js';
import { setEmbedColor } from './util/embeds.js';

/** Where per-server settings such as the DJ role are kept. */
export const SETTINGS_FILE = join(PROJECT_ROOT, 'data', 'sunucular.json');
/** Live status for the desktop app (servers, statistics); see src/bot/durumDosyasi.js. */
export const STATUS_FILE = join(PROJECT_ROOT, 'data', 'durum.json');
/** Play/command counters kept across restarts; see src/bot/istatistik.js. */
export const STATS_FILE = join(PROJECT_ROOT, 'data', 'istatistik.json');
/** Recently played songs per server (/gecmis, autoplay); see src/bot/gecmis.js. */
export const HISTORY_FILE = join(PROJECT_ROOT, 'data', 'gecmis.json');
/** Saved playlists per server (/liste); see src/bot/listeler.js. */
export const PLAYLISTS_FILE = join(PROJECT_ROOT, 'data', 'listeler.json');
/** Settings of the feature modules (/ayar); see src/ozellikler/ayarlar/depo.js. */
export const FEATURE_SETTINGS_FILE = join(PROJECT_ROOT, 'data', 'ozellikler.json');
/** Planned jobs of the feature modules; see src/ozellikler/_zamanlayici.js. */
export const SCHEDULER_FILE = join(PROJECT_ROOT, 'data', 'zamanlayici.json');
/** Fixed control panel messages (/ayar panel); see src/ozellikler/menu/panel.js. */
export const PANELS_FILE = join(PROJECT_ROOT, 'data', 'paneller.json');
/**
 * Where the desktop app's settings files live (sunucu-yapisi.json, ayar-semasi.json, ayarlar-gorunum.json,
 * istekler/, yanitlar/); see src/ozellikler/_masaustu/kopru.js.
 */
export const DESKTOP_DATA_DIR = join(PROJECT_ROOT, 'data');

/**
 * Builds the whole bot without logging in. The returned context is what commands and the
 * web panel receive: they talk to `context.music` (MusicService), never to the voice engine or Lavalink.
 * @param {{ allowPrivilegedIntents?: boolean }} options false after Discord refused a privileged
 *   intent: the features that need it are switched off (src/ozellikler/_intentler.js)
 */
export async function createApp({ config, logger, allowPrivilegedIntents = true }) {
  setEmbedColor(config.embedColor);

  // Music needs Guilds + GuildVoiceStates; other intents are only asked for when a feature module needs them.
  const modules = await loadModules();
  const intentPlan = planIntents(modules, { allowPrivileged: allowPrivilegedIntents });
  // Partials only when a module asks for them (e.g. kayit: deleted messages that were never cached).
  const client = new Client({ intents: intentPlan.intents, partials: intentPlan.partials });

  // Lavalink is used over REST only (search, YouTube audio stream, lyrics); the voice engine
  // sends the audio to Discord itself (README > Teknik notlar).
  const lavalink = createLavalinkManager(client, config, logger.child('lavalink'));
  const engine = createVoiceEngine({
    client,
    rest: lavalink,
    config,
    logger: logger.child('ses'),
    // The bot joins undeafened only where voice commands are on and installed (src/ozellikler/sesli-komut).
    playerOptions: { listening: (guildId) => context.sesliKomut?.listening(guildId) ?? false },
  });
  const settings = createServerSettings({ file: SETTINGS_FILE, logger: logger.child('ayarlar') });
  const history = createHistoryStore({ file: HISTORY_FILE, logger: logger.child('geçmiş') });
  const playlists = createPlaylistStore({ file: PLAYLISTS_FILE, logger: logger.child('listeler') });
  const music = new MusicService({
    lavalink,
    engine,
    config,
    logger: logger.child('müzik'),
    history,
    settings,
    // Autoplay adds nothing to an empty channel; the idle watcher's leave rules stay as they are.
    hasListeners: (guildId, channelId) => {
      const guild = client.guilds.cache.get(guildId);
      return Boolean(guild) && humansInVoice(guild, channelId).length > 0;
    },
  });
  const commands = await loadCommands();
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
    history,
    playlists,
    isOwner,
    stats,
    status: null, // data/durum.json writer; started on login, stopped by index.js on shutdown
    presence: null, // set on login; index.js stops its timer on shutdown
    nowPlaying: null, // set by the announcer: which message carries the live control buttons
    ozellikler: null, // feature modules (src/ozellikler/index.js): settings, scheduler, panel, components
    masaustu: null, // settings bridge to the desktop app; started on login, stopped by index.js on shutdown
    sesliKomut: null, // voice commands (src/ozellikler/sesli-komut/yonetici.js), set by that module
    startedAt: Date.now(),
  };

  createOzellikler({
    context,
    modules,
    intentPlan,
    files: { ayarlar: FEATURE_SETTINGS_FILE, zamanlayici: SCHEDULER_FILE, paneller: PANELS_FILE },
    logger: logger.child('özellikler'),
  });
  registerInteractionHandler(context);
  context.status = attachStatusFile(context, { file: STATUS_FILE });
  context.masaustu = attachDesktopBridge(context, { dataDir: DESKTOP_DATA_DIR });
  const notify = startAnnouncer(context);
  startIdleWatcher({ client, music, config, logger: logger.child('boşta'), notify });
  startNodeRecovery({ lavalink, engine, music, config, logger: logger.child('kurtarma'), notify });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Discord'a giriş yapıldı: ${readyClient.user.tag} (${readyClient.guilds.cache.size} sunucu)`);
    context.presence = startPresence(readyClient, durum, logger);
    context.status.start();
    context.masaustu.start();
    lavalink.start();
    context.ozellikler.baslat().catch((error) => logger.error('Özellikler başlatılamadı:', error?.message ?? error));
    const ffmpeg = await findFfmpeg();
    if (ffmpeg) logger.info(`ffmpeg: ${ffmpeg === 'ffmpeg' ? 'sistemdeki ffmpeg' : ffmpeg}`);
    else
      logger.error('ffmpeg bulunamadı: ses çalınamaz. ffmpeg kurun ya da "npm install" ile ffmpeg-static indirilsin.');
  });

  client.on(Events.Error, (error) => logger.error('Discord istemci hatası:', error?.message ?? error));
  client.on(Events.Warn, (message) => logger.warn('Discord uyarısı:', message));

  return context;
}
