// SoundCloud, direct audio links (with the SSRF guard), YouTube live detection, live reconnects
// and the MusicService side of these and of the crossfade setting.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, it, mock } from 'node:test';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { isStreamable, resolveStreamSource, unsupportedReason } from '../src/music/audioSource.js';
import {
  directTrack,
  hasAudioExtension,
  isAudioContentType,
  parseProbeOutput,
  probeDirectLink,
  titleFromUrl,
} from '../src/music/directLink.js';
import { buildFfmpegArgs, findFfmpeg } from '../src/music/ffmpeg.js';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { normalizeTrack } from '../src/music/lavalink.js';
import { MusicService, linkKind, mayBeDirectLink } from '../src/music/MusicService.js';
import {
  UnsafeUrlError,
  assertPublicUrl,
  guardedLookup,
  isBlockedAddress,
  openSafeHttp,
} from '../src/music/netGuard.js';
import { TrackQueue } from '../src/music/Queue.js';
import { SoundCloudClient, isSoundCloudMediaUrl, isSoundCloudUrl, pickTranscoding } from '../src/music/soundcloud.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

describe('SSRF guard', () => {
  it('blocks loopback, private, link-local, CGNAT, multicast and IPv4-in-IPv6 forms', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.10',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      'fe80::1%eth0',
    ]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    // IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96) forms are refused even for public IPv4.
    for (const ip of ['::ffff:8.8.8.8', '::8.8.8.8', '::ffff:0808:0808', '::ffff:0:7f00:1'])
      assert.equal(isBlockedAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it('accepts only http/https URLs to public hosts', () => {
    assert.equal(assertPublicUrl('https://example.com/a.mp3').hostname, 'example.com');
    for (const bad of [
      'file:///C:/Windows/win.ini',
      'ftp://example.com/a.mp3',
      'http://127.0.0.1/a.mp3',
      'http://[::1]/a.mp3',
      'http://localhost:2333/v4/info',
      'http://sub.localhost/a.mp3',
      'http://intranet/a.mp3',
      'http://10.0.0.5/a.mp3',
      'http://user:pw@example.com/a.mp3',
      'gopher://example.com/',
      'not a url',
    ]) {
      assert.throws(() => assertPublicUrl(bad), UnsafeUrlError, bad);
    }
  });

  it('the guarded DNS lookup refuses names that resolve to private addresses', async () => {
    const error = await new Promise((resolve) => guardedLookup('localhost', { all: true }, (e) => resolve(e)));
    assert.ok(error instanceof UnsafeUrlError);
  });

  /** Fake http.request: answers each URL from `routes` (status, headers, body). */
  function fakeRequest(routes, seen) {
    return (url, options, callback) => {
      seen.push({ url: url.toString(), lookup: options.lookup, agent: options.agent });
      const route = routes[url.toString()] ?? { status: 404 };
      const req = Object.assign(new EventEmitter(), {
        end() {
          setImmediate(() => {
            const res = Readable.from(route.body ? [Buffer.from(route.body)] : []);
            Object.assign(res, { statusCode: route.status, headers: route.headers ?? {}, setTimeout() {} });
            callback(res);
          });
        },
        destroy() {},
      });
      return req;
    };
  }

  it('re-checks every redirect target, uses the guarded lookup and no shared connection', async () => {
    const seen = [];
    const requestImpl = fakeRequest(
      {
        'https://example.com/a.mp3': { status: 302, headers: { location: 'http://127.0.0.1:2333/v4/info' } },
        'https://example.com/b.mp3': { status: 301, headers: { location: '/c.mp3' } },
        'https://example.com/c.mp3': {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '3' },
          body: 'abc',
        },
      },
      seen,
    );
    await assert.rejects(openSafeHttp('https://example.com/a.mp3', { requestImpl }), UnsafeUrlError);
    assert.equal(seen.length, 1, 'the private redirect target was never requested');
    const ok = await openSafeHttp('https://example.com/b.mp3', { requestImpl });
    assert.equal(ok.url, 'https://example.com/c.mp3');
    assert.deepEqual([ok.contentType, ok.contentLength], ['audio/mpeg', 3]);
    ok.body.destroy();
    assert.ok(seen.every((s) => s.lookup === guardedLookup && s.agent === false));
  });

  it('enforces the size limit from Content-Length and while reading', async () => {
    const seen = [];
    const requestImpl = fakeRequest(
      {
        'https://example.com/big.mp3': { status: 200, headers: { 'content-length': '999999999' } },
        'https://example.com/liar.mp3': { status: 200, headers: {}, body: 'x'.repeat(5000) },
      },
      seen,
    );
    await assert.rejects(openSafeHttp('https://example.com/big.mp3', { requestImpl, maxBytes: 1000 }), /çok büyük/);
    const { body } = await openSafeHttp('https://example.com/liar.mp3', { requestImpl, maxBytes: 1000 });
    await assert.rejects(
      (async () => {
        for await (const _ of body);
      })(),
      /çok büyük/,
    );
  });

  it('ffmpeg only gets https network input with a protocol whitelist, as one argv entry', () => {
    const net = buildFfmpegArgs({ input: 'https://cf-hls-media.sndcdn.com/playlist.m3u8?x=1&y=2', seekMs: 5000 });
    assert.equal(net[net.indexOf('-protocol_whitelist') + 1], 'https,tls,tcp,crypto');
    assert.equal(net[net.indexOf('-i') + 1], 'https://cf-hls-media.sndcdn.com/playlist.m3u8?x=1&y=2');
    assert.ok(net.indexOf('-protocol_whitelist') < net.indexOf('-i'));
    const pipe = buildFfmpegArgs({ maxDurationMs: 10_800_000 });
    assert.equal(pipe[pipe.indexOf('-protocol_whitelist') + 1], 'pipe');
    assert.equal(pipe[pipe.indexOf('-t') + 1], '10800.000');
    assert.throws(() => buildFfmpegArgs({ input: 'http://example.com/a.mp3' }), TypeError);
    assert.throws(() => buildFfmpegArgs({ input: 'file:///etc/passwd' }), TypeError);
  });
});

