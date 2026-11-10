// The thin Lavalink REST client: request shapes, response normalization and the console
// lines the desktop app reads when Lavalink comes and goes.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  LavalinkRequestError,
  LavalinkRest,
  PrefetchStream,
  normalizeLoadResult,
  normalizeTrack,
} from '../src/music/lavalink.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    body: status === 200 ? new ReadableStream({ start: (c) => c.close() }) : null,
    headers: { get: () => null },
  };
}

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function webStreamOf(chunks, { delayMs = 0 } = {}) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++]));
      else controller.close();
    },
  });
}

function restWith(handler) {
  const calls = [];
  const lines = [];
  const logger = {
    debug() {},
    info: (...a) => lines.push(['info', a.join(' ')]),
    warn: (...a) => lines.push(['warn', a.join(' ')]),
    error: (...a) => lines.push(['error', a.join(' ')]),
  };
  const rest = new LavalinkRest({
    host: '127.0.0.1',
    port: 2333,
    password: 'gizli',
    logger,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    },
  });
  return { rest, calls, lines };
}

describe('LavalinkRest', () => {
  it('sends the password and URL-encodes identifiers and tracks', async () => {
    const { rest, calls } = restWith(() => jsonResponse(200, { loadType: 'empty', data: {} }));
    await rest.loadTracks('ytsearch:a b+c');
    await rest.lyrics('QAAA+/b=');
    assert.equal(calls[0].url, 'http://127.0.0.1:2333/v4/loadtracks?identifier=ytsearch%3Aa%20b%2Bc');
    assert.equal(calls[0].init.headers.Authorization, 'gizli');
    assert.equal(calls[1].url, 'http://127.0.0.1:2333/v4/lyrics?track=QAAA%2B%2Fb%3D&skipTrackSource=false');
  });

  it('builds the youtube-plugin stream URL', () => {
    const { rest } = restWith(() => jsonResponse(200));
    assert.equal(rest.streamUrl('dQw4w9WgXcQ'), 'http://127.0.0.1:2333/youtube/stream/dQw4w9WgXcQ');
    assert.equal(
      rest.streamUrl('_VOROSc1VeU', { itag: 140, withClient: 'IOS' }),
      'http://127.0.0.1:2333/youtube/stream/_VOROSc1VeU?itag=140&withClient=IOS',
    );
  });

  it("turns Lavalink error bodies into LavalinkRequestError with Lavalink's message", async () => {
    const { rest } = restWith(() =>
      jsonResponse(500, { status: 500, error: 'Internal Server Error', message: 'This video cannot be loaded' }),
    );
    await assert.rejects(rest.openStream('xxxxxxxxxxx'), (e) => {
      assert.ok(e instanceof LavalinkRequestError);
      assert.equal(e.status, 500);
      assert.equal(e.message, 'This video cannot be loaded');
      return true;
    });
    await assert.rejects(rest.request('/v4/info'), (e) => e instanceof LavalinkRequestError && e.status === 500);
  });

  it('a 204 (no lyrics) resolves to null', async () => {
    const { rest } = restWith(() => ({ ok: true, status: 204, text: async () => '' }));
    assert.equal(await rest.lyrics('abc'), null);
  });

  it('logs the lines the desktop app reads when Lavalink appears and disappears', async () => {
    let up = true;
    const { rest, lines } = restWith((url) => {
      if (!up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      if (url.endsWith('/v4/info')) return jsonResponse(200, { version: { semver: '4.2.2' }, plugins: [] });
      return jsonResponse(200, { uptime: 1, memory: { used: 2 }, cpu: { lavalinkLoad: 0 } });
    });
    const events = [];
    rest.on('connect', () => events.push('connect'));
    rest.on('disconnect', (_n, info) => events.push(`disconnect:${info.reason}`));

    assert.equal(await rest.poll(), true);
    assert.equal(rest.connected, true);
    assert.equal(rest.info.version.semver, '4.2.2');
    assert.deepEqual(lines, [['info', 'Lavalink bağlandı (yerel).']]);

    up = false;
    assert.equal(await rest.poll(), false);
    assert.equal(rest.connected, false);
    assert.match(lines[1][1], /^Lavalink bağlantısı koptu \(yerel\): ECONNREFUSED/);
    assert.deepEqual(events, ['connect', 'disconnect:ECONNREFUSED']);
    rest.stop();
  });

  it('reports a refused password once instead of retrying silently', async () => {
    const { rest, lines } = restWith(() => jsonResponse(401, { status: 401, error: 'Unauthorized' }));
    assert.equal(await rest.poll(), false);
    assert.match(lines[0][1], /şifreyi reddetti/);
    rest.stop();
  });
});

describe('normalizeLoadResult', () => {
  it('maps the Lavalink v4 load types to { loadType, tracks, playlist, exception }', () => {
    const t = { encoded: 'x', info: { title: 'a', length: 7 } };
    const n = { encoded: 'x', info: { title: 'a', length: 7, duration: 7 }, pluginInfo: {} };
    assert.deepEqual(normalizeLoadResult({ loadType: 'track', data: t }).tracks, [n]);
    assert.deepEqual(normalizeLoadResult({ loadType: 'search', data: [t, t] }).tracks, [n, n]);
    const playlist = normalizeLoadResult({ loadType: 'playlist', data: { info: { name: 'Liste' }, tracks: [t] } });
    assert.equal(playlist.playlist.name, 'Liste');
    assert.equal(playlist.tracks.length, 1);
    const error = normalizeLoadResult({ loadType: 'error', data: { message: 'boom', severity: 'common' } });
    assert.equal(error.exception.message, 'boom');
    assert.equal(normalizeLoadResult({ loadType: 'empty', data: {} }).tracks.length, 0);
    assert.equal(normalizeLoadResult(undefined).loadType, 'empty');
  });
});

describe('normalizeTrack (real /v4/loadtracks responses)', () => {
  it("exposes Lavalink's info.length as info.duration for a single track", () => {
    const result = normalizeLoadResult(fixture('loadtracks-track.json'));
    assert.equal(result.loadType, 'track');
    const [track] = result.tracks;
    assert.equal(track.info.length, 192_000, 'the fixture really is a Lavalink v4 response');
    assert.equal(track.info.duration, 192_000);
    assert.equal(track.info.sourceName, 'youtube');
    assert.equal(track.info.identifier, 'cpp69ghR1IM');
  });

  it('does the same for every search result', () => {
    const result = normalizeLoadResult(fixture('loadtracks-search.json'));
    assert.equal(result.loadType, 'search');
    assert.ok(result.tracks.length > 1);
    for (const track of result.tracks) {
      assert.equal(track.info.duration, track.info.length);
      assert.ok(track.info.duration > 0 || track.info.isStream);
    }
  });

  it('keeps an already normalized duration and defaults missing lengths to 0', () => {
    assert.equal(normalizeTrack({ info: { duration: 5 } }).info.duration, 5);
    assert.equal(normalizeTrack({ info: {} }).info.duration, 0);
    assert.equal(normalizeTrack(null), null);
  });
});

describe('PrefetchStream', () => {
  it('downloads the whole source without waiting for the consumer', async () => {
    const chunks = Array.from({ length: 20 }, () => Buffer.alloc(1024, 1));
    const stream = new PrefetchStream(webStreamOf(chunks), { expectedLength: 20 * 1024 });
    await new Promise((r) => setTimeout(r, 30)); // nobody reads yet
    assert.equal(stream.bytesReceived, 20 * 1024);
    assert.equal(stream.complete, true);
    assert.equal(stream.truncated, false);
    let got = 0;
    for await (const chunk of stream) got += chunk.length;
    assert.equal(got, 20 * 1024);
  });

  it('reports a source that closed before the announced length', async () => {
    const stream = new PrefetchStream(webStreamOf([Buffer.alloc(100)]), { expectedLength: 500 });
    let got = 0;
    for await (const chunk of stream) got += chunk.length;
    assert.equal(got, 100);
    assert.equal(stream.truncated, true);
  });

  it('applies back-pressure to the source above the buffer cap', async () => {
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(1000));
    const stream = new PrefetchStream(webStreamOf(chunks), { maxBufferedBytes: 2500 });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(stream.bytesReceived < 10_000, `paused the source (${stream.bytesReceived} bytes)`);
    let got = 0;
    for await (const chunk of stream) got += chunk.length;
    assert.equal(got, 10_000);
    assert.equal(stream.complete, true);
  });

  it('destroy() cancels the source', async () => {
    const stream = new PrefetchStream(webStreamOf([Buffer.alloc(10)], { delayMs: 50 }));
    stream.destroy();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(stream.destroyed, true);
  });
});

