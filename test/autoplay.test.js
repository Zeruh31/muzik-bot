// MusicService side of the new features: autoplay at the queue end (YouTube mix first, then a
// search, never one of the last 50 songs), history recording without the requester, /previous,
// and loading saved entries (/liste, /gecmis) again through Lavalink.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createHistoryStore } from '../src/bot/gecmis.js';
import { MusicError } from '../src/music/errors.js';
import { AUTOPLAY_RECENT, MusicService, pickAutoplayCandidate, titleKey } from '../src/music/MusicService.js';
import { TrackQueue } from '../src/music/Queue.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const config = { music: { searchSource: 'ytsearch', defaultVolume: 80, maxQueueSize: 10, twentyFourSeven: false } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

const vid = (n) => `vid${String(n).padStart(8, '0')}`; // 11 characters, like a YouTube id
function yt(n, extra = {}) {
  return {
    encoded: `enc-${n}`,
    info: {
      title: `Şarkı ${n}`,
      author: 'Sanatçı',
      duration: 200_000,
      identifier: vid(n),
      uri: `https://www.youtube.com/watch?v=${vid(n)}`,
      sourceName: 'youtube',
      isStream: false,
      isSeekable: true,
      ...extra,
    },
    pluginInfo: {},
    requester: { id: '123456789012345678', username: 'kisi' },
  };
}

function fakePlayer(guildId, { current = null, tracks = [] } = {}) {
  const queue = new TrackQueue();
  queue.current = current;
  queue.tracks = [...tracks];
  return {
    guildId,
    voiceChannelId: 'v1',
    textChannelId: 't1',
    connected: true,
    playing: Boolean(current),
    paused: false,
    volume: 80,
    repeatMode: 'off',
    destroyed: false,
    position: 0,
    queue,
    getData: () => undefined,
    async connect() {},
    async play() {
      if (!queue.current) queue.advance();
      this.playing = Boolean(queue.current);
    },
    async previous() {
      const track = queue.back(this.repeatMode);
      this.playing = Boolean(track);
      return track;
    },
    async destroy() {
      this.destroyed = true;
    },
  };
}

function setup({
  player,
  loadTracks,
  autoplay = true,
  listeners = true,
  history = createHistoryStore({ file: null }),
}) {
  const engine = new EventEmitter();
  engine.players = new Map(player ? [[player.guildId, player]] : []);
  engine.getPlayer = (id) => engine.players.get(id) ?? null;
  engine.createPlayer = ({ guildId }) => {
    const created = fakePlayer(guildId);
    engine.players.set(guildId, created);
    return created;
  };
  const loads = [];
  const lavalink = {
    connected: true,
    hasSource: () => false,
    loadTracks: async (identifier) => {
      loads.push(identifier);
      return loadTracks(identifier);
    },
  };
  const settingsData = { autoplay };
  const settings = {
    getAutoplay: () => settingsData.autoplay,
    setAutoplay: (_g, value) => {
      settingsData.autoplay = value;
    },
  };
  const service = new MusicService({
    lavalink,
    engine,
    config,
    logger: silent,
    history,
    settings,
    hasListeners: () => listeners,
  });
  const events = [];
  for (const name of ['queueEnded', 'autoplayAdded', 'trackStarted']) {
    service.on(name, (...args) => events.push([name, ...args]));
  }
  return { service, engine, loads, events, history, settings: settingsData };
}

/** The player just finished `last` and nothing is queued: what GuildPlayer reports as queueEnd. */
function endedPlayer(last) {
  const player = fakePlayer('g', { current: last });
  player.queue.advance(); // last -> previous, nothing current
  player.playing = false;
  return player;
}

