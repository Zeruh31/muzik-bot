// Review fixes: port whitelist, header-only precheck of direct links, resumable downloads,
// Lavalink-first link loading with a direct-link fallback, link rate limits, SoundCloud client_id
// hosts and 429 back-off, live streams reopening on resume, the persistent crossfade setting.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { createServerSettings } from '../src/bot/serverSettings.js';
import { DIRECT_MAX_BYTES, directTrack, openDirectStream, precheckDirectLink } from '../src/music/directLink.js';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { LINK_LIMITS, MusicService, RateLimiter } from '../src/music/MusicService.js';
import {
  ResumableBody,
  UnsafeUrlError,
  assertPublicUrl,
  isAllowedPort,
  parseContentRange,
} from '../src/music/netGuard.js';
import { SoundCloudClient, mayCarryClientId } from '../src/music/soundcloud.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

async function readAll(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}

describe('ports', () => {
  it('only 80, 443 and 8000-8999 (internet radio) are allowed', () => {
    for (const port of [80, 443, 8000, 8080, 8443, 8999]) assert.equal(isAllowedPort(port), true, String(port));
    for (const port of [21, 22, 25, 2333, 3306, 5432, 6379, 7999, 9000, 9200])
      assert.equal(isAllowedPort(port), false, String(port));
    assert.doesNotThrow(() => assertPublicUrl('https://radio.example.org:8443/live'));
    assert.doesNotThrow(() => assertPublicUrl('http://example.org/a.mp3'));
    assert.throws(
      () => assertPublicUrl('http://example.org:2333/v4/info'),
      (e) => e instanceof UnsafeUrlError && e.reason === 'port',
    );
    assert.throws(() => assertPublicUrl('https://example.org:22/'), UnsafeUrlError);
  });
});

/** A fake openSafeHttp answering from a function of (url, options). */
function fakeOpen(answer) {
  const calls = [];
  const open = async (url, options = {}) => {
    calls.push({ url, range: options.headers?.Range ?? null });
    return answer(url, options, calls.length);
  };
  return { open, calls };
}

const reply = ({ status = 200, type = 'audio/mpeg', length = null, range = null, headers = {}, body = [] }) => {
  const stream = Readable.from(body);
  let destroyed = false;
  stream.on('close', () => {
    destroyed = true;
  });
  return {
    body: stream,
    status,
    url: 'https://cdn.example.org/a.mp3',
    contentType: type,
    contentLength: length,
    headers: { ...(range ? { 'content-range': range } : {}), ...headers },
    get destroyed() {
      return destroyed;
    },
  };
};

describe('direct link precheck (headers only)', () => {
  it('parses Content-Range', () => {
    assert.deepEqual(parseContentRange('bytes 0-1023/5000'), { start: 0, end: 1023, total: 5000 });
    assert.deepEqual(parseContentRange('bytes 0-1023/*'), { start: 0, end: 1023, total: null });
    assert.equal(parseContentRange('nonsense'), null);
  });

  it('asks for the first KB only and refuses a too large file before downloading it', async () => {
    const { open, calls } = fakeOpen(() =>
      reply({ status: 206, length: 1024, range: `bytes 0-1023/${DIRECT_MAX_BYTES + 1}` }),
    );
    await assert.rejects(precheckDirectLink('https://cdn.example.org/a.mp3', { open }), /çok büyük/);
    assert.deepEqual(
      calls.map((c) => c.range),
      ['bytes=0-1023'],
    );
  });

  it('refuses web pages and HLS lists by their headers; a server without Range support works too', async () => {
    const page = fakeOpen(() => reply({ status: 200, type: 'text/html', length: 5000 }));
    await assert.rejects(precheckDirectLink('https://example.org/page', { open: page.open }), /ses dosyası değil/);
    const list = fakeOpen(() => reply({ status: 200, type: 'application/vnd.apple.mpegurl', length: 300 }));
    await assert.rejects(precheckDirectLink('https://example.org/x.m3u8', { open: list.open }), /ses dosyası değil/);
    const full = fakeOpen(() => reply({ status: 200, length: 4_000_000 }));
    const ok = await precheckDirectLink('https://cdn.example.org/a.mp3', { open: full.open });
    assert.deepEqual([ok.totalLength, ok.live], [4_000_000, false]);
    const radio = fakeOpen(() => reply({ status: 200, headers: { 'icy-name': 'Radyo' } }));
    assert.equal((await precheckDirectLink('https://radio.example.org/live', { open: radio.open })).live, true);
  });
});

