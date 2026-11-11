// Şarkılar arası yumuşak geçiş (crossfade): çalan şarkının sesi kısılırken sıradakinin sesi açılır.
// İki ffmpeg'in ham PCM çıktısı burada, Node içinde karıştırılır. README > Teknik notlar.
// Normalde dokunmana gerek yok.

import { Readable } from 'node:stream';

/** 48 kHz, 2 channels, 16-bit: bytes of PCM per millisecond and per sample frame. */
export const PCM_BYTES_PER_MS = 192;
export const PCM_FRAME_BYTES = 4;
export const CROSSFADE_MIN_SECONDS = 0;
export const CROSSFADE_MAX_SECONDS = 12;

/** Byte offset (multiple of a sample frame) of a time in PCM. */
export function pcmBytes(ms) {
  return Math.max(0, Math.floor((ms * PCM_BYTES_PER_MS) / PCM_FRAME_BYTES) * PCM_FRAME_BYTES);
}

/**
 * Equal-power gains at fade progress p in [0, 1]: the outgoing track follows cos, the incoming
 * one sin, so the loudness of two unrelated songs stays about the same through the fade
 * (a linear fade dips by ~3 dB in the middle).
 */
export function fadeGains(p) {
  const x = Math.min(1, Math.max(0, p));
  return { out: Math.cos((x * Math.PI) / 2), in: Math.sin((x * Math.PI) / 2) };
}

/**
 * Mixes `length` bytes of PCM: a (outgoing) fades out, b (incoming) fades in, starting `offset`
 * bytes into a fade of `fadeBytes`. A missing side (null: that source ended) counts as silence.
 * Returns a new Buffer of `length` bytes. Pure function, used by CrossfadeMixer and the tests.
 */
export function mixFade(a, b, { offset, fadeBytes, length }) {
  const out = Buffer.alloc(length);
  for (let pos = 0; pos < length; pos += PCM_FRAME_BYTES) {
    const { out: gOut, in: gIn } = fadeGains((offset + pos) / fadeBytes);
    for (let i = pos; i < pos + PCM_FRAME_BYTES; i += 2) {
      const sa = a && i + 1 < a.length ? a.readInt16LE(i) : 0;
      const sb = b && i + 1 < b.length ? b.readInt16LE(i) : 0;
      const v = Math.round(sa * gOut + sb * gIn);
      out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
    }
  }
  return out;
}

/**
 * The PCM stream an AudioResource plays. In "pass" mode it hands the primary source (one track's
 * ffmpeg output) through unchanged. A scheduled fade starts at byte `atByte` of this stream: from
 * there `fadeBytes` of PCM are the mix of the primary (fading out) and `next` (the next track's own
 * mixer, fading in), then this stream ends. Whatever `next` has not given yet stays in `next`, so
 * the next track's AudioResource continues exactly where the fade stopped: no sample is lost or
 * played twice.
 *
 * Invariants:
 *  - bytesOut counts the bytes pushed; from the fade start on it is a multiple of PCM_FRAME_BYTES;
 *  - `next` is only read during the fade, never more than the fade needs, and only whole frames;
 *  - data is only pulled from the sources while the consumer wants it (back-pressure), so memory
 *    stays at a few stream buffers whatever ffmpeg's speed;
 *  - onStart() runs once, synchronously, right before the first mixed byte; shouldStart() is asked
 *    first (false keeps pass mode and drops the fade).
 */
export class CrossfadeMixer extends Readable {
  bytesOut = 0;
  /** 'pass' | 'fade' | 'ended' */
  mode = 'pass';
  #primary;
  #primaryEnded = false;
  #primaryLeft = null; // bytes taken from the primary but not pushed yet
  #fade = null; // { atByte, fadeBytes, done, next, nextEnded, onStart, shouldStart }
  /** The consumer asked for data (_read) and has not said "full" (push() === false) since. */
  #wanted = false;
  #pumping = false;
  #listeners = [];