/** 16-bit mono WAV of `seconds` of a 440 Hz tone. */
function wav(seconds, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('direct audio links', () => {
  it('recognizes audio file endings and content types; HLS/m3u lists are refused', () => {
    assert.equal(hasAudioExtension('https://x.org/a/b/Song.MP3?dl=1'), true);
    for (const ext of ['ogg', 'm4a', 'wav', 'flac', 'opus'])
      assert.equal(hasAudioExtension(`https://x.org/s.${ext}`), true);
    assert.equal(hasAudioExtension('https://x.org/song.html'), false);
    assert.equal(hasAudioExtension('ftp://x.org/a.mp3'), false);
    assert.equal(isAudioContentType('audio/mpeg'), true);
    assert.equal(isAudioContentType('application/ogg'), true);
    assert.equal(isAudioContentType('audio/x-mpegurl'), false);
    assert.equal(isAudioContentType('application/vnd.apple.mpegurl'), false);
    assert.equal(isAudioContentType('text/html', { url: 'https://x.org/a.mp3' }), false);
    assert.equal(isAudioContentType('application/octet-stream', { url: 'https://x.org/a.mp3' }), true);
    assert.equal(isAudioContentType('application/octet-stream', { url: 'https://x.org/a.bin' }), false);
    assert.equal(titleFromUrl('https://x.org/m%C3%BCzik/G%C3%BCzel_Bir+Par%C3%A7a.mp3'), 'Güzel Bir Parça');
  });

  it('parses the probe output (duration from -progress, tags from the input section)', () => {
    const parsed = parseProbeOutput(
      'out_time_us=1000\nprogress=continue\nout_time_us=213456789\nprogress=end\n',
      "Input #0, mp3, from 'pipe:0':\n  Metadata:\n    title           : Şarkı\n    artist          : Sanatçı\n  Stream #0:0: Audio: mp3, 44100 Hz\nOutput #0, null:\n    title : X\n",
    );
    assert.deepEqual(parsed, { durationMs: 213_457, title: 'Şarkı', artist: 'Sanatçı', decodedAudio: true });
  });

  it('a direct track is seekable with its probed length; a radio stream is live', () => {
    const file = directTrack({ url: 'https://x.org/a.mp3', durationMs: 61_000, live: false });
    assert.deepEqual(
      [file.info.duration, file.info.isStream, file.info.isSeekable, file.info.sourceName],
      [61_000, false, true, 'http'],
    );
    assert.equal(isStreamable(file), true);
    const radio = directTrack({ url: 'https://radio.example/stream', live: true });
    assert.deepEqual([radio.info.duration, radio.info.isStream, radio.info.isSeekable], [0, true, false]);
  });

  it('probes a real file with ffmpeg (length, decodes) and refuses non-audio answers', async (t) => {
    const ffmpegPath = await findFfmpeg();
    if (!ffmpegPath) return t.skip('ffmpeg yok');
    const sound = wav(2.5);
    const open = async (url) => ({
      body: Readable.from([sound]),
      url,
      contentType: 'audio/wav',
      contentLength: sound.length,
      headers: {},
    });
    const track = await probeDirectLink('https://x.org/ton.wav', { ffmpegPath, open });
    assert.equal(track.info.title, 'ton');
    assert.ok(Math.abs(track.info.duration - 2500) < 50, `${track.info.duration}`);

    const html = async (url) => ({
      body: Readable.from(['<html>']),
      url,
      contentType: 'text/html',
      contentLength: 6,
      headers: {},
    });
    await assert.rejects(probeDirectLink('https://x.org/page', { ffmpegPath, open: html }), /ses dosyası değil/);
    const junk = async (url) => ({
      body: Readable.from([Buffer.alloc(4096, 7)]),
      url,
      contentType: 'audio/mpeg',
      contentLength: 4096,
      headers: {},
    });
    await assert.rejects(probeDirectLink('https://x.org/fake.mp3', { ffmpegPath, open: junk }), /ses dosyası değil/);
  });
});

// ---------------------------------------------------------------- SoundCloud

function scFetch({ clientId = 'a'.repeat(32), track, statusFor = {} } = {}) {
  const calls = [];
  const reply = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    body: { cancel: async () => {} },
  });
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (statusFor[u.pathname]?.length) return reply(statusFor[u.pathname].shift(), {});
    if (u.hostname === 'soundcloud.com') {
      return reply(200, '<script crossorigin src="https://a-v2.sndcdn.com/assets/0-abc.js"></script>');
    }
    if (u.hostname === 'a-v2.sndcdn.com') return reply(200, `x={client_id:"${clientId}"}`);
    if (u.hostname === 'on.soundcloud.com')
      return reply(302, '', { location: 'https://soundcloud.com/forss/flickermood?si=x' });
    if (u.pathname === '/resolve') return reply(200, track);
    if (u.pathname.startsWith('/media/'))
      return reply(200, { url: 'https://playback.media-streaming.soundcloud.cloud/x/playlist.m3u8?a=1' });
    if (u.pathname === '/tracks') {
      const ids = u.searchParams.get('ids').split(',');
      return reply(
        200,
        ids.map((id) => ({ ...scTrackJson, id: Number(id), title: `t${id}` })),
      );
    }
    return reply(404, {});
  };
  return { fetchImpl, calls };
}