describe('resumable direct downloads', () => {
  const file = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

  /** First answer sends only `cut` bytes and then fails (a connection the server closed). */
  function cutStream(cut) {
    let sent = false;
    return new Readable({
      read() {
        if (sent) return;
        sent = true;
        this.push(file.subarray(0, cut));
        setImmediate(() => this.destroy(new Error('socket hang up')));
      },
    });
  }

  it('continues with a Range request where the dropped connection stopped', async () => {
    const { open, calls } = fakeOpen((url, options) => {
      const start = Number(options.headers.Range.match(/bytes=(\d+)-/)[1]);
      return {
        ...reply({ status: 206, range: `bytes ${start}-999/1000` }),
        body: Readable.from([file.subarray(start)]),
      };
    });
    const body = new ResumableBody(cutStream(300), {
      url: 'https://cdn.example.org/a.mp3',
      expectedLength: 1000,
      open,
    });
    const all = await readAll(body);
    assert.ok(all.equals(file), 'every byte once, in order');
    assert.deepEqual(
      calls.map((c) => c.range),
      ['bytes=300-'],
    );
    assert.equal(body.truncated, false);
  });

  it('downloads again from the start and skips what it had when the server ignores Range', async () => {
    const { open } = fakeOpen(() => ({ ...reply({ status: 200, length: 1000 }), body: Readable.from([file]) }));
    const body = new ResumableBody(cutStream(450), {
      url: 'https://cdn.example.org/a.mp3',
      expectedLength: 1000,
      open,
    });
    assert.ok((await readAll(body)).equals(file));
  });

  it('gives up after repeated failures and reports the file as truncated', async () => {
    const { open, calls } = fakeOpen(() => {
      throw new Error('ECONNRESET');
    });
    const body = new ResumableBody(cutStream(100), {
      url: 'https://cdn.example.org/a.mp3',
      expectedLength: 1000,
      open,
      maxReopens: 1,
    });
    const all = await readAll(body);
    assert.equal(all.length, 100);
    assert.equal(body.truncated, true);
    assert.equal(calls.length, 1);
  });

  it('openDirectStream uses it for files (known length) and not for live streams', async () => {
    const files = fakeOpen(() => reply({ length: 3, body: [Buffer.from('abc')] }));
    assert.ok((await openDirectStream('https://cdn.example.org/a.mp3', { open: files.open })) instanceof ResumableBody);
    const radio = fakeOpen(() => reply({ length: null, body: [Buffer.from('abc')] }));
    assert.ok(
      !(
        (await openDirectStream('https://radio.example.org/live', { open: radio.open, live: true })) instanceof
        ResumableBody
      ),
    );
  });
});

// ---------------------------------------------------------------- MusicService link loading

function service({ loadTracks, probeDirect, now } = {}) {
  const engine = Object.assign(new EventEmitter(), { players: new Map(), getPlayer: () => null });
  const lavalink = { connected: true, hasSource: () => false, hasPlugin: () => true, loadTracks };
  const config = { music: { searchSource: 'ytsearch', defaultVolume: 80, maxQueueSize: 50 } };
  return new MusicService({ lavalink, engine, config, logger: silent, probeDirect, now, soundcloud: {} });
}

const ytTrack = (title) => ({
  encoded: `e-${title}`,
  info: { title, identifier: 'dQw4w9WgXcQ', sourceName: 'youtube' },
});