  /**
   * A small buffer (16 KB = 83 ms of PCM) keeps the read-ahead short, so a fade starts and the
   * track switch is announced close to the moment it becomes audible.
   */
  constructor(primary, { highWaterMark = 16 * 1024 } = {}) {
    super({ highWaterMark });
    this.#primary = primary;
    this.#watch(primary, () => {
      this.#primaryEnded = true;
    });
  }

  /** Bytes the consumer has taken (bytesOut minus what still waits in this stream's buffer). */
  get consumed() {
    return this.bytesOut - this.readableLength;
  }

  /** Whether a fade has been scheduled and has not started or been cancelled. */
  get fadeScheduled() {
    return Boolean(this.#fade) && this.mode === 'pass';
  }

  /**
   * Schedules the fade at byte `atByte` of this stream (never before what was already sent).
   * `next` must be a paused Readable of PCM (normally the next track's CrossfadeMixer).
   */
  scheduleFade({ atByte, fadeBytes, next, onStart = () => {}, shouldStart = () => true }) {
    if (this.mode !== 'pass' || this.#fade || this.destroyed) return false;
    const alignedSent = Math.ceil(this.bytesOut / PCM_FRAME_BYTES) * PCM_FRAME_BYTES;
    const at = Math.max(alignedSent, atByte - (atByte % PCM_FRAME_BYTES));
    const length = Math.max(PCM_FRAME_BYTES, fadeBytes - (fadeBytes % PCM_FRAME_BYTES));
    this.#fade = { atByte: at, fadeBytes: length, done: 0, next, nextEnded: false, onStart, shouldStart };
    this.#watch(next, () => {
      if (this.#fade?.next === next) this.#fade.nextEnded = true;
    });
    this.#pump();
    return true;
  }

  /** Drops a scheduled fade that has not started yet (the primary just plays on). */
  cancelFade() {
    if (this.mode !== 'pass' || !this.#fade) return false;
    this.#unwatch(this.#fade.next);
    this.#fade = null;
    return true;
  }

  _read() {
    this.#wanted = true;
    this.#pump();
  }

  _destroy(error, callback) {
    this.mode = 'ended';
    this.#unwatchAll();
    this.#fade = null;
    this.#primaryLeft = null;
    callback(error);
  }

  #watch(stream, onEnd) {
    const wake = () => this.#pump();
    const end = () => {
      onEnd();
      this.#pump();
    };
    const error = (err) => {
      if (stream === this.#primary && this.mode === 'pass') this.destroy(err);
      else end();
    };
    stream.on('readable', wake);
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', error);
    this.#listeners.push([stream, wake, end, error]);
  }

  #unwatch(target) {
    this.#listeners = this.#listeners.filter(([stream, wake, end, error]) => {
      if (stream !== target) return true;
      stream.off('readable', wake);
      stream.off('end', end);
      stream.off('close', end);
      stream.off('error', error);
      return false;
    });
  }

  #unwatchAll() {
    for (const [stream] of [...this.#listeners]) this.#unwatch(stream);
  }

  #emit(chunk) {
    this.bytesOut += chunk.length;
    this.#wanted = this.push(chunk);
  }

  #pump() {
    if (this.#pumping) return; // re-entered from a source event inside read()
    this.#pumping = true;
    try {
      while (this.#wanted && !this.destroyed && this.mode !== 'ended') {
        const progressed = this.mode === 'pass' ? this.#stepPass() : this.#stepFade();
        if (!progressed) break;
      }
    } finally {
      this.#pumping = false;
    }
  }

  #primaryDone() {
    return (
      !this.#primaryLeft &&
      this.#primary.readableLength === 0 &&
      (this.#primaryEnded || this.#primary.readableEnded || this.#primary.destroyed)
    );
  }

  /** One step in pass mode. Returns false when it has to wait for the primary. */
  #stepPass() {
    const fade = this.#fade;
    if (fade && this.bytesOut >= fade.atByte) {
      if (!fade.shouldStart()) {
        this.cancelFade();
        return true;
      }
      this.mode = 'fade';
      fade.onStart();
      return true;
    }
    let chunk;
    if (this.#primaryLeft) {
      chunk = this.#primaryLeft;
      this.#primaryLeft = null;
    } else {
      chunk = this.#primary.read();
    }
    if (!chunk) {
      if (this.#primaryDone()) this.#finish();
      return false;
    }
    const limit = fade ? fade.atByte - this.bytesOut : Infinity;
    if (chunk.length > limit) {
      this.#primaryLeft = chunk.subarray(limit);
      chunk = chunk.subarray(0, limit);
    }
    this.#emit(chunk);
    return true;
  }

  /** One step of the fade: mixes as many whole frames as both sides can give right now. */
  #stepFade() {
    const fade = this.#fade;
    const remaining = fade.fadeBytes - fade.done;
    const primaryDone = this.#primaryDone();
    if (!fade.nextEnded && fade.next.readableLength === 0 && (fade.next.readableEnded || fade.next.destroyed)) {
      fade.nextEnded = true;
    }
    if (remaining <= 0 || (primaryDone && fade.nextEnded)) {
      this.#finish();
      return false;
    }
    const primaryAvail = primaryDone ? Infinity : (this.#primaryLeft?.length ?? 0) + this.#primary.readableLength;
    const nextAvail = fade.nextEnded ? Infinity : fade.next.readableLength;
    let length = Math.min(remaining, 16 * 1024, primaryAvail, nextAvail);
    length -= length % PCM_FRAME_BYTES;
    if (length <= 0) {
      // read(0) makes an empty source fetch more and emit 'readable' (or 'end') later.
      if (!primaryDone && primaryAvail < PCM_FRAME_BYTES) this.#primary.read(0);
      if (!fade.nextEnded && nextAvail < PCM_FRAME_BYTES) fade.next.read(0);
      return false;
    }
    const a = primaryDone ? null : this.#readPrimary(length);
    const b = fade.nextEnded ? null : fade.next.read(length);
    this.#emit(mixFade(a, b, { offset: fade.done, fadeBytes: fade.fadeBytes, length }));
    fade.done += length;
    return true;
  }

  /** Exactly `length` bytes of the primary (the caller checked they are buffered). */
  #readPrimary(length) {
    let head = null;
    if (this.#primaryLeft) {
      head = this.#primaryLeft;
      this.#primaryLeft = null;
      if (head.length >= length) {
        if (head.length > length) this.#primaryLeft = head.subarray(length);
        return head.subarray(0, length);
      }
    }
    const rest = this.#primary.read(length - (head?.length ?? 0));
    if (!head) return rest;
    return rest ? Buffer.concat([head, rest]) : head;
  }

  #finish() {
    if (this.mode === 'ended') return;
    this.mode = 'ended';
    this.#unwatchAll();
    this.#fade = null;
    this.push(null);
  }
}
