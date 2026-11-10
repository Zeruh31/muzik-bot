// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Web panelinin sunucusu: sayfalar, Discord ile giriş, canlı
// güncelleme ve kontrol istekleri. Güvenlik önlemleri (CSRF, istek sınırı, oturum) burada ve
// security.js'de; bunları kaldırmak ya da gevşetmek paneli saldırıya açık bırakır.
// ---------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import { panel as M } from '../mesajlar.js';
import { MusicError } from '../music/errors.js';
import { REPEAT_MODES, VOLUME_MAX, VOLUME_MIN } from '../music/MusicService.js';
import { assertBotCanJoin } from '../util/voice.js';
import { AccessError, createAccess, isSnowflake } from './access.js';
import { OAuthError } from './oauth.js';
import { PanelSessionStore } from './sessionStore.js';
import { randomToken, requireCsrf, safeEqual, securityHeaders } from './security.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');
const SESSION_COOKIE = 'muzikbot.sid';
const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;
const ICON_HASH = /^(a_)?[0-9a-f]{32}$/;
const SSE_THROTTLE_MS = 750;
const SSE_HEARTBEAT_MS = 25_000;
const MAX_STREAMS_PER_SESSION = 6;
const SSE_RECHECK_MS = 60_000;

/** Cheap fingerprint of the queue so the full list is only re-sent when it changed. */
function queueSignature(state) {
  if (!state) return 'yok';
  const hash = createHash('sha1');
  for (const t of state.queue) hash.update(`${t.uri}\u0000${t.title}\u0000${t.duration}\u0001`);
  return `${state.queue.length}:${hash.digest('base64url')}`;
}

/** HTTP status for each MusicError code. */
const MUSIC_STATUS = {
  NODE_UNAVAILABLE: 503,
  NO_PLAYER: 409,
  NOTHING_PLAYING: 409,
  EMPTY_QUEUE: 409,
  QUEUE_FULL: 409,
  INVALID_POSITION: 400,
  INVALID_VALUE: 400,
  NOT_SEEKABLE: 400,
  SOURCE_DISABLED: 400,
  SOURCE_UNSUPPORTED: 400,
  NOT_FOUND: 404,
  LYRICS_UNAVAILABLE: 404,
  LOAD_FAILED: 502,
  VOICE_REQUIRED: 403,
  WRONG_CHANNEL: 403,
  MISSING_PERMISSIONS: 403,
  RECOVERING: 503,
};

function guildIconUrl(id, icon) {
  return icon && ICON_HASH.test(icon) ? `https://cdn.discordapp.com/icons/${id}/${icon}.png?size=96` : null;
}

function userAvatarUrl(user) {
  return user.avatar && ICON_HASH.test(user.avatar)
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : null;
}

/** Validates the JSON body of a control action. Returns the value or throws a 400. */
function parseAction(action, body) {
  const bad = (message) => {
    throw new AccessError(400, message);
  };
  switch (action) {
    case 'pause':
    case 'resume':
    case 'skip':
    case 'stop':
    case 'shuffle':
      return null;
    case 'loop': {
      if (!REPEAT_MODES.includes(body?.mode)) bad(M.tekrarModuGecersiz);
      return body.mode;
    }
    case 'volume': {
      const volume = body?.volume;
      if (!Number.isInteger(volume) || volume < VOLUME_MIN || volume > VOLUME_MAX) {
        bad(M.sesSeviyesiGecersiz(VOLUME_MIN, VOLUME_MAX));
      }
      return volume;
    }
    case 'remove': {
      const position = body?.position;
      if (!Number.isInteger(position) || position < 1 || position > 10_000) bad(M.siraGecersiz);
      return position;
    }
    case 'play': {
      const query = typeof body?.query === 'string' ? body.query.trim() : '';
      if (query.length < 1 || query.length > 500) bad(M.sorguUzunlugu);
      return query;
    }
    default:
      throw new AccessError(404, M.bilinmeyenIslem);
  }
}