describe('autoplay', () => {
  it('picks the first playable YouTube song that is not one of the recent ones', () => {
    const recent = { ids: new Set([vid(1)]), titles: new Set([titleKey('Şarkı 2 (Official Video)')]) };
    const live = yt(3, { isStream: true });
    const soundcloud = yt(4, { sourceName: 'soundcloud' });
    const picked = pickAutoplayCandidate([yt(1), yt(2), live, soundcloud, yt(5)], recent);
    assert.equal(picked.info.title, 'Şarkı 5');
    assert.equal(titleKey('Tarkan - Şımarık [4K] (Official Video)'), 'tarkan şımarık');
    assert.equal(pickAutoplayCandidate([yt(1)], recent), null);
  });

  it('queues a song from the YouTube mix of the last song, marked as autoplay, without a requester', async () => {
    const player = endedPlayer(yt(1));
    const t = setup({
      player,
      loadTracks: async () => ({ loadType: 'playlist', tracks: [yt(1), yt(2), yt(3)] }),
    });
    t.engine.emit('queueEnd', player);
    await flush();
    await flush();
    assert.deepEqual(t.loads, [`https://www.youtube.com/watch?v=${vid(1)}&list=RD${vid(1)}`]);
    assert.equal(player.queue.current.info.title, 'Şarkı 2', 'the seed itself is skipped');
    assert.equal(player.queue.current.autoplay, true);
    assert.equal(player.queue.current.requester, null);
    assert.deepEqual(
      t.events.map((e) => e[0]),
      ['autoplayAdded'],
      'no "queue ended" message',
    );
    assert.equal(t.events[0][2].autoplay, true);
    assert.equal(t.service.getState('g').current.autoplay, true);
  });

  it('never repeats one of the last 50 played songs; older ones may come back', async () => {
    const history = createHistoryStore({ file: null });
    // Songs 2..51 are the last 50 (51 newest); song 60 was played before them.
    history.record('g', { title: 'Şarkı 60', uri: 'https://x/60', videoId: vid(60) });
    for (let n = 2; n <= 51; n++) history.record('g', { title: `Şarkı ${n}`, uri: `https://x/${n}`, videoId: vid(n) });
    assert.equal(history.list('g').length, AUTOPLAY_RECENT + 1);
    const player = endedPlayer(yt(1));
    const mix = [yt(1), ...Array.from({ length: 50 }, (_, i) => yt(i + 2)), yt(60), yt(70)];
    const t = setup({ player, history, loadTracks: async () => ({ loadType: 'playlist', tracks: mix }) });
    t.engine.emit('queueEnd', player);
    await flush();
    await flush();
    assert.equal(player.queue.current.info.title, 'Şarkı 60');
  });

  it('falls back to an artist + title search when the mix does not load', async () => {
    const player = endedPlayer(yt(1));
    const t = setup({
      player,
      loadTracks: async (id) =>
        id.startsWith('ytsearch:') ? { loadType: 'search', tracks: [yt(1), yt(8)] } : { loadType: 'empty', tracks: [] },
    });
    t.engine.emit('queueEnd', player);
    await flush();
    await flush();
    assert.equal(t.loads[1], 'ytsearch:Sanatçı Şarkı 1');
    assert.equal(player.queue.current.info.title, 'Şarkı 8');
  });

  it('when off, nothing is looked up and the queue end is announced at once', () => {
    const player = endedPlayer(yt(1));
    const t = setup({ player, autoplay: false, loadTracks: async () => assert.fail('no lookup') });
    t.engine.emit('queueEnd', player);
    assert.deepEqual(
      t.events.map((e) => e[0]),
      ['queueEnded'],
    );
  });

  it('adds nothing to an empty voice channel and when nothing similar is found', async () => {
    const empty = setup({
      player: endedPlayer(yt(1)),
      listeners: false,
      loadTracks: async () => assert.fail('no lookup'),
    });
    empty.engine.emit('queueEnd', empty.engine.getPlayer('g'));
    await flush();
    assert.deepEqual(
      empty.events.map((e) => e[0]),
      ['queueEnded'],
    );

    const nothing = setup({ player: endedPlayer(yt(1)), loadTracks: async () => ({ loadType: 'empty', tracks: [] }) });
    nothing.engine.emit('queueEnd', nothing.engine.getPlayer('g'));
    await flush();
    await flush();
    assert.deepEqual(
      nothing.events.map((e) => e[0]),
      ['queueEnded'],
    );
  });

  it('the setting shows in getState and can be toggled', () => {
    const t = setup({ player: fakePlayer('g', { current: yt(1) }), autoplay: false, loadTracks: async () => ({}) });
    assert.equal(t.service.getState('g').autoplay, false);
    t.service.setAutoplay('g', true);
    assert.equal(t.service.isAutoplay('g'), true);
    assert.equal(t.service.getState('g').autoplay, true);
  });
});

