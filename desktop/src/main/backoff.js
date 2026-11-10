'use strict';

// Restart policy for crashed processes: exponential back-off with a cap and a limited
// number of attempts, so a process that keeps crashing never ends up in a tight loop.
// A process that stayed up for `stableAfterMs` counts as healthy again and gets a fresh
// set of attempts.

class RestartPolicy {
  /**
   * @param {{ baseMs?: number, maxMs?: number, maxAttempts?: number, stableAfterMs?: number, now?: () => number }} [options]
   */
  constructor({ baseMs = 2000, maxMs = 60_000, maxAttempts = 5, stableAfterMs = 120_000, now = Date.now } = {}) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.maxAttempts = maxAttempts;
    this.stableAfterMs = stableAfterMs;
    this.now = now;
    this.attempts = 0;
    this.upSince = null;
  }

  /** Call when the process became ready. */
  markUp() {
    this.upSince = this.now();
  }

  /**
   * Call after an unexpected exit. Returns the delay before the next start, or null when
   * the attempts are used up.
   */
  nextDelay() {
    if (this.upSince !== null && this.now() - this.upSince >= this.stableAfterMs) this.attempts = 0;
    this.upSince = null;
    if (this.attempts >= this.maxAttempts) return null;
    const delay = Math.min(this.baseMs * 2 ** this.attempts, this.maxMs);
    this.attempts += 1;
    return delay;
  }

  /** Forget earlier failures (e.g. after the user started the process by hand). */
  reset() {
    this.attempts = 0;
    this.upSince = null;
  }
}

module.exports = { RestartPolicy };