/**
 * Builds the panel Express app without listening.
 * @param {{ client, music, settings?, config, logger, oauth, sessionSecret: string, store?: PanelSessionStore }} deps
 *   `oauth` is the Discord OAuth2 client (createDiscordOAuth); tests pass a fake.
 */
export function createPanelApp({
  client,
  music,
  settings,
  config,
  logger,
  oauth,
  sessionSecret,
  store,
  limits = {},
  sseRecheckMs = SSE_RECHECK_MS,
}) {
  const { auth: authLimit = 30, api: apiLimit = 240, action: actionLimit = 60 } = limits;
  const panel = config.panel;
  const secureCookies = panel.publicUrl.startsWith('https://');
  const access = createAccess({ client, music, settings });
  const sessionStore = store ?? new PanelSessionStore();
  const streamsBySession = new Map();

  const app = express();
  app.disable('x-powered-by');
  if (panel.trustProxy) app.set('trust proxy', 'loopback');
  app.use(securityHeaders);
  app.use(
    session({
      name: SESSION_COOKIE,
      secret: sessionSecret,
      store: sessionStore,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: SESSION_MAX_AGE_MS },
    }),
  );

  const limiter = (windowMs, limit) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: M.cokFazlaIstek }),
    });
  const authLimiter = limiter(15 * 60_000, authLimit);
  const apiLimiter = limiter(60_000, apiLimit);
  const actionLimiter = limiter(60_000, actionLimit);
  const csrf = requireCsrf(panel.publicUrl);
  const json = express.json({ limit: '4kb', strict: true });

  const loggedIn = (req) => Boolean(req.session?.user);
  const requireApiLogin = (req, res, next) => (loggedIn(req) ? next() : res.status(401).json({ error: M.girisYapin }));
  const requirePageLogin = (req, res, next) => (loggedIn(req) ? next() : res.redirect(302, '/'));

  // ------------------------------------------------------------------ pages

  const page = (file) => (_req, res) => res.sendFile(join(PUBLIC_DIR, file));
  app.get('/', (req, res, next) => (loggedIn(req) ? res.redirect(302, '/servers') : next()), page('index.html'));
  app.get('/servers', requirePageLogin, page('servers.html'));
  app.get('/servers/:guildId', requirePageLogin, (req, res, next) =>
    isSnowflake(req.params.guildId) ? next() : res.redirect(302, '/servers'),
  );
  app.get('/servers/:guildId', page('server.html'));
  app.use('/static', express.static(join(PUBLIC_DIR, 'static'), { index: false, maxAge: '1h', dotfiles: 'ignore' }));

  // ------------------------------------------------------------------ OAuth2

  app.get('/auth/login', authLimiter, (req, res) => {
    const state = randomToken(24);
    req.session.oauthState = state;
    req.session.save((error) => {
      if (error) return res.redirect(302, '/?hata=oturum');
      res.redirect(302, oauth.authorizeUrl(state));
    });
  });

  app.get('/auth/callback', authLimiter, async (req, res) => {
    const { code, state, error } = req.query;
    const expected = req.session.oauthState;
    delete req.session.oauthState;
    if (error === 'access_denied') return res.redirect(302, '/?hata=iptal');
    if (typeof state !== 'string' || !safeEqual(state, expected)) return res.redirect(302, '/?hata=durum');
    if (typeof code !== 'string' || code.length < 10 || code.length > 200) return res.redirect(302, '/?hata=giris');

    let token;
    let user;
    let guilds;
    try {
      token = await oauth.exchangeCode(code);
      [user, guilds] = await Promise.all([oauth.fetchUser(token.access_token), oauth.fetchGuilds(token.access_token)]);
    } catch (err) {
      logger.warn('Panel girişi başarısız:', err instanceof OAuthError ? err.message : (err?.message ?? err));
      return res.redirect(302, '/?hata=giris');
    }

    // New session id after login (prevents session fixation).
    req.session.regenerate((regenError) => {
      if (regenError) return res.redirect(302, '/?hata=oturum');
      req.session.user = {
        id: String(user.id),
        username: String(user.username ?? ''),
        globalName: user.global_name ? String(user.global_name) : null,
        avatarUrl: userAvatarUrl(user),
      };
      req.session.guilds = (Array.isArray(guilds) ? guilds : [])
        .filter((g) => isSnowflake(String(g.id)))
        .map((g) => ({ id: String(g.id), name: String(g.name ?? ''), icon: g.icon ?? null }));
      // Kept server-side only (session store); never sent to the browser.
      req.session.accessToken = token.access_token;
      req.session.csrfToken = randomToken(32);
      access.forget(req.session.user.id);
      logger.info(`Panele giriş: ${req.session.user.username} (${req.session.user.id})`);
      req.session.save(() => res.redirect(302, '/servers'));
    });
  });

  app.post('/auth/logout', authLimiter, requireApiLogin, csrf, (req, res) => {
    const token = req.session.accessToken;
    const sid = req.sessionID;
    if (token) oauth.revoke(token).catch(() => {});
    for (const stream of streamsBySession.get(sid) ?? []) stream.end();
    streamsBySession.delete(sid);
    req.session.destroy(() => {
      res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookies });
      res.json({ ok: true });
    });
  });

  // ------------------------------------------------------------------ API

  const api = express.Router();
  api.use(apiLimiter, requireApiLogin);

  api.get('/me', (req, res) => {
    res.json({ user: req.session.user, csrfToken: req.session.csrfToken });
  });

  const listGuilds = (req) =>
    (req.session.guilds ?? [])
      .filter((g) => client.guilds.cache.has(g.id))
      .map((g) => {
        const state = music.getState(g.id);
        return {
          id: g.id,
          name: client.guilds.cache.get(g.id)?.name ?? g.name,
          iconUrl: guildIconUrl(g.id, g.icon),
          nowPlaying: state?.current?.title ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));

  api.get('/guilds', (req, res) => {
    res.json({ guilds: listGuilds(req), botReady: client.isReady?.() ?? false });
  });

  api.post('/guilds/refresh', actionLimiter, csrf, async (req, res) => {
    try {
      const guilds = await oauth.fetchGuilds(req.session.accessToken);
      req.session.guilds = (Array.isArray(guilds) ? guilds : [])
        .filter((g) => isSnowflake(String(g.id)))
        .map((g) => ({ id: String(g.id), name: String(g.name ?? ''), icon: g.icon ?? null }));
    } catch (error) {
      if (error instanceof OAuthError && error.status === 401) {
        return res.status(401).json({ error: M.oturumDoldu });
      }
      throw error;
    }
    res.json({ guilds: listGuilds(req), botReady: client.isReady?.() ?? false });
  });

  const guildView = (guild, userId) => ({
    guild: { id: guild.id, name: guild.name, iconUrl: guildIconUrl(guild.id, guild.icon) },
    state: music.getState(guild.id),
    access: access.voiceAccess(guild, userId),
  });

  api.get('/guilds/:guildId', async (req, res) => {
    const guild = await access.requireView(req.session.user.id, req.params.guildId);
    res.json(guildView(guild, req.session.user.id));
  });

  // Live updates with Server-Sent Events: one-way, plain HTTP, no client library needed.
  api.get('/guilds/:guildId/events', async (req, res) => {
    const userId = req.session.user.id;
    const guild = await access.requireView(userId, req.params.guildId);
    const sid = req.sessionID;
    const streams = streamsBySession.get(sid) ?? new Set();
    if (streams.size >= MAX_STREAMS_PER_SESSION) {
      return res.status(429).json({ error: M.cokFazlaSekme });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    streams.add(res);
    streamsBySession.set(sid, streams);

    // Two event types keep frequent updates small:
    //  - "state":  full view including the queue (first message, and whenever the queue changed)
    //  - "status": same view without the queue (position ticks, pause, volume, voice changes)
    let timer = null;
    let lastSent = 0;
    let lastQueueKey;
    const send = () => {
      timer = null;
      lastSent = Date.now();
      const view = guildView(guild, userId);
      const queueKey = queueSignature(view.state);
      if (queueKey !== lastQueueKey || !view.state) {
        lastQueueKey = queueKey;
        res.write(`event: state\ndata: ${JSON.stringify(view)}\n\n`);
      } else {
        const { queue: _queue, ...status } = view.state;
        res.write(`event: status\ndata: ${JSON.stringify({ ...view, state: status })}\n\n`);
      }
    };
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(send, Math.max(0, SSE_THROTTLE_MS - (Date.now() - lastSent)));
    };
    const onState = (guildId) => guildId === guild.id && schedule();
    const onVoice = (oldState, newState) => (newState.guild ?? oldState.guild)?.id === guild.id && schedule();
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);

    // Membership is re-checked while the stream is open: someone who left or was kicked
    // from the server stops receiving updates. Network hiccups keep the stream alive.
    const recheck = setInterval(async () => {
      try {
        await access.requireView(userId, guild.id, { fresh: true });
      } catch (error) {
        if (!(error instanceof AccessError)) return;
        res.write(`event: revoked\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
      }
    }, sseRecheckMs);

    music.on('stateChanged', onState);
    client.on('voiceStateUpdate', onVoice);
    send();

    res.on('close', () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearInterval(recheck);
      music.off('stateChanged', onState);
      client.off('voiceStateUpdate', onVoice);
      streams.delete(res);
      if (streams.size === 0) streamsBySession.delete(sid);
    });
  });

  api.post('/guilds/:guildId/actions/:action', actionLimiter, csrf, json, async (req, res) => {
    const { guildId, action } = req.params;
    const user = req.session.user;
    const value = parseAction(action, req.body);
    const { guild, voice } = await access.requireControl(user.id, guildId, action);

    switch (action) {
      case 'pause':
        await music.pause(guild.id);
        break;
      case 'resume':
        await music.resume(guild.id);
        break;
      case 'skip':
        await music.skip(guild.id);
        break;
      case 'stop':
        await music.stop(guild.id);
        break;
      case 'shuffle':
        await music.shuffle(guild.id);
        break;
      case 'loop':
        await music.setRepeatMode(guild.id, value);
        break;
      case 'volume':
        await music.setVolume(guild.id, value);
        break;
      case 'remove':
        await music.remove(guild.id, value);
        break;
      case 'play': {
        const channel = guild.channels.cache.get(voice.userVoiceChannelId);
        if (!channel?.isVoiceBased?.()) throw new AccessError(403, M.sesKanaliBulunamadi);
        const player = music.getPlayer(guild.id);
        assertBotCanJoin(channel, { alreadyConnected: Boolean(player), mention: false });
        const result = await music.play({
          guildId: guild.id,
          voiceChannelId: channel.id,
          textChannelId: player?.textChannelId ?? undefined,
          query: value,
          requester: { id: user.id, username: user.username, globalName: user.globalName },
        });
        return res.json({
          ok: true,
          added: result.tracks.length,
          kind: result.kind,
          title: result.kind === 'playlist' ? result.playlistName : result.tracks[0]?.title,
        });
      }
    }
    res.json({ ok: true });
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: M.bulunamadi }));

  // ------------------------------------------------------------------ errors

  app.use((_req, res) => res.status(404).type('text/plain; charset=utf-8').send(M.sayfaBulunamadi));

  // Express 5 forwards rejected promises from async handlers here. The 4th argument
  // must stay: Express recognises error handlers by their arity.
  app.use((error, req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error instanceof AccessError) return res.status(error.status).json({ error: error.message });
    if (error instanceof MusicError) {
      return res.status(MUSIC_STATUS[error.code] ?? 400).json({ error: error.message, code: error.code });
    }
    if (error?.type === 'entity.parse.failed' || error?.type === 'entity.too.large') {
      return res.status(400).json({ error: M.govdeGecersiz });
    }
    logger.error(`Panel hatası (${req.method} ${req.path}):`, error);
    res.status(500).json({ error: M.beklenmeyenHata });
  });

  return { app, store: sessionStore };
}
