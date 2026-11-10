// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Web paneli oturumlarını bellekte tutar, süresi dolanları siler.
// ---------------------------------------------------------------------------------------

import session from 'express-session';

/**
 * In-memory session store with expiry and a size cap.
 * express-session's built-in MemoryStore never prunes expired sessions; this one does.
 * Sessions are lost when the bot restarts, which is fine for a single-process panel.
 */
export class PanelSessionStore extends session.Store {
  #sessions = new Map();
  #maxSessions;
  #timer;

  constructor({ maxSessions = 5000, pruneIntervalMs = 10 * 60_000 } = {}) {
    super();
    this.#maxSessions = maxSessions;
    this.#timer = setInterval(() => this.prune(), pruneIntervalMs);
    this.#timer.unref();
  }

  #expiresAt(sess) {
    const expires = sess?.cookie?.expires;
    return expires ? new Date(expires).getTime() : Date.now() + 24 * 3600_000;
  }

  get(sid, callback) {
    const entry = this.#sessions.get(sid);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.#sessions.delete(sid);
      return callback(null, null);
    }
    callback(null, JSON.parse(entry.data));
  }

  set(sid, sess, callback) {
    if (!this.#sessions.has(sid) && this.#sessions.size >= this.#maxSessions) {
      this.prune();
      // Still full: drop the oldest session rather than grow without bound.
      if (this.#sessions.size >= this.#maxSessions) this.#sessions.delete(this.#sessions.keys().next().value);
    }
    this.#sessions.set(sid, { data: JSON.stringify(sess), expiresAt: this.#expiresAt(sess) });
    callback?.(null);
  }

  touch(sid, sess, callback) {
    const entry = this.#sessions.get(sid);
    if (entry) entry.expiresAt = this.#expiresAt(sess);
    callback?.(null);
  }

  destroy(sid, callback) {
    this.#sessions.delete(sid);
    callback?.(null);
  }

  prune() {
    const now = Date.now();
    for (const [sid, entry] of this.#sessions) if (entry.expiresAt <= now) this.#sessions.delete(sid);
  }

  get size() {
    return this.#sessions.size;
  }

  close() {
    clearInterval(this.#timer);
  }
}