describe('history recording', () => {
  it('records started songs without the requester', () => {
    const player = fakePlayer('g', { current: yt(1) });
    const t = setup({ player, loadTracks: async () => ({}) });
    t.engine.emit('trackStart', player, yt(1));
    const [entry] = t.service.getHistory('g');
    assert.equal(entry.title, 'Şarkı 1');
    assert.equal(entry.videoId, vid(1));
    assert.ok(!('requester' in entry));
    assert.ok(!JSON.stringify(entry).includes('123456789012345678'));
    assert.equal(t.events[0][0], 'trackStarted');
  });
});

describe('previous through MusicService', () => {
  it('refuses when there is nothing before, plays the previous song otherwise', async () => {
    const player = fakePlayer('g', { current: yt(1), tracks: [yt(2)] });
    const t = setup({ player, loadTracks: async () => ({}) });
    assert.equal(t.service.getState('g').hasPrevious, false);
    await assert.rejects(t.service.previous('g'), (e) => e instanceof MusicError && e.code === 'NO_PREVIOUS');
    player.queue.advance(); // 1 played, 2 now
    assert.equal(t.service.getState('g').hasPrevious, true);
    const now = await t.service.previous('g');
    assert.equal(now.title, 'Şarkı 1');
    assert.deepEqual(
      player.queue.tracks.map((x) => x.info.title),
      ['Şarkı 2'],
    );
  });
});

describe('saved entries', () => {
  it('load again by uri, fall back to the YouTube source, count what is gone', async () => {
    const byUri = {
      'https://www.youtube.com/watch?v=a': { loadType: 'track', tracks: [yt(1)] },
      'https://open.spotify.com/track/gone': { loadType: 'error', tracks: [] },
      'https://www.youtube.com/watch?v=mirror': { loadType: 'track', tracks: [yt(2)] },
    };
    const t = setup({ player: null, loadTracks: async (uri) => byUri[uri] ?? { loadType: 'empty', tracks: [] } });
    const { tracks, failed } = await t.service.resolveSaved(
      [
        { uri: 'https://www.youtube.com/watch?v=a', title: 'a', duration: 1 },
        { uri: 'https://open.spotify.com/track/gone', sourceUri: 'https://www.youtube.com/watch?v=mirror', title: 's' },
        { uri: 'https://www.youtube.com/watch?v=deleted', title: 'd' },
        { uri: 'ytsearch:not a link', title: 'x' },
      ],
      { id: '1', username: 'u' },
    );
    assert.deepEqual(
      tracks.map((x) => x.info.title),
      ['Şarkı 1', 'Şarkı 2'],
    );
    assert.equal(failed, 2);
    assert.ok(!t.loads.includes('ytsearch:not a link'), 'only http(s) addresses are loaded');
    assert.equal(tracks[0].requester.id, '1');
  });

  it('playSaved starts the first song at once, queues the rest in the background with progress', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const t = setup({
      player: null,
      loadTracks: async (uri) => {
        if (!uri.endsWith('x00')) await gate; // everything after the first song waits
        return { loadType: 'track', tracks: [yt(uri.slice(-2))] };
      },
    });
    const entries = Array.from({ length: 15 }, (_, i) => ({ uri: `https://youtu.be/x${String(i).padStart(2, '0')}` }));
    const progress = [];
    const result = await t.service.playSaved({
      guildId: 'g',
      voiceChannelId: 'v1',
      textChannelId: 't1',
      entries,
      requester: null,
      playlistName: 'Liste',
      onProgress: (p) => progress.push(p.added),
    });
    const player = t.engine.getPlayer('g');
    assert.equal(player.queue.current.info.title, 'Şarkı 00', 'plays before the rest is loaded');
    assert.equal(player.queue.tracks.length, 0);
    assert.deepEqual([result.kind, result.playlistName, result.total], ['playlist', 'Liste', 15]);
    await assert.rejects(
      t.service.playSaved({ guildId: 'g', voiceChannelId: 'v1', entries }),
      (e) => e.code === 'BUSY' && /liste yükleniyor/.test(e.message),
      'one list load per server at a time',
    );
    release();
    const final = await result.done;
    assert.equal(t.loads.length, 10, 'maxQueueSize is 10: only what fits is loaded');
    assert.deepEqual([final.added, final.failed, final.skippedForLimit, final.stopped], [10, 0, 5, false]);
    assert.deepEqual(progress, [10]);
    assert.deepEqual(
      player.queue.tracks.map((x) => x.info.title).slice(0, 3),
      ['Şarkı 01', 'Şarkı 02', 'Şarkı 03'],
      'in list order',
    );
    // The lock is gone once the load finished.
    await t.service.playSaved({ guildId: 'g', voiceChannelId: 'v1', entries: entries.slice(0, 1) }).catch(() => {});
  });

  it('a list load stops when the player is stopped meanwhile', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const t = setup({
      player: null,
      loadTracks: async (uri) => {
        if (!uri.endsWith('x00')) await gate;
        return { loadType: 'track', tracks: [yt(uri.slice(-2))] };
      },
    });
    const entries = Array.from({ length: 5 }, (_, i) => ({ uri: `https://youtu.be/x${String(i).padStart(2, '0')}` }));
    const result = await t.service.playSaved({ guildId: 'g', voiceChannelId: 'v1', entries });
    const player = t.engine.getPlayer('g');
    player.destroyed = true;
    t.engine.players.delete('g');
    release();
    const final = await result.done;
    assert.equal(final.stopped, true);
    assert.equal(t.engine.getPlayer('g'), null, 'no new player was created');
  });

  it('a list where nothing loads is an error', async () => {
    await assert.rejects(
      setup({ player: null, loadTracks: async () => ({ loadType: 'empty', tracks: [] }) }).service.playSaved({
        guildId: 'g',
        voiceChannelId: 'v1',
        entries: [{ uri: 'https://youtu.be/x' }],
      }),
      (e) => e.code === 'LOAD_FAILED',
    );
  });
});