const scTrackJson = {
  kind: 'track',
  id: 1,
  title: 'Flickermood',
  duration: 213_886,
  full_duration: 213_890,
  permalink_url: 'https://soundcloud.com/forss/flickermood',
  artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg',
  user: { username: 'Forss' },
  policy: 'ALLOW',
  streamable: true,
  track_authorization: 'auth123',
  media: {
    transcodings: [
      {
        url: 'https://api-v2.soundcloud.com/media/1/hls-aac',
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
      },
      {
        url: 'https://api-v2.soundcloud.com/media/1/hls-mp3',
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mpeg' },
      },
    ],
  },
};

describe('SoundCloud', () => {
  it('recognizes SoundCloud links and media hosts', () => {
    assert.equal(isSoundCloudUrl('https://soundcloud.com/forss/flickermood'), true);
    assert.equal(isSoundCloudUrl('https://m.soundcloud.com/forss/flickermood'), true);
    assert.equal(isSoundCloudUrl('https://on.soundcloud.com/abc'), true);
    assert.equal(isSoundCloudUrl('https://soundcloud.com.evil.example/x'), false);
    assert.equal(isSoundCloudMediaUrl('https://cf-hls-media.sndcdn.com/x.m3u8'), true);
    assert.equal(isSoundCloudMediaUrl('http://cf-hls-media.sndcdn.com/x.m3u8'), false, 'https only');
    assert.equal(isSoundCloudMediaUrl('https://evil.example/sndcdn.com'), false);
  });

  it('prefers progressive MP3, then HLS MP3, AAC, Opus; never 30 s previews', () => {
    const t = (protocol, mime, snipped = false) => ({
      url: `u-${protocol}-${mime}`,
      snipped,
      format: { protocol, mime_type: mime },
    });
    assert.equal(
      pickTranscoding([t('hls', 'audio/ogg'), t('hls', 'audio/mp4'), t('hls', 'audio/mpeg')]).url,
      'u-hls-audio/mpeg',
    );
    assert.equal(
      pickTranscoding([t('hls', 'audio/mpeg'), t('progressive', 'audio/mpeg')]).format.protocol,
      'progressive',
    );
    assert.equal(pickTranscoding([t('hls', 'audio/mpeg', true)]), null);
  });

  it('resolves a link through api-v2 with the client_id read from soundcloud.com', async () => {
    const { fetchImpl, calls } = scFetch({ track: scTrackJson });
    const sc = new SoundCloudClient({ fetchImpl });
    const result = await sc.resolve('https://on.soundcloud.com/abc');
    assert.equal(result.kind, 'track');
    const [track] = result.tracks;
    assert.deepEqual(
      [track.info.title, track.info.author, track.info.duration, track.info.sourceName, track.info.uri],
      ['Flickermood', 'Forss', 213_890, 'soundcloud', 'https://soundcloud.com/forss/flickermood'],
    );
    assert.equal(track.info.artworkUrl, 'https://i1.sndcdn.com/artworks-x-t500x500.jpg');
    const resolveCall = calls.find((u) => u.includes('/resolve'));
    assert.ok(resolveCall.includes(`client_id=${'a'.repeat(32)}`));
    assert.ok(
      decodeURIComponent(resolveCall).includes('url=https://soundcloud.com/forss/flickermood&'),
      'tracking params removed',
    );

    const stream = await sc.streamUrl(track);
    assert.equal(stream.url, 'https://playback.media-streaming.soundcloud.cloud/x/playlist.m3u8?a=1');
    const mediaCall = calls.find((u) => u.includes('/media/'));
    assert.ok(mediaCall.includes('hls-mp3') && mediaCall.includes('track_authorization=auth123'));
    const source = await resolveStreamSource(track, {}, { soundcloud: sc });
    assert.deepEqual(source, { kind: 'url', url: stream.url });
  });

  it('reads a fresh client_id once after 401, refuses previews and blocked tracks', async () => {
    const { fetchImpl, calls } = scFetch({ track: scTrackJson, statusFor: { '/resolve': [401] } });
    const sc = new SoundCloudClient({ fetchImpl });
    await sc.resolve('https://soundcloud.com/forss/flickermood');
    assert.equal(
      calls.filter((u) => u.startsWith('https://soundcloud.com/')).length,
      2,
      'site read again for a new id',
    );

    const snip = new SoundCloudClient({ fetchImpl: scFetch({ track: { ...scTrackJson, policy: 'SNIP' } }).fetchImpl });
    await assert.rejects(snip.resolve('https://soundcloud.com/a/b'), /30 saniyelik önizlemesi/);
    const block = new SoundCloudClient({
      fetchImpl: scFetch({ track: { ...scTrackJson, policy: 'BLOCK' } }).fetchImpl,
    });
    await assert.rejects(block.resolve('https://soundcloud.com/a/b'), /engelli/);
  });

  it('loads a set: stub tracks fetched by id, order kept', async () => {
    const set = {
      kind: 'playlist',
      title: 'Liste',
      tracks: [scTrackJson, { id: 7, kind: 'track' }, { id: 9, kind: 'track' }],
    };
    const { fetchImpl } = scFetch({ track: set });
    const sc = new SoundCloudClient({ fetchImpl });
    // /tracks answers with copies of scTrackJson; the set itself is returned by /resolve.
    const result = await sc.resolve('https://soundcloud.com/forss/sets/liste');
    assert.equal(result.kind, 'playlist');
    assert.equal(result.playlistName, 'Liste');
    assert.deepEqual(
      result.tracks.map((t) => t.info.title),
      ['Flickermood', 't7', 't9'],
    );
  });
});

