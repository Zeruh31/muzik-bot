import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { MusicError } from '../src/music/errors.js';
import { MusicService } from '../src/music/MusicService.js';
import { TrackQueue } from '../src/music/Queue.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const config = {
  music: { searchSource: 'ytmsearch', defaultVolume: 80, maxQueueSize: 5, twentyFourSeven: false },
};

function track(title, duration = 180_000, extra = {}) {
  return {
    encoded: `enc-${title}`,
    info: {
      title,
      author: 'Sanatçı',
      duration,
      uri: `https://youtu.be/${title}`,
      identifier: title,
      sourceName: 'youtube',
      isStream: false,
      isSeekable: true,
      ...extra,
    },
    pluginInfo: {},
    requester: { id: '123456789012345678', username: 'test' },
  };
}

/** The real TrackQueue wrapped in a minimal fake GuildPlayer that records its calls. */
function fakePlayer(guildId, { current = null, tracks = [] } = {}) {
  const queue = new TrackQueue();
  queue.current = current;
  queue.tracks = [...tracks];
  const data = new Map();
  const calls = [];
  return {
    guildId,
    voiceChannelId: 'v1',
    textChannelId: 't1',
    connected: true,
    playing: Boolean(current),
    paused: false,
    volume: 80,
    repeatMode: 'off',
    bassboost: 'none',
    position: 1000,
    destroyed: false,
    queue,
    calls,
    getData: (k) => data.get(k),
    setData: (k, v) => data.set(k, v),
    async connect() {
      this.connected = true;
    },
    async play() {
      calls.push(['play']);
      if (!queue.current) queue.advance();
      this.playing = Boolean(queue.current);
    },
    async pause() {
      this.paused = true;
    },
    async resume() {
      this.paused = false;
    },
    async setVolume(v) {
      this.volume = v;
    },
    async setRepeatMode(mode) {
      this.repeatMode = mode;
    },
    async setBassboost(level) {
      this.bassboost = level;
      calls.push(['bass', level]);
    },
    async seek(ms) {
      calls.push(['seek', ms]);
    },
    async skip(n = 0) {
      calls.push(['skip', n]);
      if (n > 1) queue.splice(0, n - 1);
      queue.advance();
    },
    async stopPlaying() {
      calls.push(['stopPlaying']);
      queue.current = null;
    },
    async destroy(reason) {
      calls.push(['destroy', reason]);
      this.destroyed = true;
    },
  };
}

/** MusicService -> its fake engine, so tests can emit player events. */
const serviceEngine = new WeakMap();

function serviceWith(player, { nodeConnected = true, lyrics, loadTracks, sourceManagers = ['youtube'] } = {}) {
  const engine = new EventEmitter();
  engine.players = new Map(player ? [[player.guildId, player]] : []);
  engine.getPlayer = (id) => engine.players.get(id) ?? null;
  engine.createPlayer = ({ guildId, voiceChannelId, textChannelId, volume }) => {
    const created = fakePlayer(guildId);
    Object.assign(created, { voiceChannelId, textChannelId, volume, connected: false });
    engine.players.set(guildId, created);
    return created;
  };
  const lavalink = {
    id: 'n',
    connected: nodeConnected,
    info: { version: { semver: '4.2.2' }, plugins: [{ name: 'lavalyrics-plugin', version: '1.1.0' }] },
    stats: { uptime: 5, memory: { used: 1 }, cpu: { lavalinkLoad: 0.1 } },
    hasPlugin: (name) => name === 'lavalyrics-plugin',
    hasSource: (name) => sourceManagers.includes(name),
    lyrics,
    loadTracks,
  };
  const service = new MusicService({ lavalink, engine, config, logger: silent });
  serviceEngine.set(service, engine);
  return service;
}

const titles = (player) => player.queue.tracks.map((t) => t.info.title);