describe('autoplay robustness', () => {
  /** Simulates GuildPlayer: the autoplay song fails to play, then the queue ends again. */
  function failCurrent(t, player) {
    const failed = player.queue.current;
    t.engine.emit('trackError', player, failed, { exception: { message: 'Sign in to confirm your age' } });
    player.queue.advance();
    if (player.queue.previous[0] === failed) player.queue.previous.shift();
    player.playing = false;
    t.engine.emit('queueEnd', player);
  }

  it('never picks a failed song again and stops after 3 failures in a row with one message', async () => {
    const player = endedPlayer(yt(1));
    const mix = [yt(1), yt(2), yt(3), yt(4), yt(5), yt(6)];
    const t = setup({ player, loadTracks: async () => ({ loadType: 'playlist', tracks: mix }) });
    const stopped = [];
    t.service.on('autoplayStopped', (g) => stopped.push(g));
    const picked = [];
    t.service.on('autoplayAdded', (_g, view) => picked.push(view.title));

    t.engine.emit('queueEnd', player);
    for (let i = 0; i < 6; i++) {
      await flush();
      await flush();
      if (player.queue.current) failCurrent(t, player);
    }
    assert.deepEqual(picked, ['Şarkı 2', 'Şarkı 3', 'Şarkı 4'], 'a different song each time');
    assert.deepEqual(stopped, ['g'], 'one stop notice');
    const lookups = t.loads.length;
    t.engine.emit('queueEnd', player);
    await flush();
    assert.equal(t.loads.length, lookups, 'no more Lavalink requests');
    assert.equal(t.events.filter((e) => e[0] === 'queueEnded').length >= 1, true);

    // Someone queues a song again: autoplay works again (and still skips the failed ones).
    await t.service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [yt(9)] });
    player.queue.advance();
    player.playing = false;
    t.engine.emit('queueEnd', player);
    await flush();
    await flush();
    assert.equal(picked.at(-1), 'Şarkı 5');
  });

  it('a song added by someone during the lookup is not followed by a "queue ended" message', async () => {
    const player = endedPlayer(yt(1));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const t = setup({
      player,
      loadTracks: async () => {
        await gate;
        return { loadType: 'playlist', tracks: [yt(2)] };
      },
    });
    t.engine.emit('queueEnd', player);
    await flush();
    await t.service.enqueue({ guildId: 'g', voiceChannelId: 'v1', tracks: [yt(7)] }); // a user's /play
    release();
    await flush();
    await flush();
    assert.deepEqual(
      t.events.filter((e) => e[0] === 'queueEnded' || e[0] === 'autoplayAdded'),
      [],
    );
    assert.equal(player.queue.current.info.title, 'Şarkı 7');
    assert.equal(player.queue.tracks.length, 0, 'autoplay did not add anything after it');
  });
});
