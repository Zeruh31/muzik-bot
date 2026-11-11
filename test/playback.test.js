// Building blocks of the bot's own playback: the queue transitions, the ffmpeg command line
// (seek, bass filter chain), the position formula and where a track's audio is fetched from.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertStreamable, isStreamable, mirrorQueries, resolveStreamSource } from '../src/music/audioSource.js';
import { BASSBOOST_FILTERS, audioFilter, buildFfmpegArgs, findFfmpeg, resetFfmpegCache } from '../src/music/ffmpeg.js';
import { computePosition } from '../src/music/GuildPlayer.js';
import { TrackQueue } from '../src/music/Queue.js';

const track = (title, extra = {}) => ({ encoded: `enc-${title}`, info: { title, author: 'Sanatçı', ...extra } });
const titles = (queue) => queue.tracks.map((t) => t.info.title);

describe('TrackQueue', () => {
  it('add, insert, remove, splice, clear', () => {
    const q = new TrackQueue();
    q.add([track('a'), track('b')]);
    q.add(track('x'), 1);
    assert.deepEqual(titles(q), ['a', 'x', 'b']);
    assert.equal(q.remove(1).info.title, 'x');
    assert.equal(q.remove(9), null);
    assert.deepEqual(
      q.splice(0, 1).map((t) => t.info.title),
      ['a'],
    );
    q.add(track('c'), 99);
    assert.deepEqual(titles(q), ['b', 'c']);
    assert.equal(q.clear(), 2);
    assert.equal(q.size, 0);
  });

  it('advance moves the current track into previous (most recent first)', () => {
    const q = new TrackQueue();
    q.add([track('a'), track('b')]);
    assert.equal(q.advance().info.title, 'a');
    assert.equal(q.advance().info.title, 'b');
    assert.equal(q.advance(), null);
    assert.deepEqual(
      q.previous.map((t) => t.info.title),
      ['b', 'a'],
    );
  });

  it('next() follows the repeat mode', () => {
    const q = new TrackQueue();
    q.current = track('now');
    q.add([track('a')]);
    assert.equal(q.next('track', 'finished').info.title, 'now', 'track repeat replays a finished track');
    assert.equal(q.next('track', 'replaced').info.title, 'a', 'but not a skipped one');
    q.current = track('a');
    q.add([track('b')]);
    assert.equal(q.next('queue', 'finished').info.title, 'b');
    assert.deepEqual(titles(q), ['a'], 'queue repeat puts the finished track at the end');
    assert.equal(q.next('queue', 'replaced').info.title, 'a', 'a skipped track also goes to the end');
    assert.deepEqual(titles(q), ['b']);
    assert.equal(q.next('off', 'finished').info.title, 'b');
    assert.equal(q.next('off', 'finished'), null);
  });

  it('shuffle keeps the same tracks', () => {
    const q = new TrackQueue();
    q.add(['a', 'b', 'c', 'd'].map((t) => track(t)));
    q.shuffle(() => 0); // deterministic
    assert.deepEqual(titles(q).sort(), ['a', 'b', 'c', 'd']);
  });
});