describe('MusicService', () => {
  it('getState returns a JSON-safe snapshot', () => {
    const player = fakePlayer('g', { current: track('a'), tracks: [track('b', 60_000), track('c', 30_000)] });
    const state = serviceWith(player).getState('g');
    assert.equal(state.current.title, 'a');
    assert.deepEqual(
      state.queue.map((t) => t.title),
      ['b', 'c'],
    );
    assert.equal(state.queueDuration, 90_000);
    assert.equal(state.bassboost, 'none');
    assert.equal(state.position, 1000);
    assert.doesNotThrow(() => JSON.stringify(state));
  });

  it('getState is null without a player', () => {
    assert.equal(serviceWith(null).getState('x'), null);
  });

  it("nodeStats counts this bot's players, not Lavalink's", () => {
    const player = fakePlayer('g', { current: track('a') });
    const stats = serviceWith(player).nodeStats();
    assert.deepEqual([stats.version, stats.players, stats.playingPlayers], ['4.2.2', 1, 1]);
    assert.deepEqual(stats.plugins, ['lavalyrics-plugin 1.1.0']);
    assert.equal(serviceWith(null, { nodeConnected: false }).nodeStats(), null);
  });

  it('move reorders using 1-based positions', async () => {
    const player = fakePlayer('g', { current: track('now'), tracks: ['a', 'b', 'c', 'd'].map((t) => track(t)) });
    const service = serviceWith(player);
    const moved = await service.move('g', 1, 3);
    assert.equal(moved.title, 'a');
    assert.deepEqual(titles(player), ['b', 'c', 'a', 'd']);
    await service.move('g', 4, 1);
    assert.deepEqual(titles(player), ['d', 'b', 'c', 'a']);
  });

  it('remove and clear', async () => {
    const player = fakePlayer('g', { current: track('now'), tracks: ['a', 'b', 'c'].map((t) => track(t)) });
    const service = serviceWith(player);
    assert.equal((await service.remove('g', 2)).title, 'b');
    assert.deepEqual(titles(player), ['a', 'c']);
    assert.equal(await service.clear('g'), 2);
    assert.deepEqual(titles(player), []);
    await assert.rejects(service.clear('g'), MusicError);
  });

  it('rejects out-of-range positions with a Turkish message', async () => {
    const player = fakePlayer('g', { current: track('now'), tracks: [track('a')] });
    const service = serviceWith(player);
    await assert.rejects(service.remove('g', 2), (e) => e instanceof MusicError && /1 ile 1 arasında/.test(e.message));
    await assert.rejects(service.skipTo('g', 0), MusicError);
    await assert.rejects(service.move('g', 1, 1), MusicError);
  });

  it('skipTo jumps to the requested track', async () => {
    const player = fakePlayer('g', { current: track('now'), tracks: ['a', 'b', 'c'].map((t) => track(t)) });
    const target = await serviceWith(player).skipTo('g', 3);
    assert.equal(target.title, 'c');
    assert.equal(player.queue.current.info.title, 'c');
  });

  it('skip with an empty queue stops instead of throwing', async () => {
    const player = fakePlayer('g', { current: track('now') });
    const skipped = await serviceWith(player).skip('g');
    assert.equal(skipped.title, 'now');
    assert.deepEqual(player.calls.at(-1), ['stopPlaying']);
  });

  it('loop toggles are exclusive and reversible', async () => {
    const player = fakePlayer('g', { current: track('now') });
    const service = serviceWith(player);
    assert.equal(await service.toggleTrackLoop('g'), 'track');
    assert.equal(await service.toggleQueueLoop('g'), 'queue');
    assert.equal(await service.toggleQueueLoop('g'), 'off');
  });

  it('volume bounds', async () => {
    const player = fakePlayer('g', { current: track('now') });
    const service = serviceWith(player);
    await service.setVolume('g', 150);
    assert.equal(player.volume, 150);
    await assert.rejects(service.setVolume('g', 151), MusicError);
    await assert.rejects(service.setVolume('g', 0), MusicError);
  });

  it('bassboost levels reach the player and show up in the state', async () => {
    const player = fakePlayer('g', { current: track('now') });
    const service = serviceWith(player);
    await service.setBassboost('g', 'high');
    assert.equal(service.getState('g').bassboost, 'high');
    await service.setBassboost('g', 'none');
    assert.deepEqual(player.calls, [
      ['bass', 'high'],
      ['bass', 'none'],
    ]);
    assert.equal(service.getState('g').bassboost, 'none');
    await assert.rejects(service.setBassboost('g', 'earrape'), MusicError);
  });

  it('seek refuses streams and out-of-range times', async () => {
    const live = fakePlayer('g', { current: track('live', 0, { isStream: true, isSeekable: false }) });
    await assert.rejects(serviceWith(live).seek('g', 1000), MusicError);
    const normal = fakePlayer('g', { current: track('song', 60_000) });
    const service = serviceWith(normal);
    await assert.rejects(service.seek('g', 60_000), MusicError);
    await service.seek('g', 30_000);
    assert.deepEqual(normal.calls.at(-1), ['seek', 30_000]);
  });

  it('controls without a player throw NO_PLAYER', async () => {
    const service = serviceWith(null);
    await assert.rejects(service.pause('g'), (e) => e.code === 'NO_PLAYER');
    await assert.rejects(service.stop('g'), (e) => e.code === 'NO_PLAYER');
  });

  it('resolve reports a missing Lavalink connection in Turkish', async () => {
    const service = serviceWith(null, { nodeConnected: false });
    await assert.rejects(
      service.resolve('test', null),
      (e) => e.code === 'NODE_UNAVAILABLE' && /Lavalink/.test(e.message),
    );
  });

  it('explains a Spotify link when Lavalink has no Spotify source, and a missing Spotify track', async () => {
    const link = 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT';
    const off = serviceWith(null, { loadTracks: async () => ({ loadType: 'empty', tracks: [] }) });
    await assert.rejects(
      off.resolve(link, null),
      (e) =>
        e.code === 'SOURCE_DISABLED' && /Spotify desteği kapalı/.test(e.message) && /README > Spotify/.test(e.message),
    );
    await assert.rejects(
      off.resolve('spotify:track:4cOdK2wGLETKBW3PvgPWqT', null),
      (e) => e.code === 'SOURCE_DISABLED',
    );

    const on = serviceWith(null, {
      sourceManagers: ['youtube', 'spotify'],
      loadTracks: async () => ({ loadType: 'empty', tracks: [] }),
    });
    await assert.rejects(
      on.resolve(link, null),
      (e) => e.code === 'NOT_FOUND' && /Spotify bağlantısı bulunamadı/.test(e.message),
    );
    await assert.rejects(
      on.resolve('https://youtu.be/x', null),
      (e) => e.code === 'NOT_FOUND' && /Hiçbir sonuç/.test(e.message),
    );
  });

  it('resolve searches with the configured source and attaches a plain requester', async () => {
    const identifiers = [];
    const service = serviceWith(null, {
      loadTracks: async (identifier) => {
        identifiers.push(identifier);
        return { loadType: 'search', tracks: [track('x1'), track('x2')], playlist: null, exception: null };
      },
    });
    const user = { id: '1', username: 'u', globalName: 'U', displayAvatarURL: () => 'http://a', extra: 'drop me' };
    const resolved = await service.resolve('şarkı adı', user);
    assert.equal(identifiers[0], 'ytmsearch:şarkı adı');
    assert.equal(resolved.kind, 'search');
    assert.deepEqual(resolved.tracks[0].requester, { id: '1', username: 'u', displayName: 'U', avatarUrl: 'http://a' });
    await service.resolve('https://youtu.be/abc', null);
    assert.equal(identifiers[1], 'https://youtu.be/abc', 'links are not wrapped in a search');
  });

  it('enqueue creates and connects a player, then starts playing', async () => {
    const service = serviceWith(null);
    const result = await service.enqueue({
      guildId: 'g',
      voiceChannelId: 'v9',
      textChannelId: 't9',
      tracks: [track('a')],
    });
    const player = service.getPlayer('g');
    assert.equal(player.connected, true);
    assert.deepEqual([player.voiceChannelId, player.textChannelId, player.volume], ['v9', 't9', 80]);
    assert.deepEqual(player.calls, [['play']]);
    assert.deepEqual([result.startedPlaying, result.queuePosition, result.tracks[0].title], [true, 0, 'a']);
    const second = await service.enqueue({ guildId: 'g', voiceChannelId: 'v9', tracks: [track('b')] });
    assert.deepEqual([second.startedPlaying, second.queuePosition], [false, 1]);
  });

  it('refuses tracks from sources the bot cannot stream before queueing them', async () => {
    const service = serviceWith(null);
    const soundcloud = track('bc', 180_000, { sourceName: 'bandcamp' });
    await assert.rejects(
      service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [soundcloud] }),
      (e) => e.code === 'SOURCE_UNSUPPORTED' && /bandcamp/.test(e.message) && /şimdilik desteklenmiyor/.test(e.message),
    );
    assert.equal(service.getPlayer('g'), null, 'no player was created');
    // In a playlist the unsupported ones are left out and counted.
    const result = await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [soundcloud, track('ok')] });
    assert.deepEqual([result.tracks.map((t) => t.title), result.skippedUnsupported], [['ok'], 1]);
  });

  it('toTrackView shows the YouTube video a mirrored track plays', () => {
    const spotify = track('sp', 180_000, { sourceName: 'spotify' });
    spotify.mirror = { videoId: 'yt1', title: 'YT başlık', author: 'YT', uri: 'https://youtu.be/yt1', track: {} };
    const player = fakePlayer('g', { current: spotify });
    const view = serviceWith(player).getState('g').current;
    assert.deepEqual(view.mirror, { videoId: 'yt1', title: 'YT başlık', author: 'YT', uri: 'https://youtu.be/yt1' });
    assert.equal(serviceWith(fakePlayer('g', { current: track('a') })).getState('g').current.mirror, null);
  });

  it('lyrics asks Lavalink with the encoded track and maps a missing result', async () => {
    const encodedSeen = [];
    const service = serviceWith(fakePlayer('g', { current: { ...track('song'), encoded: 'QAAA+/b=' } }), {
      lyrics: async (encoded) => {
        encodedSeen.push(encoded);
        return { text: 'söz satırı', provider: 'LRCLIB', sourceName: 'lrclib' };
      },
    });
    const result = await service.lyrics({ guildId: 'g' });
    assert.deepEqual(encodedSeen, ['QAAA+/b=']);
    assert.equal(result.text, 'söz satırı');
    const none = serviceWith(fakePlayer('g', { current: track('song') }), { lyrics: async () => null });
    await assert.rejects(none.lyrics({ guildId: 'g' }), (e) => e.code === 'LYRICS_UNAVAILABLE');
  });

  it('refuses control commands while the audio source is being recovered, but /stop still works', async () => {
    const player = fakePlayer('g', { current: track('now'), tracks: [track('a'), track('b')] });
    player.setData('recovering', true);
    const service = serviceWith(player);
    for (const action of [
      () => service.pause('g'),
      () => service.skip('g'),
      () => service.setVolume('g', 50),
      () => service.shuffle('g'),
      () => service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [track('x')] }),
    ]) {
      await assert.rejects(action(), (e) => e.code === 'RECOVERING' && /yeniden bağlanıyor/.test(e.message));
    }
    assert.equal(service.isRecovering('g'), true);
    assert.ok(service.getState('g'), 'state stays readable (queue, nowplaying, panel)');
    await service.stop('g');
    assert.deepEqual(player.calls.at(-1), ['destroy', 'Durduruldu']);
  });

  it('stop runs the recovery hooks and succeeds without a player when one was cancelled', async () => {
    const service = serviceWith(null);
    const seen = [];
    service.onStopRequest((guildId) => {
      seen.push(guildId);
      return guildId === 'g';
    });
    await service.stop('g');
    assert.deepEqual(seen, ['g']);
    await assert.rejects(service.stop('other'), (e) => e.code === 'NO_PLAYER');
  });

  it('playNext (/playfirst) moves any queue position to the front, including position 2', async () => {
    const player = fakePlayer('g', { current: track('now'), tracks: ['a', 'b', 'c', 'd'].map((t) => track(t)) });
    const service = serviceWith(player);
    let result = await service.playNext('g', 2);
    assert.deepEqual([result.track.title, result.moved], ['b', true]);
    assert.deepEqual(titles(player), ['b', 'a', 'c', 'd']);
    result = await service.playNext('g', 4);
    assert.deepEqual(titles(player), ['d', 'b', 'a', 'c']);
    result = await service.playNext('g', 1);
    assert.deepEqual([result.track.title, result.moved], ['d', false], 'already next: no change');
    assert.deepEqual(titles(player), ['d', 'b', 'a', 'c']);
    await assert.rejects(service.playNext('g', 5), (e) => e.code === 'INVALID_POSITION' && /1 ile 4/.test(e.message));
    await assert.rejects(service.playNext('g', 0), (e) => e.code === 'INVALID_POSITION');
    const empty = serviceWith(fakePlayer('g', { current: track('now') }));
    await assert.rejects(empty.playNext('g', 1), (e) => e.code === 'EMPTY_QUEUE');
  });

  describe('next search result after an unplayable track', () => {
    const AGE = { exception: { message: 'This video requires age verification.' } };
    const UNAVAILABLE = { exception: { message: 'This video is unavailable' } };
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    function setup() {
      const player = fakePlayer('g', { current: track('now') });
      const service = serviceWith(player);
      const events = [];
      service.on('trackRetried', (_g, failed, reason, next) =>
        events.push(['retried', failed.title, reason, next.title]),
      );
      service.on('trackFailed', (_g, failed, reason) => events.push(['failed', failed.title, reason]));
      return { player, service, events, engine: serviceEngine.get(service) };
    }

    it('tries the next result once for an age restricted track and says so', async () => {
      const { player, service, events, engine } = setup();
      const [first, second] = [track('ilk'), track('ikinci')];
      await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [first], fallback: second });
      player.queue.current = player.queue.tracks.shift(); // "ilk" starts playing ...
      engine.emit('trackError', player, first, AGE); // ... and fails
      await settle();
      assert.deepEqual(titles(player), ['ikinci'], 'next result queued at the front');
      assert.deepEqual(events, [['retried', 'ilk', 'Bu video yaş kısıtlamalı ve çalınamıyor.', 'ikinci']]);

      // The retried track fails too: no third attempt, just the usual error message.
      player.queue.current = player.queue.tracks.shift();
      engine.emit('trackError', player, second, UNAVAILABLE);
      await settle();
      assert.deepEqual(titles(player), []);
      assert.equal(events.at(-1)[0], 'failed');
      assert.equal(events.length, 2);
    });

    it('also for "unavailable", but not for other errors or tracks that were not searched', async () => {
      const { player, service, events, engine } = setup();
      await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [track('a')], fallback: track('b') });
      engine.emit('trackError', player, track('a'), UNAVAILABLE);
      await settle();
      assert.equal(events.at(-1)[0], 'retried');

      await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [track('c')], fallback: track('d') });
      engine.emit('trackError', player, track('c'), { exception: { message: 'Something else broke' } });
      await settle();
      assert.equal(events.at(-1)[0], 'failed');

      await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [track('link')] });
      engine.emit('trackError', player, track('link'), AGE);
      await settle();
      assert.deepEqual(events.at(-1).slice(0, 2), ['failed', 'link']);
      assert.ok(!titles(player).includes('d'));
    });

    it('an unsupported source keeps its own Turkish message', async () => {
      const { player, events, engine } = setup();
      engine.emit('trackError', player, track('sc'), {
        exception: { code: 'SOURCE_UNSUPPORTED', message: 'Bu kaynak (soundcloud) şimdilik desteklenmiyor.' },
      });
      await settle();
      assert.deepEqual(events, [['failed', 'sc', 'Bu kaynak (soundcloud) şimdilik desteklenmiyor.']]);
    });

    it('a track picked from a list is not swapped; the message suggests picking another', async () => {
      const { player, service, events, engine } = setup();
      await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [track('secilen')], fromList: true });
      engine.emit('trackError', player, track('secilen'), AGE);
      await settle();
      assert.equal(events.length, 1);
      assert.equal(events[0][0], 'failed');
      assert.match(events[0][2], /yaş kısıtlamalı/);
      assert.match(events[0][2], /listeden başka bir şarkı seçebilirsin/);
      assert.deepEqual(titles(player), ['secilen'], 'no other result was queued');
    });

    it('forgets the search origins when the queue ends', async () => {
      const { player, service, events, engine } = setup();
      await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [track('son')], fallback: track('yedek') });
      engine.emit('queueEnd', player);
      engine.emit('trackError', player, track('son'), AGE);
      await settle();
      assert.equal(events.at(-1)[0], 'failed');
      assert.deepEqual(titles(player), ['son'], 'no fallback was added');
    });

    it('a track that played normally does not keep its fallback', async () => {
      const { player, service, events, engine } = setup();
      await service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [track('a')], fallback: track('b') });
      engine.emit('trackEnd', player, track('a'), { reason: 'finished' });
      engine.emit('trackError', player, track('a'), AGE);
      await settle();
      assert.equal(events.at(-1)[0], 'failed');
    });

    it('play() with a song name keeps the second result as the fallback', async () => {
      const player = fakePlayer('g', { current: track('now') });
      const results = [track('x1'), track('x2'), track('x3')];
      const service = serviceWith(player, {
        loadTracks: async () => ({ loadType: 'search', tracks: results, playlist: null, exception: null }),
      });
      const events = [];
      service.on('trackRetried', (_g, failed, _r, next) => events.push([failed.title, next.title]));
      await service.play({ guildId: 'g', voiceChannelId: 'v1', query: 'şarkı adı', requester: null });
      serviceEngine.get(service).emit('trackError', player, results[0], AGE);
      await settle();
      assert.deepEqual(events, [['x1', 'x2']]);
    });
  });

  it('emits stateChanged after a change and forwards engine events', async () => {
    const player = fakePlayer('g', { current: track('now'), tracks: [track('a'), track('b')] });
    const service = serviceWith(player);
    const seen = [];
    service.on('stateChanged', (id) => seen.push(id));
    await service.shuffle('g');
    assert.deepEqual(seen, ['g']);
    const events = [];
    service.on('trackStarted', (g, t) => events.push(['started', t.title]));
    service.on('trackEnded', (g, t, reason) => events.push(['ended', t.title, reason]));
    service.on('playerDestroyed', (g, reason) => events.push(['destroyed', reason]));
    const engine = serviceEngine.get(service);
    engine.emit('trackStart', player, track('now'));
    engine.emit('trackEnd', player, track('now'), { reason: 'FINISHED' });
    engine.emit('playerDestroy', player, 'Durduruldu');
    assert.deepEqual(events, [
      ['started', 'now'],
      ['ended', 'now', 'finished'],
      ['destroyed', 'Durduruldu'],
    ]);
  });
});
