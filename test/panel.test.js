import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ErrorCodes, MusicError } from '../src/music/errors.js';
import { startPanel } from '../src/panel/index.js';
import { OAuthError } from '../src/panel/oauth.js';
import { createPanelApp } from '../src/panel/server.js';
import { PanelSessionStore } from '../src/panel/sessionStore.js';

const ORIGIN = 'http://panel.test';
const USER = '111111111111111111';
const GUILD = '222222222222222222';
const NOT_MEMBER_GUILD = '333333333333333333';
const BOT_ABSENT_GUILD = '444444444444444444';
const VOICE_A = '555555555555555551';
const VOICE_B = '555555555555555552';
const DJ_ROLE = '666666666666666666';
const OTHER_USER = '777777777777777777';
const GOOD_CODE = 'good-code-0123456789';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- fakes

function fakeGuild(id, { members, voice }) {
  const guild = {
    id,
    name: `Sunucu ${id.slice(-1)}`,
    icon: null,
    voiceStates: { cache: voice },
    channels: { cache: new Map() },
    members: {
      me: { id: 'bot', voice: { channelId: null } },
      fetch: async ({ user }) => {
        if (members.has(user)) return { id: user, roles: guild.memberRoles.get(user) ?? [] };
        throw Object.assign(new Error('Unknown Member'), { code: 10007 });
      },
    },
  };
  for (const [channelId, name] of [
    [VOICE_A, 'Genel'],
    [VOICE_B, 'Oyun'],
  ]) {
    guild.channels.cache.set(channelId, {
      id: channelId,
      name,
      guild,
      full: false,
      isVoiceBased: () => true,
      permissionsFor: () => ({ has: () => true }),
    });
  }
  guild.memberIds = members; // tests can remove someone from the server
  guild.memberRoles = new Map(); // userId -> role ids (DJ tests)
  return guild;
}