describe('YouTube live streams', () => {
  it('a YouTube "video" longer than 12 hours is a live stream (youtube-plugin reports isStream=false)', () => {
    const live = normalizeTrack({
      encoded: 'x',
      info: {
        identifier: 'jfKfPfyJRdk',
        sourceName: 'youtube',
        length: 121_601_512_000,
        isStream: false,
        isSeekable: true,
      },
    });
    assert.deepEqual([live.info.isStream, live.info.isSeekable, live.info.duration], [true, false, 0]);
    const long = normalizeTrack({ info: { identifier: 'x', sourceName: 'youtube', length: 11 * 3_600_000 } });
    assert.ok(!long.info.isStream, 'a 11 h upload is a video');
    const sc = normalizeTrack({ info: { identifier: 'x', sourceName: 'soundcloud', length: 20 * 3_600_000 } });
    assert.ok(!sc.info.isStream, 'only YouTube');
  });

  it('YouTube live streams are refused with a clear Turkish reason', () => {
    const live = { info: { identifier: 'jfKfPfyJRdk', sourceName: 'youtube', isStream: true } };
    assert.match(unsupportedReason(live), /canlı yayınları şu an çalınamıyor/);
    assert.equal(isStreamable(live), false);
  });
});

// ---------------------------------------------------------------- live reconnect