describe('MusicService: Lavalink first, then a direct link', () => {
  it('a short link Lavalink resolves (spotify.link, youtu.be, music.youtube) is never probed', async () => {
    const probed = [];
    const music = service({
      loadTracks: async () => ({ loadType: 'track', tracks: [ytTrack('x')] }),
      probeDirect: async (url) => probed.push(url),
    });
    for (const link of [
      'https://spotify.link/abc',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    ]) {
      assert.equal((await music.resolve(link, null)).tracks[0].info.title, 'x');
    }
    assert.deepEqual(probed, []);
  });

  it('an unknown site Lavalink finds nothing for is probed as a direct link; known sites are not', async () => {
    const probed = [];
    const music = service({
      loadTracks: async () => ({ loadType: 'empty', tracks: [] }),
      probeDirect: async (url) => {
        probed.push(url);
        return directTrack({ url, live: true });
      },
    });
    const radio = await music.resolve('https://radio.example.org/live', null);
    assert.equal(radio.tracks[0].info.isStream, true);
    await assert.rejects(music.resolve('https://www.youtube.com/watch?v=nothing', null), /Hiçbir sonuç/);
    assert.deepEqual(probed, ['https://radio.example.org/live']);
  });

  it('limits own link loads per user and per server, per minute', async () => {
    let clock = 1_000_000;
    const music = service({
      loadTracks: async () => ({ loadType: 'empty', tracks: [] }),
      probeDirect: async (url) => directTrack({ url, durationMs: 5000 }),
      now: () => clock,
    });
    const user = { id: '111111111111111111', username: 'u' };
    for (let i = 0; i < LINK_LIMITS.perUser; i++)
      await music.resolve(`https://cdn.example.org/${i}.mp3`, user, { guildId: 'g' });
    await assert.rejects(
      music.resolve('https://cdn.example.org/x.mp3', user, { guildId: 'g' }),
      (e) => e.code === 'BUSY' && /saniye sonra tekrar deneyin/.test(e.message),
    );
    // Someone else in the same server still may, until the server limit.
    const other = { id: '222222222222222222', username: 'o' };
    await music.resolve('https://cdn.example.org/y.mp3', other, { guildId: 'g' });
    clock += LINK_LIMITS.windowMs + 1;
    await music.resolve('https://cdn.example.org/z.mp3', user, { guildId: 'g' });
  });

  it('RateLimiter counts within a sliding window', () => {
    let now = 0;
    const limiter = new RateLimiter({ windowMs: 1000, now: () => now });
    limiter.record('k');
    limiter.record('k');
    assert.equal(limiter.waitFor('k', 2), 1000);
    now = 600;
    assert.equal(limiter.waitFor('k', 2), 400);
    now = 1001;
    assert.equal(limiter.waitFor('k', 2), 0);
  });
});

describe('SoundCloud client_id and rate limits', () => {
  it('the client_id only goes to SoundCloud API/CDN hosts over https', () => {
    assert.equal(mayCarryClientId('https://api-v2.soundcloud.com/resolve?url=x'), true);
    assert.equal(mayCarryClientId('https://a-v2.sndcdn.com/media/x'), true);
    assert.equal(mayCarryClientId('http://api-v2.soundcloud.com/resolve'), false);
    assert.equal(mayCarryClientId('https://evil.example/api-v2.soundcloud.com'), false);
    assert.equal(mayCarryClientId('https://api-v2.soundcloud.com.evil.example/'), false);
  });

  it('waits longer after each 429 and does not send the id to a foreign transcoding host', async () => {
    const waits = [];
    let resolveCalls = 0;
    const res = (status, body, headers = {}) => ({
      ok: status < 300,
      status,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
      body: { cancel: async () => {} },
    });
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      const u = new URL(url);
      if (u.hostname === 'soundcloud.com')
        return res(200, '<script crossorigin src="https://a-v2.sndcdn.com/assets/0-a.js"></script>');
      if (u.hostname === 'a-v2.sndcdn.com') return res(200, `client_id:"${'b'.repeat(32)}"`);
      if (u.pathname === '/resolve') {
        resolveCalls += 1;
        if (resolveCalls <= 2) return res(429, {});
        return res(200, {
          kind: 'track',
          id: 5,
          title: 't',
          duration: 1000,
          permalink_url: 'https://soundcloud.com/a/t',
          policy: 'ALLOW',
          media: {
            transcodings: [
              { url: 'https://evil.example/media/5/hls', format: { protocol: 'hls', mime_type: 'audio/mpeg' } },
            ],
          },
        });
      }
      return res(404, {});
    };
    const sc = new SoundCloudClient({ fetchImpl, sleep: async (ms) => waits.push(ms) });
    const { tracks } = await sc.resolve('https://soundcloud.com/a/t');
    assert.deepEqual(waits, [1000, 2000], 'growing back-off');
    await assert.rejects(sc.streamUrl(tracks[0]), /beklenmeyen bir adres/);
    assert.ok(!seen.some((u) => u.startsWith('https://evil.example')), 'the foreign host was never contacted');
  });
});