describe('hasSource', () => {
  it('reads the active source managers from /v4/info', async () => {
    const { rest } = restWith((url) =>
      url.endsWith('/v4/info')
        ? jsonResponse(200, { version: { semver: '4.2.2' }, plugins: [], sourceManagers: ['youtube', 'spotify'] })
        : jsonResponse(200, {}),
    );
    assert.equal(rest.hasSource('spotify'), false, 'unknown before the first poll');
    await rest.poll();
    assert.equal(rest.hasSource('spotify'), true);
    assert.equal(rest.hasSource('Spotify'), true);
    assert.equal(rest.hasSource('deezer'), false);
    rest.stop();
  });
});

describe('streamUrl video id validation', () => {
  it('refuses anything that is not an 11-character YouTube id', () => {
    const rest = new LavalinkRest({ host: 'h', port: 1, password: 'p', logger: console, fetchImpl: async () => {} });
    for (const bad of ['', 'abc', 'a/b/c/d/e/f', 'dQw4w9WgXcQ?x=1', '../../v4/info']) {
      assert.throws(() => rest.streamUrl(bad), /Geçersiz YouTube video kimliği/);
    }
    assert.equal(rest.streamUrl('dQw4w9WgXcQ'), 'http://h:1/youtube/stream/dQw4w9WgXcQ');
    assert.equal(rest.streamUrl('_-abcdefghi'), 'http://h:1/youtube/stream/_-abcdefghi');
  });
});
