// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Bot ile Lavalink arasındaki bağlantıyı kurar. Lavalink burada
// yalnız arama/çözümleme, YouTube akışı ve şarkı sözü için kullanılır (REST); ses Discord'a
// botun kendisi tarafından gönderilir (src/music/GuildPlayer.js, README > Teknik notlar).
// ---------------------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const NODE_ID = 'yerel';
const POLL_UP_MS = 10_000;
const POLL_DOWN_MS = 2000;
const RETRY_LOG_EVERY_MS = 30_000;

/** HTTP error from Lavalink's REST API (4xx/5xx) with the message Lavalink sent. */
export class LavalinkRequestError extends Error {
  constructor(status, message, path) {
    super(message || `HTTP ${status}`);
    this.name = 'LavalinkRequestError';
    this.status = status;
    this.path = path;
  }
}

/** YouTube video ids are 11 characters of [A-Za-z0-9_-]. */
export const VIDEO_ID_PATTERN = /^[\w-]{11}$/;

/**
 * A Lavalink v4 track as the bot uses it: Lavalink calls the duration `info.length` (ms);
 * the bot (and the old lavalink-client API it was written against) reads `info.duration`.
 */
export function normalizeTrack(track) {
  if (!track || typeof track !== 'object') return track;
  const info = track.info ?? {};
  const length = Number.isFinite(info.length) ? info.length : Number.isFinite(info.duration) ? info.duration : 0;
  return { ...track, info: { ...info, duration: length }, pluginInfo: track.pluginInfo ?? {} };
}

/**
 * Converts a Lavalink v4 /loadtracks response into the shape the rest of the bot uses:
 * { loadType, tracks, playlist, exception }.
 */
export function normalizeLoadResult(body) {
  const loadType = body?.loadType ?? 'empty';
  const data = body?.data;
  switch (loadType) {
    case 'track':
      return { loadType, tracks: data ? [normalizeTrack(data)] : [], playlist: null, exception: null };
    case 'playlist':
      return {
        loadType,
        tracks: Array.isArray(data?.tracks) ? data.tracks.map(normalizeTrack) : [],
        playlist: { name: data?.info?.name ?? null, pluginInfo: data?.pluginInfo ?? {} },
        exception: null,
      };
    case 'search':
      return { loadType, tracks: Array.isArray(data) ? data.map(normalizeTrack) : [], playlist: null, exception: null };
    case 'error':
      return { loadType, tracks: [], playlist: null, exception: data ?? null };
    default:
      return { loadType: 'empty', tracks: [], playlist: null, exception: null };
  }
}

/**
 * Thin REST client for one Lavalink node plus a reachability monitor.
 *
 * Events: 'connect' (node), 'disconnect' (node, { reason }). `node` is this object.
 * Console lines ("Lavalink bağlandı (yerel).", "Lavalink bağlantısı koptu", ...) are read by the
 * desktop app; see test/contract.test.js.
 */
export class LavalinkRest extends EventEmitter {
  id = NODE_ID;
  connected = false;
  /** Last /v4/info (version, plugins) while connected. */
  info = null;
  /** Last /v4/stats while connected. */
  stats = null;
  #baseUrl;
  #password;
  #logger;
  #fetch;
  #timer = null;
  #stopped = true;
  #lastRetryLog = 0;
  #polling = null;

  constructor({ host, port, password, logger, fetchImpl = globalThis.fetch }) {
    super();
    this.#baseUrl = `http://${host}:${port}`;
    this.#password = password;
    this.#logger = logger;
    this.#fetch = fetchImpl;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  /** Starts polling Lavalink; logs when it becomes reachable or is lost. */
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(ms) {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.poll().catch(() => {}), ms);
    this.#timer.unref?.();
  }