describe('live stream resume', () => {
  it('a paused live stream is opened again on resume instead of playing the stale buffer', async () => {
    const audioPlayer = Object.assign(new EventEmitter(), {
      state: { status: AudioPlayerStatus.Idle },
      play(resource) {
        const old = this.state;
        this.state = { status: AudioPlayerStatus.Playing, resource };
        this.emit('stateChange', old, this.state);
      },
      stop() {
        const old = this.state;
        if (old.status === AudioPlayerStatus.Idle) return false;
        this.state = { status: AudioPlayerStatus.Idle };
        this.emit('stateChange', old, this.state);
        return true;
      },
      pause() {
        this.state = { ...this.state, status: AudioPlayerStatus.Paused };
        return true;
      },
      unpause() {
        return true;
      },
    });
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Ready },
      joinConfig: { channelId: 'v' },
      subscribe() {},
      destroy() {},
    });
    const resources = [];
    const opened = [];
    const processes = [];
    const player = new GuildPlayer({
      guildId: 'g',
      voiceChannelId: 'v',
      textChannelId: 't',
      volume: 100,
      client: { guilds: { cache: new Map([['g', { voiceAdapterCreator: () => ({}) }]]) } },
      rest: { connected: true },
      config: { music: { twentyFourSeven: true } },
      logger: silent,
      emit: () => {},
      voice: {
        joinVoiceChannel: () => connection,
        createAudioPlayer: () => audioPlayer,
        createAudioResource: () => {
          const r = { playbackDuration: 0, volume: { setVolume() {} } };
          resources.push(r);
          return r;
        },
        entersState: async () => connection,
      },
      spawnImpl: () => {
        const proc = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          killed: false,
          kill() {
            this.killed = true;
          },
        });
        processes.push(proc);
        return proc;
      },
      ffmpegFinder: async () => 'ffmpeg',
      openDirect: async (url) => {
        opened.push(url);
        return new PassThrough();
      },
    });
    player.queue.add([directTrack({ url: 'https://radio.example.org/live', live: true })]);
    await player.play();
    resources[0].playbackDuration = 30_000;
    await player.pause();
    await player.resume();
    assert.equal(opened.length, 2, 'the stream was opened again');
    assert.equal(processes[0].killed, true, 'the old ffmpeg was closed');
    assert.equal(player.position, 30_000, 'listening time keeps counting');
    assert.equal(player.paused, false);
    await player.destroy('test');
  });
});

describe('persistent crossfade setting', () => {
  it('serverSettings keeps crossfade seconds next to the other fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muzik-ayar-'));
    try {
      const file = join(dir, 'sunucular.json');
      const settings = createServerSettings({ file, logger: silent });
      settings.setAutoplay('123456789012345678', true);
      settings.setCrossfade('123456789012345678', 6);
      const again = createServerSettings({ file, logger: silent });
      assert.equal(again.getCrossfade('123456789012345678'), 6);
      assert.equal(again.getAutoplay('123456789012345678'), true, 'other fields untouched');
      again.setCrossfade('123456789012345678', 0);
      assert.equal(createServerSettings({ file, logger: silent }).getCrossfade('123456789012345678'), 0);
      assert.equal(again.getCrossfade('toString'), 0, 'nothing from Object.prototype');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