function createWorld() {
  const voice = new Map();
  const client = new EventEmitter();
  client.isReady = () => true;
  client.guilds = {
    cache: new Map([
      [GUILD, fakeGuild(GUILD, { members: new Set([USER]), voice })],
      [NOT_MEMBER_GUILD, fakeGuild(NOT_MEMBER_GUILD, { members: new Set(), voice: new Map() })],
    ]),
  };

  const music = new EventEmitter();
  music.player = null;
  music.queue = [];
  music.calls = [];
  music.failNext = null;
  music.getPlayer = (guildId) => (guildId === GUILD ? music.player : null);
  music.getState = (guildId) =>
    guildId === GUILD && music.player
      ? {
          guildId,
          voiceChannelId: music.player.voiceChannelId,
          playing: true,
          paused: false,
          volume: 80,
          repeatMode: 'off',
          position: 1000,
          positionAt: Date.now(),
          current: { title: 'Kuzu Kuzu', author: 'Tarkan', duration: 200_000, uri: 'https://youtu.be/x' },
          queue: music.queue,
          queueDuration: 0,
        }
      : null;
  for (const method of ['pause', 'resume', 'skip', 'stop', 'shuffle', 'setRepeatMode', 'setVolume', 'remove']) {
    music[method] = async (...args) => {
      if (music.failNext) {
        const error = music.failNext;
        music.failNext = null;
        throw error;
      }
      music.calls.push([method, ...args]);
    };
  }
  music.play = async (options) => {
    music.calls.push(['play', options]);
    return { kind: 'track', tracks: [{ title: 'Eklenen' }], playlistName: null };
  };

  const oauth = {
    revoked: [],
    authorizeUrl: (state) => `https://discord.test/oauth2/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: async (code) => {
      if (code !== GOOD_CODE) throw new OAuthError('bad code', 400);
      return { access_token: 'SECRET-ACCESS-TOKEN', token_type: 'Bearer' };
    },
    fetchUser: async () => ({ id: USER, username: 'kullanici', global_name: 'Kullanıcı', avatar: null }),
    fetchGuilds: async () => [
      { id: GUILD, name: 'Test', icon: null },
      { id: NOT_MEMBER_GUILD, name: 'Diğer', icon: null },
      { id: BOT_ABSENT_GUILD, name: 'Botsuz', icon: null },
    ],
    revoke: async (token) => oauth.revoked.push(token),
  };

  const config = {
    discord: { clientId: '999999999999999999' },
    panel: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      publicUrl: ORIGIN,
      clientSecret: 'x',
      sessionSecret: 'y'.repeat(40),
      trustProxy: false,
    },
  };
  const settings = { djRoleId: null, getDjRole: () => settings.djRoleId };
  return { client, music, oauth, config, voice, settings };
}

// ---------------------------------------------------------------- http helpers

/** Tiny cookie-aware HTTP client against the test server. */
function browser(base) {
  const jar = new Map();
  async function request(path, { method = 'GET', headers = {}, body, rawBody } = {}) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [name, ...rest] = pair.split('=');
      jar.set(name.trim(), rest.join('='));
    }
    return response;
  }
  return { request, jar };
}

async function login(b) {
  const start = await b.request('/auth/login');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const done = await b.request(`/auth/callback?code=${GOOD_CODE}&state=${encodeURIComponent(state)}`);
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/servers');
  const me = await (await b.request('/api/me')).json();
  return me.csrfToken;
}

/** Opens the SSE endpoint and lets a test await events one by one. */
async function openStream(base, b, guildId) {
  const controller = new AbortController();
  const cookie = [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await fetch(`${base}/api/guilds/${guildId}/events`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let all = '';
  let buffer = '';
  let ended = false;
  return {
    response,
    text: () => all,
    get ended() {
      return ended;
    },
    /** Resolves with the next { event, data }, or null when the server closed the stream. */
    async next(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const chunk = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (chunk.startsWith(':')) continue; // heartbeat
          const event = chunk.match(/^event: (.+)$/m)?.[1];
          const data = chunk.match(/^data: (.+)$/m)?.[1];
          return { event, data: data ? JSON.parse(data) : null };
        }
        const { value, done } = await reader.read();
        if (done) {
          ended = true;
          return null;
        }
        const piece = decoder.decode(value);
        all += piece;
        buffer += piece;
      }
      throw new Error('SSE event timeout');
    },
    close: () => controller.abort(),
  };
}

function post(b, path, csrf, body = {}, { origin = ORIGIN } = {}) {
  return b.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body,
  });
}

// ---------------------------------------------------------------- tests

describe('web panel', () => {
  let world;
  let server;
  let base;
  let store;

  before(async () => {
    world = createWorld();
    const built = createPanelApp({
      ...world,
      logger: silent,
      sessionSecret: world.config.panel.sessionSecret,
      limits: { auth: 10_000, api: 10_000, action: 10_000 },
    });
    store = built.store;
    server = built.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    world.music.player = null;
    world.music.queue = [];
    world.music.calls.length = 0;
    world.voice.clear();
    world.settings.djRoleId = null;
    world.client.guilds.cache.get(GUILD).memberRoles.clear();
  });

  describe('without login', () => {
    it('serves the login page with security headers', async () => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Discord ile giriş yap/);
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('x-powered-by'), null);
    });

    it('redirects protected pages to the login page', async () => {
      for (const path of ['/servers', `/servers/${GUILD}`]) {
        const res = await fetch(base + path, { redirect: 'manual' });
        assert.equal(res.status, 302, path);
        assert.equal(res.headers.get('location'), '/');
      }
    });

    it('answers 401 on every protected API route', async () => {
      const b = browser(base);
      for (const [method, path] of [
        ['GET', '/api/me'],
        ['GET', '/api/guilds'],
        ['GET', `/api/guilds/${GUILD}`],
        ['GET', `/api/guilds/${GUILD}/events`],
        ['POST', `/api/guilds/${GUILD}/actions/pause`],
        ['POST', '/auth/logout'],
      ]) {
        const res = await b.request(path, { method, headers: { Origin: ORIGIN } });
        assert.equal(res.status, 401, `${method} ${path}`);
      }
    });
  });

  describe('OAuth2 state', () => {
    it('sends a random state and an httpOnly SameSite=Lax cookie', async () => {
      const res = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      const state = new URL(res.headers.get('location')).searchParams.get('state');
      assert.ok(state.length >= 32);
      const cookie = res.headers.getSetCookie().join(';');
      assert.match(cookie, /muzikbot\.sid=/);
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
    });

    it('rejects a callback with a wrong state', async () => {
      const b = browser(base);
      await b.request('/auth/login');
      const res = await b.request(`/auth/callback?code=${GOOD_CODE}&state=yanlis`);
      assert.equal(res.headers.get('location'), '/?hata=durum');
      assert.equal((await b.request('/api/me')).status, 401);
    });

    it('rejects a callback that never started a login (no session)', async () => {
      const res = await fetch(`${base}/auth/callback?code=${GOOD_CODE}&state=abc`, { redirect: 'manual' });
      assert.equal(res.headers.get('location'), '/?hata=durum');
    });

    it('logs in with the right state, rotates the session id and hides the access token', async () => {
      const b = browser(base);
      await b.request('/auth/login');
      const before = b.jar.get('muzikbot.sid');
      const csrf = await login(b);
      assert.notEqual(b.jar.get('muzikbot.sid'), before, 'session id must change after login');
      assert.ok(csrf.length >= 32);
      const body = await (await b.request('/api/me')).text();
      assert.match(body, /kullanici/);
      assert.doesNotMatch(body, /SECRET-ACCESS-TOKEN/);
    });

    it('a state can only be used once', async () => {
      const b = browser(base);
      const start = await b.request('/auth/login');
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      await b.request(`/auth/callback?code=bad-code-0123456789&state=${state}`);
      const replay = await b.request(`/auth/callback?code=${GOOD_CODE}&state=${state}`);
      assert.equal(replay.headers.get('location'), '/?hata=durum');
    });

    it('a failed token exchange does not log in', async () => {
      const b = browser(base);
      const start = await b.request('/auth/login');
      const state = new URL(start.headers.get('location')).searchParams.get('state');
      const res = await b.request(`/auth/callback?code=bad-code-0123456789&state=${state}`);
      assert.equal(res.headers.get('location'), '/?hata=giris');
      assert.equal((await b.request('/api/me')).status, 401);
    });
  });

  describe('logged in', () => {
    let b;
    let csrf;
    beforeEach(async () => {
      b = browser(base);
      csrf = await login(b);
    });

    it('lists only servers shared with the bot', async () => {
      const { guilds } = await (await b.request('/api/guilds')).json();
      assert.deepEqual(guilds.map((g) => g.id).sort(), [GUILD, NOT_MEMBER_GUILD].sort());
    });

    it('serves the server page', async () => {
      assert.equal((await b.request('/servers')).status, 200);
      assert.equal((await b.request(`/servers/${GUILD}`)).status, 200);
    });

    it('checks membership on the server side', async () => {
      assert.equal((await b.request(`/api/guilds/${GUILD}`)).status, 200);
      assert.equal((await b.request(`/api/guilds/${NOT_MEMBER_GUILD}`)).status, 403);
      assert.equal((await b.request(`/api/guilds/${BOT_ABSENT_GUILD}`)).status, 404);
      assert.equal((await b.request('/api/guilds/abc')).status, 400);
    });

    describe('CSRF', () => {
      beforeEach(() => {
        world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
        world.voice.set(USER, { channelId: VOICE_A });
      });

      it('rejects a missing token', async () => {
        const res = await post(b, `/api/guilds/${GUILD}/actions/pause`, null);
        assert.equal(res.status, 403);
        assert.equal(world.music.calls.length, 0);
      });

      it('rejects a wrong token', async () => {
        const res = await post(b, `/api/guilds/${GUILD}/actions/pause`, 'x'.repeat(43));
        assert.equal(res.status, 403);
      });

      it('rejects a foreign or missing Origin even with the right token', async () => {
        assert.equal(
          (await post(b, `/api/guilds/${GUILD}/actions/pause`, csrf, {}, { origin: 'https://evil.test' })).status,
          403,
        );
        assert.equal((await post(b, `/api/guilds/${GUILD}/actions/pause`, csrf, {}, { origin: null })).status, 403);
        assert.equal(world.music.calls.length, 0);
      });

      it('accepts the right token and origin', async () => {
        const res = await post(b, `/api/guilds/${GUILD}/actions/pause`, csrf);
        assert.equal(res.status, 200);
        assert.deepEqual(world.music.calls, [['pause', GUILD]]);
      });
    });

    describe('same voice channel rule', () => {
      it("lets a member in the bot's channel control playback", async () => {
        world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
        world.voice.set(USER, { channelId: VOICE_A });
        for (const [action, body, call] of [
          ['skip', {}, ['skip', GUILD]],
          ['stop', {}, ['stop', GUILD]],
          ['shuffle', {}, ['shuffle', GUILD]],
          ['resume', {}, ['resume', GUILD]],
          ['loop', { mode: 'queue' }, ['setRepeatMode', GUILD, 'queue']],
          ['volume', { volume: 120 }, ['setVolume', GUILD, 120]],
          ['remove', { position: 2 }, ['remove', GUILD, 2]],
        ]) {
          world.music.calls.length = 0;
          const res = await post(b, `/api/guilds/${GUILD}/actions/${action}`, csrf, body);
          assert.equal(res.status, 200, action);
          assert.deepEqual(world.music.calls, [call]);
        }
        const view = await (await b.request(`/api/guilds/${GUILD}`)).json();
        assert.equal(view.access.canControl, true);
      });

      it('with a DJ role, only DJs, managers or someone alone with the bot may use control actions', async () => {
        world.settings.djRoleId = DJ_ROLE;
        world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
        world.voice.set(USER, { channelId: VOICE_A });
        world.voice.set(OTHER_USER, { channelId: VOICE_A }); // not alone

        const denied = await post(b, `/api/guilds/${GUILD}/actions/skip`, csrf);
        assert.equal(denied.status, 403);
        assert.match((await denied.json()).error, /Bu komutu kullanma yetkin yok/);
        assert.equal(world.music.calls.length, 0);
        const view = await (await b.request(`/api/guilds/${GUILD}`)).json();
        assert.equal(view.access.canControl, false);
        assert.match(view.access.reason, /DJ/);
        // Adding a song is not a DJ action.
        assert.equal((await post(b, `/api/guilds/${GUILD}/actions/play`, csrf, { query: 'tarkan' })).status, 200);

        world.voice.delete(OTHER_USER); // alone with the bot now
        assert.equal((await post(b, `/api/guilds/${GUILD}/actions/skip`, csrf)).status, 200);

        world.voice.set(OTHER_USER, { channelId: VOICE_A });
        world.client.guilds.cache.get(GUILD).memberRoles.set(USER, [DJ_ROLE]);
        const dj = browser(base); // a new login refreshes the cached member roles
        const djCsrf = await login(dj);
        assert.equal((await post(dj, `/api/guilds/${GUILD}/actions/volume`, djCsrf, { volume: 50 })).status, 200);
      });

      it('makes a member in another voice channel a viewer only', async () => {
        world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
        world.voice.set(USER, { channelId: VOICE_B });
        const res = await post(b, `/api/guilds/${GUILD}/actions/skip`, csrf);
        assert.equal(res.status, 403);
        assert.match((await res.json()).error, /Genel/);
        assert.equal(world.music.calls.length, 0);
        const view = await (await b.request(`/api/guilds/${GUILD}`)).json();
        assert.equal(view.access.canControl, false);
        assert.equal(view.state.current.title, 'Kuzu Kuzu');
      });

      it('makes a member outside voice a viewer only', async () => {
        world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
        const res = await post(b, `/api/guilds/${GUILD}/actions/pause`, csrf);
        assert.equal(res.status, 403);
      });

      it('ignores a voice channel claimed by the client', async () => {
        world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
        world.voice.set(USER, { channelId: VOICE_B });
        const res = await post(b, `/api/guilds/${GUILD}/actions/pause`, csrf, { voiceChannelId: VOICE_A });
        assert.equal(res.status, 403);
      });

      it('non-members cannot control', async () => {
        const res = await post(b, `/api/guilds/${NOT_MEMBER_GUILD}/actions/pause`, csrf);
        assert.equal(res.status, 403);
      });

      it("adding a song when the bot is idle joins the user's channel", async () => {
        world.voice.set(USER, { channelId: VOICE_B });
        const res = await post(b, `/api/guilds/${GUILD}/actions/play`, csrf, { query: 'tarkan' });
        assert.equal(res.status, 200);
        const [[name, options]] = world.music.calls;
        assert.equal(name, 'play');
        assert.equal(options.voiceChannelId, VOICE_B);
        assert.equal(options.requester.id, USER);
      });
    });

    describe('input validation', () => {
      beforeEach(() => {
        world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
        world.voice.set(USER, { channelId: VOICE_A });
      });

      for (const [action, body] of [
        ['volume', { volume: 999 }],
        ['volume', { volume: '50' }],
        ['loop', { mode: 'sonsuz' }],
        ['remove', { position: 0 }],
        ['play', { query: '' }],
        ['play', { query: 'a'.repeat(501) }],
      ]) {
        it(`${action} ${JSON.stringify(body).slice(0, 40)} -> 400`, async () => {
          const res = await post(b, `/api/guilds/${GUILD}/actions/${action}`, csrf, body);
          assert.equal(res.status, 400);
          assert.equal(world.music.calls.length, 0);
        });
      }

      it('unknown action -> 404', async () => {
        assert.equal((await post(b, `/api/guilds/${GUILD}/actions/format`, csrf)).status, 404);
      });

      it('malformed and oversized bodies -> 400', async () => {
        const headers = { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-CSRF-Token': csrf };
        const path = `/api/guilds/${GUILD}/actions/play`;
        assert.equal((await b.request(path, { method: 'POST', headers, rawBody: '{bozuk' })).status, 400);
        const big = JSON.stringify({ query: 'x'.repeat(10_000) });
        assert.equal((await b.request(path, { method: 'POST', headers, rawBody: big })).status, 400);
      });

      it('maps music errors to HTTP statuses', async () => {
        world.music.failNext = new MusicError(ErrorCodes.NOTHING_PLAYING, 'Şu anda çalan bir şarkı yok.');
        const res = await post(b, `/api/guilds/${GUILD}/actions/pause`, csrf);
        assert.equal(res.status, 409);
        assert.equal((await res.json()).error, 'Şu anda çalan bir şarkı yok.');
      });
    });

    it('streams live state over SSE, sending the full queue only when it changes', async () => {
      world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
      world.voice.set(USER, { channelId: VOICE_A });
      world.music.queue = [{ title: 'Dudu', uri: 'https://youtu.be/d', duration: 1 }];
      const stream = await openStream(base, b, GUILD);
      try {
        assert.equal(stream.response.status, 200);
        assert.match(stream.response.headers.get('content-type'), /text\/event-stream/);

        const first = await stream.next();
        assert.equal(first.event, 'state');
        assert.equal(first.data.access.canControl, true);
        assert.equal(first.data.state.queue.length, 1);

        // Position/pause style update, queue unchanged -> small "status" event without the queue.
        world.music.emit('stateChanged', GUILD);
        const tickEvent = await stream.next();
        assert.equal(tickEvent.event, 'status');
        assert.equal('queue' in tickEvent.data.state, false);
        assert.equal(tickEvent.data.state.current.title, 'Kuzu Kuzu');

        // Queue changed -> full "state" event again.
        world.music.queue = [...world.music.queue, { title: 'Gülümse', uri: 'https://youtu.be/g', duration: 2 }];
        world.music.emit('stateChanged', GUILD);
        const changed = await stream.next();
        assert.equal(changed.event, 'state');
        assert.equal(changed.data.state.queue.length, 2);
        assert.doesNotMatch(stream.text(), /SECRET-ACCESS-TOKEN/);
      } finally {
        stream.close();
      }
    });

    it('logout needs CSRF, revokes the Discord token and ends the session', async () => {
      assert.equal((await post(b, '/auth/logout', null)).status, 403);
      const res = await post(b, '/auth/logout', csrf);
      assert.equal(res.status, 200);
      assert.ok(world.oauth.revoked.includes('SECRET-ACCESS-TOKEN'));
      assert.equal((await b.request('/api/me')).status, 401);
    });
  });
});

describe('SSE membership re-check', () => {
  it('closes the stream once the user is no longer a member of the server', async () => {
    const world = createWorld();
    world.music.player = { voiceChannelId: VOICE_A, textChannelId: null };
    const { app, store } = createPanelApp({
      ...world,
      logger: silent,
      sessionSecret: 'r'.repeat(40),
      sseRecheckMs: 100,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const b = browser(base);
      await login(b);
      const stream = await openStream(base, b, GUILD);
      assert.equal((await stream.next()).event, 'state');

      // Still a member: re-checks pass and nothing is sent or closed.
      await tick(250);
      assert.equal(stream.ended, false);

      // Kicked from the server (the bot's REST lookup now answers Unknown Member).
      world.client.guilds.cache.get(GUILD).memberIds.delete(USER);
      let event = await stream.next();
      while (event && event.event !== 'revoked') event = await stream.next();
      assert.equal(event?.event, 'revoked');
      assert.match(event.data.error, /üyesi değilsiniz/);
      assert.equal(await stream.next(), null, 'server ends the stream');
    } finally {
      store.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('panel rate limits', () => {
  it('limits the login route', async () => {
    const world = createWorld();
    const { app, store } = createPanelApp({
      ...world,
      logger: silent,
      sessionSecret: 'z'.repeat(40),
      limits: { auth: 5, action: 3 },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const statuses = [];
      for (let i = 0; i < 8; i++) statuses.push((await fetch(`${base}/auth/login`, { redirect: 'manual' })).status);
      assert.deepEqual(statuses.slice(0, 5), [302, 302, 302, 302, 302]);
      assert.equal(statuses.at(-1), 429);
    } finally {
      store.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('startPanel', () => {
  const context = () => {
    const world = createWorld();
    return { ...world, logger: silent };
  };

  it('does not start anything when PANEL_ENABLED=false', async () => {
    const ctx = context();
    ctx.config = { ...ctx.config, panel: { ...ctx.config.panel, enabled: false } };
    let built = false;
    const handle = await startPanel(ctx, { createApp: () => (built = true) });
    assert.equal(handle, null);
    assert.equal(built, false);
    assert.equal(ctx.panel, null);
  });

  it('never even loads Express when disabled', () => {
    // Child process with a module resolve hook that records every specifier.
    const panelUrl = new URL('../src/panel/index.js', import.meta.url).href;
    const script = `
      import { registerHooks } from 'node:module';
      const seen = [];
      registerHooks({ resolve(specifier, context, next) { seen.push(specifier); return next(specifier, context); } });
      const { startPanel } = await import(${JSON.stringify(panelUrl)});
      const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
      const ctx = { logger: silent, config: { discord: { clientId: '1' }, panel: { enabled: false } } };
      const result = await startPanel(ctx);
      console.log(JSON.stringify({ result, express: seen.filter((s) => /express|server\\.js/.test(s)) }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(output.result, null);
    assert.deepEqual(output.express, []);
  });

  it('does not start without DISCORD_CLIENT_SECRET', async () => {
    const ctx = context();
    ctx.config = { ...ctx.config, panel: { ...ctx.config.panel, clientSecret: '' } };
    let built = false;
    assert.equal(await startPanel(ctx, { createApp: () => (built = true) }), null);
    assert.equal(built, false);
  });

  it('starts on its own without a Discord token and serves the login page', async () => {
    const ctx = context();
    const warnings = [];
    ctx.logger = { ...silent, child: () => ({ ...silent, warn: (m) => warnings.push(m) }) };
    ctx.config = { ...ctx.config, panel: { ...ctx.config.panel, sessionSecret: '' } };
    let port;
    const handle = await startPanel(ctx, {
      createApp: (deps) => {
        const built = createPanelApp(deps);
        const listen = built.app.listen.bind(built.app);
        built.app.listen = (...args) => {
          const server = listen(...args);
          server.once('listening', () => (port = server.address().port));
          return server;
        };
        return built;
      },
    });
    try {
      assert.ok(handle);
      assert.equal(ctx.panel.url, ORIGIN);
      assert.ok(
        warnings.some((w) => /PANEL_SESSION_SECRET/.test(w)),
        'warns about the generated secret',
      );
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
    } finally {
      await handle?.close();
    }
  });
});

describe('PanelSessionStore', () => {
  it('expires and caps sessions', () => {
    const store = new PanelSessionStore({ maxSessions: 2 });
    const past = { cookie: { expires: new Date(Date.now() - 1000).toISOString() } };
    const future = { cookie: { expires: new Date(Date.now() + 60_000).toISOString() } };
    store.set('old', past);
    store.get('old', (_e, s) => assert.equal(s, null));
    store.set('a', future);
    store.set('b', future);
    store.set('c', future);
    assert.equal(store.size, 2);
    store.get('c', (_e, s) => assert.ok(s));
    store.close();
  });
});