  /** One reachability check (also refreshes info/stats). Returns the connected flag. */
  async poll() {
    if (this.#polling) return this.#polling;
    this.#polling = this.#pollOnce().finally(() => {
      this.#polling = null;
    });
    return this.#polling;
  }

  async #pollOnce() {
    try {
      const info = await this.request('/v4/info');
      this.info = info ?? this.info;
      this.stats = (await this.request('/v4/stats').catch(() => this.stats)) ?? this.stats;
      if (!this.connected) {
        this.connected = true;
        this.#logger.info(`Lavalink bağlandı (${this.id}).`);
        this.emit('connect', this);
      }
      this.#schedule(POLL_UP_MS);
      return true;
    } catch (error) {
      const reason = describeNetworkError(error);
      if (this.connected) {
        this.connected = false;
        this.stats = null;
        this.#logger.warn(`Lavalink bağlantısı koptu (${this.id}): ${reason}`);
        this.emit('disconnect', this, { reason });
        this.#lastRetryLog = Date.now();
      } else if (Date.now() - this.#lastRetryLog >= RETRY_LOG_EVERY_MS) {
        this.#lastRetryLog = Date.now();
        if (error instanceof LavalinkRequestError && (error.status === 401 || error.status === 403)) {
          this.#logger.error(
            'Lavalink şifreyi reddetti. .env içindeki LAVALINK_PASSWORD ile Lavalink aynı şifreyle mi başlatıldı?',
          );
        } else if (/ECONNREFUSED/.test(reason)) {
          this.#logger.warn(`Lavalink'e ulaşılamıyor (${this.#baseUrl}). "npm run lavalink" açık mı?`);
        } else {
          this.#logger.warn(`Lavalink'e yeniden bağlanılıyor (${this.id})... (${reason})`);
        }
      }
      this.#schedule(POLL_DOWN_MS);
      return false;
    }
  }

  // ---------------------------------------------------------------- requests

  /**
   * GET/POST a REST path (e.g. "/v4/loadtracks?identifier=..."). Resolves with the parsed JSON,
   * undefined for 204. Throws LavalinkRequestError for HTTP errors (message from Lavalink) and
   * the raw network error ("fetch failed", ECONNREFUSED) when Lavalink is unreachable.
   */
  async request(path, { method = 'GET', body, signal, timeoutMs = 15_000 } = {}) {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.#password,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 204) return undefined;
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      throw new LavalinkRequestError(response.status, json?.message ?? json?.error ?? text.slice(0, 200), path);
    }
    return json;
  }

  /** Search or link resolution: "ytsearch:...", a URL, ... */
  async loadTracks(identifier) {
    return normalizeLoadResult(await this.request(`/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`));
  }

  async decodeTrack(encoded) {
    return normalizeTrack(await this.request(`/v4/decodetrack?encodedTrack=${encodeURIComponent(encoded)}`));
  }

  /** LavaLyrics: lyrics for an encoded track, or null when there are none (204). */
  async lyrics(encoded) {
    const result = await this.request(`/v4/lyrics?track=${encodeURIComponent(encoded)}&skipTrackSource=false`);
    return result ?? null;
  }

  hasPlugin(name) {
    return Boolean(this.info?.plugins?.some((p) => p.name === name));
  }

  /**
   * Whether Lavalink has a source manager registered, e.g. "spotify" (LavaSrc registers it only
   * when application.yml enables it, which the start script does when both Spotify keys are
   * in .env). Read from /v4/info's `sourceManagers`.
   */
  hasSource(name) {
    return Boolean(this.info?.sourceManagers?.some((s) => String(s).toLowerCase() === name.toLowerCase()));
  }

  /** URL of youtube-plugin's REST stream for a video (its audio bytes, best format). */
  streamUrl(videoId, { itag, withClient } = {}) {
    if (!VIDEO_ID_PATTERN.test(String(videoId))) throw new TypeError(`Geçersiz YouTube video kimliği: ${videoId}`);
    const url = new URL(`${this.#baseUrl}/youtube/stream/${encodeURIComponent(videoId)}`);
    if (itag) url.searchParams.set('itag', String(itag));
    if (withClient) url.searchParams.set('withClient', withClient);
    return url.toString();
  }

  /**
   * Opens the audio stream of a YouTube video through Lavalink (youtube-plugin picks the client,
   * handles OAuth and ciphering). Resolves with a PrefetchStream (a Node Readable); rejects with
   * LavalinkRequestError when the plugin refuses the video (its message describes why).
   *
   * The response is downloaded eagerly, as fast as Lavalink sends it, instead of at playback
   * speed: Lavalink's web layer uses @EnableWebMvc, so `spring.mvc.async.request-timeout` is
   * ignored and the servlet container's default of 30 s applies to the async streaming
   * response. A reader that only consumes at playback speed gets cut off after ~30 s
   * (AsyncRequestTimeoutException); a whole track downloads in a second or two.
   */
  async openStream(videoId, { signal, headersTimeoutMs = 20_000, maxBufferedBytes } = {}) {
    const url = this.streamUrl(videoId);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const headersTimer = setTimeout(() => controller.abort(new Error('zaman aşımı')), headersTimeoutMs);
    let response;
    try {
      response = await this.#fetch(url, { headers: { Authorization: this.#password }, signal: controller.signal });
    } finally {
      clearTimeout(headersTimer);
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let message = text.slice(0, 300);
      try {
        message = JSON.parse(text)?.message ?? message;
      } catch {
        // plain text body
      }
      signal?.removeEventListener('abort', onAbort);
      throw new LavalinkRequestError(response.status, message, `/youtube/stream/${videoId}`);
    }
    const expected = Number(response.headers?.get?.('content-length'));
    const stream = new PrefetchStream(response.body, {
      abortController: controller,
      expectedLength: Number.isFinite(expected) && expected > 0 ? expected : null,
      maxBufferedBytes,
    });
    stream.once('close', () => signal?.removeEventListener('abort', onAbort));
    return stream;
  }
}

