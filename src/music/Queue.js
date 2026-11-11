// Şarkı kuyruğu: çalan parça, sıradakiler ve son çalınanlar. Yalnız bellekte tutulur.
// MusicService bunu kullanır; normalde dokunmana gerek yok.

const MAX_PREVIOUS = 25;

/**
 * Plain in-memory queue. All methods are synchronous; positions are 0-based here
 * (MusicService converts from the 1-based numbers users type).
 */
export class TrackQueue {
  /** @type {object|null} */
  current = null;
  /** @type {object[]} */
  tracks = [];
  /** @type {object[]} most recent first */
  previous = [];

  get size() {
    return this.tracks.length;
  }

  /** Appends one or more tracks, or inserts them at `index` when given. Returns the new size. */
  add(trackOrTracks, index = null) {
    const list = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
    const clean = list.filter(Boolean);
    if (index === null || index === undefined || index >= this.tracks.length) this.tracks.push(...clean);
    else this.tracks.splice(Math.max(0, index), 0, ...clean);
    return this.tracks.length;
  }

  /** Removes and returns the track at `index`, or null. */
  remove(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.tracks.length) return null;
    return this.tracks.splice(index, 1)[0] ?? null;
  }

  /** Array#splice on the waiting tracks; returns the removed tracks. */
  splice(start, deleteCount, ...insert) {
    return this.tracks.splice(start, deleteCount, ...insert);
  }

  /** Fisher-Yates shuffle of the waiting tracks. */
  shuffle(random = Math.random) {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
  }

  /** Empties the waiting tracks; returns how many were removed. */
  clear() {
    const count = this.tracks.length;
    this.tracks.length = 0;
    return count;
  }

  /**
   * Moves to the next track and returns it (null when the queue is empty).
   * The track that was playing is remembered in `previous`.
   */
  advance() {
    if (this.current) this.remember(this.current);
    this.current = this.tracks.shift() ?? null;
    return this.current;
  }

  /** Puts a track at the top of `previous` (most recent first, at most MAX_PREVIOUS kept). */
  remember(track) {
    if (!track) return;
    this.previous.unshift(track);
    if (this.previous.length > MAX_PREVIOUS) this.previous.length = MAX_PREVIOUS;
  }

  /**
   * Goes back one track (/previous): `current` returns to the front of the waiting tracks and
   * the most recent previous track becomes `current`. With queue repeat that previous track was
   * also put at the end of the queue when it ended; it is taken from there so it is not doubled.
   * Returns the new current track, or null when there is nothing to go back to.
   */
  back(repeatMode) {
    const target = this.previous.shift();
    if (!target) return null;
    if (repeatMode === 'queue' && this.tracks.at(-1) === target) this.tracks.pop();
    if (this.current && this.current !== target) this.tracks.unshift(this.current);
    this.current = target;
    return target;
  }

  /**
   * Decides what plays after `current` ended with `reason` under `repeatMode`:
   * 'track' repeats the same track when it finished on its own, 'queue' puts it back at the end.
   * Returns the next track (or null) and makes it `current`.
   */
  next(repeatMode, reason) {
    if (this.current && repeatMode === 'track' && reason === 'finished') return this.current;
    if (this.current && repeatMode === 'queue' && (reason === 'finished' || reason === 'replaced')) {
      this.tracks.push(this.current);
    }
    return this.advance();
  }
}
