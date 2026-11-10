// ---------------------------------------------------------------------------------------
// Web panelini başlatır (yalnızca .env'de PANEL_ENABLED=true ise). Normalde dokunmana gerek yok.
// ---------------------------------------------------------------------------------------

// Panel entry point. Express and the panel modules are imported only when the panel
// is enabled, so with PANEL_ENABLED=false nothing web-related is loaded or started.

import { randomToken } from './security.js';

const MIN_SECRET_LENGTH = 32;

/**
 * Starts the web panel inside the bot process when enabled.
 * Sets context.panel = { url } on success. Never throws: the bot keeps working without it.
 * @returns {Promise<null | { url: string, close: () => Promise<void> }>}
 */
export async function startPanel(context, { createApp } = {}) {
  const { config, logger: rootLogger } = context;
  const panel = config.panel;
  const logger = rootLogger.child('panel');
  context.panel = null;

  if (!panel.enabled) {
    logger.debug('Web paneli kapalı (PANEL_ENABLED=false).');
    return null;
  }
  if (!config.discord.clientId || !panel.clientSecret) {
    logger.warn(
      'Web paneli açılmadı: .env içinde DISCORD_CLIENT_ID ve DISCORD_CLIENT_SECRET gerekli (README > Web paneli). Bot normal çalışmaya devam ediyor.',
    );
    return null;
  }

  if (panel.publicUrl.startsWith('https://') && !panel.trustProxy) {
    logger.warn(
      'PANEL_PUBLIC_URL https ile başlıyor ama PANEL_TRUST_PROXY=false. HTTPS bir ters proxy ile sağlanıyorsa PANEL_TRUST_PROXY=true yapın, yoksa giriş çerezi ayarlanamaz.',
    );
  }

  let sessionSecret = panel.sessionSecret;
  if (sessionSecret.length < MIN_SECRET_LENGTH) {
    sessionSecret = randomToken(48);
    logger.warn(
      `PANEL_SESSION_SECRET boş ya da ${MIN_SECRET_LENGTH} karakterden kısa; geçici rastgele bir anahtar üretildi. ` +
        'Bot her yeniden başladığında panel oturumları kapanır. Kalıcı olması için .env dosyasına uzun bir değer yazın.',
    );
  }

  const [{ createPanelApp }, { createDiscordOAuth }] = await Promise.all([import('./server.js'), import('./oauth.js')]);
  const oauth = createDiscordOAuth({
    clientId: config.discord.clientId,
    clientSecret: panel.clientSecret,
    redirectUri: `${panel.publicUrl}/auth/callback`,
  });
  const { app, store } = (createApp ?? createPanelApp)({
    client: context.client,
    music: context.music,
    settings: context.settings,
    config,
    logger,
    oauth,
    sessionSecret,
  });

  return new Promise((resolve) => {
    const server = app.listen(panel.port, panel.host);
    server.once('listening', () => {
      const local = `http://${panel.host.includes(':') ? `[${panel.host}]` : panel.host}:${panel.port}`;
      logger.info(`Web paneli açık: ${panel.publicUrl} (dinlenen adres ${local})`);
      if (!['127.0.0.1', '::1', 'localhost'].includes(panel.host)) {
        logger.warn(
          `Panel ${panel.host} adresini dinliyor, yani ağdaki başka cihazlar da erişebilir. İnternete açacaksanız HTTPS kullanan bir ters proxy kullanın (README).`,
        );
      }
      const handle = {
        url: panel.publicUrl,
        close: () =>
          new Promise((done) => {
            store.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      };
      context.panel = { url: panel.publicUrl };
      resolve(handle);
    });
    server.once('error', (error) => {
      const reason =
        error.code === 'EADDRINUSE'
          ? `${panel.port} portu başka bir program tarafından kullanılıyor (PANEL_PORT ile değiştirin)`
          : error.message;
      logger.error(`Web paneli başlatılamadı: ${reason}. Bot panelsiz çalışmaya devam ediyor.`);
      store.close();
      resolve(null);
    });
  });
}