function liveSetup() {
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
      return true;
    },
    unpause() {
      return true;
    },
  });
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready },
    joinConfig: { channelId: 'v1' },
    subscribe() {},
    destroy() {},
  });
  const resources = [];
  const voice = {
    joinVoiceChannel: () => connection,
    createAudioPlayer: () => audioPlayer,
    createAudioResource: () => {
      const r = { playbackDuration: 0, volume: { setVolume() {} } };
      resources.push(r);
      return r;
    },
    entersState: async () => connection,
  };
  const processes = [];
  const spawnImpl = (path, args) => {
    const proc = Object.assign(new EventEmitter(), {
      args,
      killed: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        this.killed = true;
      },
    });
    processes.push(proc);
    return proc;
  };
  const opened = [];
  const events = [];
  const player = new GuildPlayer({
    guildId: 'g',
    voiceChannelId: 'v1',
    textChannelId: 't',
    volume: 100,
    client: { guilds: { cache: new Map([['g', { voiceAdapterCreator: () => ({}) }]]) } },
    rest: { connected: true },
    config: { music: { twentyFourSeven: true } },
    logger: silent,
    emit: (e, ...a) => events.push([e, ...a]),
    voice,
    spawnImpl,
    ffmpegFinder: async () => 'ffmpeg',
    openDirect: async (url, options) => {
      opened.push({ url, options });
      return new PassThrough();
    },
  });
  const end = (ms) => {
    audioPlayer.state.resource.playbackDuration = ms;
    audioPlayer.stop();
  };
  return { player, processes, opened, events, end, resources };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

describe('live streams (internet radio links)', () => {
  it('reconnect a few times after drops, without seeking, then give up with a Turkish message', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const t = liveSetup();
      const radio = directTrack({ url: 'https://radio.example/stream', live: true });
      t.player.queue.add([radio]);
      await t.player.play();
      assert.equal(t.opened[0].options.live, true);
      assert.ok(!t.processes[0].args.includes('-ss'));

      for (let attempt = 1; attempt <= 3; attempt++) {
        t.end(20_000);
        await flush();
        assert.equal(t.processes.length, attempt, 'waits before reconnecting');
        mock.timers.tick(1000 * attempt);
        await flush();
        assert.equal(t.processes.length, attempt + 1, `reconnect ${attempt}`);
        assert.ok(!t.processes.at(-1).args.includes('-ss'), 'a live stream is never seeked');
      }
      assert.equal(t.player.position, 60_000, 'the listening time keeps counting');
      t.end(20_000);
      await flush();
      const error = t.events.find((e) => e[0] === 'trackError');
      assert.match(error[3].exception.message, /Canlı yayının bağlantısı koptu/);
      assert.equal(t.events.filter((e) => e[0] === 'trackStart').length, 1, 'announced once');
    } finally {
      mock.timers.reset();
    }
  });

  it('a drop after a long healthy stretch starts the count again; stop cancels a pending reconnect', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const t = liveSetup();
      t.player.queue.add([directTrack({ url: 'https://radio.example/stream', live: true })]);
      await t.player.play();
      for (let i = 0; i < 5; i++) {
        t.end(120_000); // two minutes each time: healthy
        await flush();
        mock.timers.tick(1000);
        await flush();
      }
      assert.equal(t.processes.length, 6);
      assert.ok(!t.events.some((e) => e[0] === 'trackError'));
      t.end(120_000);
      await flush();
      await t.player.stopPlaying();
      mock.timers.tick(5000);
      await flush();
      assert.equal(t.processes.length, 6, 'no reconnect after stop');
    } finally {
      mock.timers.reset();
    }
  });
});

// ---------------------------------------------------------------- MusicService

function service({ probeDirect, soundcloud, settings = null, loadTracks } = {}) {
  const engine = new EventEmitter();
  engine.players = new Map();
  engine.getPlayer = (id) => engine.players.get(id) ?? null;
  const lavalink = {
    connected: true,
    hasSource: () => false,
    hasPlugin: () => true,
    loadTracks: loadTracks ?? (async () => ({ loadType: 'empty', tracks: [] })),
  };
  const config = { music: { searchSource: 'ytsearch', defaultVolume: 80, maxQueueSize: 50 } };
  return {
    engine,
    music: new MusicService({ lavalink, engine, config, logger: silent, settings, soundcloud, probeDirect }),
  };
}

