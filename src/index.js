// Botun giriş noktası ("npm start" ya da "node src/index.js"). Ayarları okur, Discord'a bağlanır,
// sorun olursa Türkçe açıklama yazar ve kapanırken her şeyi düzgünce kapatır. Dokunmana gerek yok.

import { DiscordjsErrorCodes } from 'discord.js';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startWithIntentFallback } from './ozellikler/_intentler.js';
import { startPanel } from './panel/index.js';

const logger = createLogger('bot');

/**
 * Prints a short Turkish explanation and exits without a stack trace.
 * Only used before anything network-related was created, so process.exit() is safe here.
 */
function fail(message, code = 1) {
  console.error(`\nHATA: ${message}\n`);
  process.exit(code);
}

/**
 * Closes everything that keeps the process alive (web panel, players, Lavalink socket and
 * reconnect timer, Discord gateway) so Node can exit on its own. Calling process.exit()
 * while sockets are still closing aborts Node on Windows with the libuv assertion
 * "!(handle->flags & UV_HANDLE_CLOSING)".
 */
async function closeAll(context, panel) {
  await panel?.close().catch(() => {});
  if (!context) return;
  context.presence?.stop();
  // Last status write ("running": false) and pending counters, while the guild data is still there.
  context.status?.stop();
  context.masaustu?.stop(); // desktop settings requests (src/ozellikler/_masaustu)
  context.stats?.close();
  context.history?.close();
  context.ozellikler?.kapat(); // scheduler and panel timers, module listeners
  for (const guildId of context.music.activeGuildIds()) {
    await context.music
      .getPlayer(guildId)
      ?.destroy('Bot kapanıyor')
      .catch(() => {});
  }
  context.lavalink.stop(); // stops the reachability poll
  await context.client.destroy().catch(() => {});
}

/** Sets the exit code and lets the event loop drain; force-exits only if something hangs. */
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

function explainLoginError(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? error} ${error?.cause?.code ?? ''}`;
  if (error?.code === DiscordjsErrorCodes.TokenInvalid || /TokenInvalid|401|An invalid token/i.test(text)) {
    return 'Discord token\'ı geçersiz. Developer Portal > Bot > "Reset Token" ile yeni token alıp .env içindeki DISCORD_TOKEN\'a yapıştırın.';
  }
  if (/disallowed intents/i.test(text)) {
    return "Discord gerekli izinleri (intent) reddetti. Developer Portal > Bot > Privileged Gateway Intents bölümünü README'nin 3. adımına göre kontrol edin.";
  }
  if (
    /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|fetch failed|Connect Timeout|socket hang up/i.test(
      text,
    )
  ) {
    return "Discord'a bağlanılamadı. İnternet bağlantınızı kontrol edin; ülkenizde ya da ağınızda Discord engelliyse kullandığınız erişim aracının (VPN vb.) açık olduğundan emin olun.";
  }
  return null;
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} alındı, kapatılıyor...`);
    await closeAll(started?.context, started?.panel);
    exitWhenIdle(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    // When Discord refuses a privileged intent (Developer Portal switch off), the bot starts again
    // without it and only the features that need it are off (src/ozellikler/_intentler.js).
    await startWithIntentFallback({
      start: async ({ allowPrivileged }) => {
        const context = await createApp({ config, logger, allowPrivilegedIntents: allowPrivileged });
        started = { context };
        // Web panel (phase 2). Does nothing when PANEL_ENABLED is not true; never blocks the bot.
        started.panel = await startPanel(context);
        return started;
      },
      login: async ({ context }) => {
        logger.info("Discord'a bağlanılıyor...");
        await context.client.login(config.discord.token);
      },
      stop: ({ context, panel }) => closeAll(context, panel),
      planOf: ({ context }) => context.ozellikler.intentPlan,
      logger,
    });
  } catch (error) {
    const explanation = explainLoginError(error);
    if (!explanation) throw error;
    console.error(`\nHATA: ${explanation}\n`);
    await closeAll(started?.context, started?.panel);
    exitWhenIdle(1);
  }
}

// What main() managed to start, so an unexpected startup error can still close it cleanly.
let started = null;

process.on('unhandledRejection', (reason) => logger.error('Yakalanmamış hata:', reason));

main().catch(async (error) => {
  logger.error('Bot başlatılamadı:', error);
  await closeAll(started?.context, started?.panel);
  exitWhenIdle(1);
});
