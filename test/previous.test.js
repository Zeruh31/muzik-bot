// /previous and the "previous" button: TrackQueue#back under every repeat mode, and how a
// queue that went back keeps playing afterwards (repeat stays consistent).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TrackQueue } from '../src/music/Queue.js';

const t = (title) => ({ encoded: `enc-${title}`, info: { title } });
const titles = (list) => list.map((x) => x?.info.title ?? null);

/** A queue that played `played` in order and is now on `current` with `waiting` next. */
function queueAfter(played, current, waiting, repeatMode) {
  const q = new TrackQueue();
  q.tracks = [...played, current, ...waiting].map(t);
  q.advance();
  for (let i = 0; i < played.length; i++) q.next(repeatMode, 'finished');
  assert.equal(q.current.info.title, current);
  return q;
}

describe('TrackQueue#back (previous)', () => {
  it('repeat off: the current track goes back to the front, the previous one plays', () => {
    const q = queueAfter(['a'], 'b', ['c'], 'off');
    assert.equal(q.back('off').info.title, 'a');
    assert.deepEqual(titles(q.tracks), ['b', 'c']);
    assert.deepEqual(titles(q.previous), []);
    // Playing on gives the original order again.
    q.next('off', 'finished');
    assert.deepEqual([q.current.info.title, ...titles(q.tracks)], ['b', 'c']);
  });

  it('repeat queue: the previous track is taken from the end of the queue, not doubled', () => {
    const q = queueAfter(['a'], 'b', ['c'], 'queue');
    assert.deepEqual(titles(q.tracks), ['c', 'a'], 'a went to the end when it finished');
    assert.equal(q.back('queue').info.title, 'a');
    assert.deepEqual(titles(q.tracks), ['b', 'c']);
    q.next('queue', 'finished');
    assert.deepEqual([q.current.info.title, ...titles(q.tracks)], ['b', 'c', 'a'], 'the loop order is intact');
  });

  it('repeat queue with a single track does not duplicate it', () => {
    const q = new TrackQueue();
    q.tracks = [t('a')];
    q.advance();
    q.next('queue', 'finished'); // the same object comes round again
    q.back('queue');
    assert.equal(q.current.info.title, 'a');
    assert.deepEqual(titles(q.tracks), []);
  });

  it('repeat track: the previous track plays and is the one that repeats', () => {
    const q = queueAfter(['a'], 'b', [], 'off');
    q.back('track');
    assert.equal(q.next('track', 'finished').info.title, 'a', 'a repeats');
    assert.deepEqual(titles(q.tracks), ['b']);
  });

  it('works after the queue ended and returns null when there is nothing to go back to', () => {
    const q = new TrackQueue();
    assert.equal(q.back('off'), null);
    q.tracks = [t('a')];
    q.advance();
    q.next('off', 'finished'); // queue ended: a is in previous, nothing current
    assert.equal(q.current, null);
    assert.equal(q.back('off').info.title, 'a');
    assert.deepEqual(titles(q.tracks), []);
  });

  it('goes back several steps', () => {
    const q = queueAfter(['a', 'b'], 'c', [], 'off');
    q.back('off');
    q.back('off');
    assert.equal(q.current.info.title, 'a');
    assert.deepEqual(titles(q.tracks), ['b', 'c']);
  });
});