describe('MusicService: links and crossfade', () => {
  it('routes links: SoundCloud and files to the bot, known sites to Lavalink', () => {
    assert.equal(linkKind('https://soundcloud.com/a/b'), 'soundcloud');
    assert.equal(linkKind('https://cdn.example.org/music/song.mp3'), 'direct');
    assert.equal(linkKind('https://radio.example.org/live'), 'lavalink', 'unknown sites: Lavalink first');
    assert.equal(linkKind('https://spotify.link/abc'), 'lavalink');
    assert.equal(linkKind('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'lavalink');
    assert.equal(linkKind('https://youtu.be/dQw4w9WgXcQ'), 'lavalink');
    assert.equal(linkKind('https://open.spotify.com/track/x'), 'lavalink');
    assert.equal(linkKind('https://artist.bandcamp.com/track/x'), 'lavalink');
    assert.equal(mayBeDirectLink('https://radio.example.org/live'), true);
    assert.equal(mayBeDirectLink('https://www.youtube.com/watch?v=x'), false);
    assert.equal(mayBeDirectLink('https://music.youtube.com/watch?v=x'), false);
  });

  it('resolve() uses the SoundCloud client and the direct-link probe, not Lavalink', async () => {
    const asked = [];
    const { music } = service({
      loadTracks: async (id) => {
        asked.push(id);
        return { loadType: 'empty', tracks: [] };
      },
      soundcloud: {
        resolve: async () => ({
          kind: 'playlist',
          tracks: [{ info: { title: 'sc1', sourceName: 'soundcloud', uri: 'https://soundcloud.com/a/1' } }],
          playlistName: 'Set',
          unplayable: 2,
        }),
      },
      probeDirect: async (url) => directTrack({ url, durationMs: 5000, live: false }),
    });
    const sc = await music.resolve('https://soundcloud.com/a/sets/x', { id: '1', username: 'u' });
    assert.deepEqual([sc.kind, sc.playlistName, sc.unplayable, sc.tracks[0].info.title], ['playlist', 'Set', 2, 'sc1']);
    const file = await music.resolve('https://cdn.example.org/song.mp3', null);
    assert.deepEqual([file.kind, file.tracks[0].info.sourceName], ['track', 'http']);
    assert.deepEqual(asked, [], 'Lavalink was not asked');
  });

  it('a SoundCloud network failure becomes a Turkish message', async () => {
    const { music } = service({
      soundcloud: {
        resolve: async () => {
          throw new Error('fetch failed');
        },
      },
    });
    await assert.rejects(music.resolve('https://soundcloud.com/a/b'), /SoundCloud'a şu an ulaşılamıyor/);
  });

  it('setCrossfade validates 0-12 s, works without a player, reaches the player and getState', async () => {
    const { music, engine } = service();
    assert.equal(music.getCrossfade('g'), 0, 'off by default');
    for (const bad of [-1, 13, 2.5, '5', null]) {
      await assert.rejects(
        music.setCrossfade('g', bad),
        (e) => e instanceof Error && /0 ile 12 saniye/.test(e.message),
      );
    }
    assert.equal(await music.setCrossfade('g', 6), 6);
    assert.equal(music.getCrossfade('g'), 6);

    const calls = [];
    const player = {
      guildId: 'g',
      queue: new TrackQueue(),
      voiceChannelId: 'v',
      textChannelId: 't',
      volume: 80,
      repeatMode: 'off',
      position: 0,
      getData: () => undefined,
      setCrossfade: async (s) => calls.push(s),
    };
    engine.players.set('g', player);
    await music.setCrossfade('g', 0);
    assert.deepEqual(calls, [0]);
    assert.equal(music.getState('g').crossfade, 0);
    await music.setCrossfade('g', 12);
    assert.equal(music.getState('g').crossfade, 12);
  });

  it('keeps the setting in the settings store when it supports crossfade', async () => {
    const stored = new Map();
    const settings = { getCrossfade: (g) => stored.get(g), setCrossfade: (g, s) => stored.set(g, s) };
    const { music } = service({ settings });
    await music.setCrossfade('g', 4);
    assert.equal(stored.get('g'), 4);
    assert.equal(music.getCrossfade('g'), 4);
  });
});