describe('ffmpeg command line', () => {
  it('converts stdin to 48 kHz stereo 16-bit PCM on stdout', () => {
    const args = buildFfmpegArgs();
    assert.deepEqual(args.slice(-7), ['-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
    assert.ok(args.includes('pipe:0'));
    assert.ok(!args.includes('-ss'), 'no seek by default');
    assert.ok(!args.includes('-af'), 'no filter by default');
  });

  it('seeks before the input and formats seconds with millisecond precision', () => {
    const args = buildFfmpegArgs({ seekMs: 90_500 });
    const ss = args.indexOf('-ss');
    assert.equal(args[ss + 1], '90.500');
    assert.ok(ss < args.indexOf('-i'), '-ss comes before -i (input seeking)');
    assert.ok(!buildFfmpegArgs({ seekMs: 0 }).includes('-ss'));
    assert.ok(!buildFfmpegArgs({ seekMs: Number.NaN }).includes('-ss'));
  });

  it('bass boost levels become a bass filter followed by a limiter', () => {
    for (const level of ['low', 'medium', 'high']) {
      const filter = audioFilter({ bassboost: level });
      assert.match(filter, /^bass=g=\d+:f=110:w=0\.6,alimiter=/);
      assert.deepEqual(buildFfmpegArgs({ bassboost: level }).slice(-9, -7), ['-af', BASSBOOST_FILTERS[level]]);
    }
    assert.equal(audioFilter({ bassboost: 'none' }), null);
    assert.equal(audioFilter({ bassboost: 'earrape' }), null);
    assert.ok(/g=5:/.test(BASSBOOST_FILTERS.low) && /g=15:/.test(BASSBOOST_FILTERS.high), 'levels increase');
  });

  it('findFfmpeg prefers the system binary and falls back to ffmpeg-static', async () => {
    resetFfmpegCache();
    assert.equal(await findFfmpeg({ probe: () => true, loadStatic: async () => '/static/ffmpeg' }), 'ffmpeg');
    resetFfmpegCache();
    assert.equal(await findFfmpeg({ probe: () => false, loadStatic: async () => '/static/ffmpeg' }), '/static/ffmpeg');
    resetFfmpegCache();
    assert.equal(await findFfmpeg({ probe: () => false, loadStatic: async () => null }), null);
    resetFfmpegCache();
  });
});

describe('computePosition', () => {
  it('adds the played audio to the seek start and caps at the duration', () => {
    assert.equal(computePosition({ seekBaseMs: 30_000, playbackDuration: 5000, duration: 100_000 }), 35_000);
    assert.equal(computePosition({ seekBaseMs: 99_000, playbackDuration: 5000, duration: 100_000 }), 100_000);
    assert.equal(computePosition({ seekBaseMs: 0, playbackDuration: 5000, duration: 0, isStream: true }), 5000);
    assert.equal(computePosition({}), 0);
  });
});

describe('audio source', () => {
  it('YouTube tracks stream their own video id', async () => {
    const result = await resolveStreamSource(track('a', { sourceName: 'youtube', identifier: 'dQw4w9WgXcQ' }), {});
    assert.deepEqual(result, { kind: 'youtube', videoId: 'dQw4w9WgXcQ', mirrored: null });
  });

  it('mirrored sources (Spotify) search YouTube by ISRC first, then by title and artist', async () => {
    const spotify = track('Never Gonna Give You Up', {
      sourceName: 'spotify',
      author: 'Rick Astley',
      isrc: 'GBARL9300135',
    });
    assert.deepEqual(mirrorQueries(spotify), [
      'ytsearch:"GBARL9300135"',
      'ytsearch:Never Gonna Give You Up Rick Astley',
    ]);
    const asked = [];
    const rest = {
      loadTracks: async (identifier) => {
        asked.push(identifier);
        if (asked.length === 1) return { loadType: 'empty', tracks: [] };
        return { loadType: 'search', tracks: [track('hit', { sourceName: 'youtube', identifier: 'yt123' })] };
      },
    };
    const result = await resolveStreamSource(spotify, rest);
    assert.equal(result.videoId, 'yt123');
    assert.equal(result.mirrored.info.title, 'hit');
    assert.equal(asked.length, 2);
  });

  it('a mirrored track without a YouTube match fails with a Turkish message', async () => {
    const rest = { loadTracks: async () => ({ loadType: 'empty', tracks: [] }) };
    await assert.rejects(
      resolveStreamSource(track('x', { sourceName: 'spotify' }), rest),
      (e) => e.code === 'LOAD_FAILED' && /YouTube'da karşılığı bulunamadı/.test(e.message),
    );
  });

  it('isStreamable / assertStreamable decide before anything is queued', () => {
    assert.equal(isStreamable(track('a', { sourceName: 'youtube', identifier: 'x' })), true);
    assert.equal(isStreamable(track('a', { sourceName: 'spotify' })), true);
    assert.equal(isStreamable(track('a', { sourceName: 'soundcloud', identifier: '1' })), false);
    assert.equal(isStreamable(track('a', { sourceName: 'youtube' })), false, 'YouTube without an id');
    assert.throws(
      () => assertStreamable(track('a', { sourceName: 'bandcamp' })),
      (e) => e.code === 'SOURCE_UNSUPPORTED',
    );
    assert.doesNotThrow(() => assertStreamable(track('a', { sourceName: 'spotify' })));
  });

  it('a mirrored track remembers its YouTube match and reuses it', async () => {
    const spotify = track('sp', { sourceName: 'spotify', isrc: 'X' });
    let asked = 0;
    const rest = {
      loadTracks: async () => {
        asked += 1;
        return { loadType: 'search', tracks: [track('hit', { sourceName: 'youtube', identifier: 'yt123', uri: 'u' })] };
      },
    };
    await resolveStreamSource(spotify, rest);
    const again = await resolveStreamSource(spotify, rest);
    assert.equal(asked, 1);
    assert.equal(again.videoId, 'yt123');
    assert.deepEqual([spotify.mirror.videoId, spotify.mirror.title, spotify.mirror.uri], ['yt123', 'hit', 'u']);
  });

  it('other sources are refused as unsupported for now', async () => {
    await assert.rejects(
      resolveStreamSource(track('x', { sourceName: 'bandcamp', identifier: '1' }), {}),
      (e) => e.code === 'SOURCE_UNSUPPORTED' && /bandcamp/.test(e.message) && /şimdilik desteklenmiyor/.test(e.message),
    );
  });
});