/** Default cap for prefetched, not yet consumed bytes (~4 hours of 128 kbps audio). */
export const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024 * 1024;

/**
 * Readable that pulls a web ReadableStream as fast as the producer allows and hands the bytes
 * to its consumer at the consumer's pace. Unconsumed bytes are kept in memory up to
 * `maxBufferedBytes`; beyond that the producer is paused (back-pressure) until the consumer
 * catches up. `bytesReceived`, `expectedLength` and `complete` describe what the source sent.
 */
export class PrefetchStream extends Readable {
  bytesReceived = 0;
  bytesDelivered = 0;
  expectedLength;
  complete = false;
  sourceError = null;
  #reader;
  #chunks = [];
  #buffered = 0;
  #maxBuffered;
  #abortController;
  #pulling = false;
  #paused = false;
  #pullOnce = false;
  #finished = false;

  constructor(
    webStream,
    { abortController, expectedLength = null, maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES } = {},
  ) {
    const max = maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    // The Readable's own buffer counts towards the cap too (see #pending()).
    super({ highWaterMark: Math.min(1 << 20, Math.max(1024, Math.floor(max / 4))) });
    this.expectedLength = expectedLength;
    this.#maxBuffered = max;
    this.#abortController = abortController ?? new AbortController();
    this.#reader = webStream.getReader();
    this.#pull();
  }

  /** True when the source closed before sending `expectedLength` bytes. */
  get truncated() {
    return this.complete && this.expectedLength !== null && this.bytesReceived < this.expectedLength;
  }

  /** Bytes received but not yet taken by the consumer (our queue + the Readable's buffer). */
  #pending() {
    return this.#buffered + this.readableLength;
  }

  async #pull() {
    if (this.#pulling || this.#finished) return;
    this.#pulling = true;
    try {
      while (!this.#finished) {
        // Node calls _read() before it removes the data the consumer asked for, so the cap is
        // checked only between consumer reads: every _read() gets at least one more chunk,
        // otherwise nothing would be pushed and Node would never ask again.
        if (!this.#pullOnce && this.#pending() >= this.#maxBuffered) {
          this.#paused = true; // resumed from _read()
          return;
        }
        this.#pullOnce = false;
        const { value, done } = await this.#reader.read();
        if (done) {
          this.complete = true;
          this.#finishSource();
          return;
        }
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        this.bytesReceived += chunk.length;
        this.#chunks.push(chunk);
        this.#buffered += chunk.length;
        this.#drain();
      }
    } catch (error) {
      if (!this.#finished) {
        this.sourceError = error;
        this.#finishSource(error);
      }
    } finally {
      this.#pulling = false;
    }
  }

  #finishSource(error) {
    this.#finished = true;
    this.#drain();
    if (error && !this.destroyed) {
      // Deliver what we have, then report the error.
      this.#chunks.push(null);
      this.#pendingError = error;
    } else if (!this.destroyed) {
      this.#chunks.push(null);
    }
    this.#drain();
  }

  #pendingError = null;

  #drain() {
    while (this.#chunks.length) {
      const chunk = this.#chunks[0];
      if (chunk === null) {
        this.#chunks.shift();
        if (this.#pendingError) this.destroy(this.#pendingError);
        else this.push(null);
        return;
      }
      if (!this.push(chunk)) {
        this.#chunks.shift();
        this.#buffered -= chunk.length;
        this.bytesDelivered += chunk.length;
        return; // consumer is full; _read() will call us again
      }
      this.#chunks.shift();
      this.#buffered -= chunk.length;
      this.bytesDelivered += chunk.length;
    }
  }

  _read() {
    this.#drain();
    if (this.#paused) {
      this.#paused = false;
      this.#pullOnce = true;
      this.#pull();
    }
  }

  _destroy(error, callback) {
    this.#finished = true;
    this.#chunks.length = 0;
    this.#buffered = 0;
    try {
      this.#abortController.abort(error ?? new Error('stream destroyed'));
    } catch {
      // ignore
    }
    this.#reader.cancel().catch(() => {});
    callback(error);
  }
}

function describeNetworkError(error) {
  const cause = error?.cause;
  return cause?.code ?? cause?.message ?? error?.message ?? String(error);
}

/**
 * Creates the Lavalink REST client used by MusicService. Playback no longer goes through
 * Lavalink's own voice connection; the bot sends audio itself (README > Teknik notlar).
 */
export function createLavalinkManager(client, config, logger) {
  return new LavalinkRest({
    host: config.lavalink.host,
    port: config.lavalink.port,
    password: config.lavalink.password,
    logger,
  });
}
