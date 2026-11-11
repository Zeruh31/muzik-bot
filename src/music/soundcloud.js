// SoundCloud bağlantıları. Lavalink 4.2.2'nin (lavaplayer 2.2.6) SoundCloud kaynağı artık hiçbir
// parçayı yükleyemiyor ("Did not detect any supported formats": SoundCloud yalnız HLS/AAC veriyor).
// Bu yüzden bot parçayı SoundCloud'un herkese açık web API'sinden (api-v2) kendisi çözer, lavaplayer
// ile aynı yöntemle: soundcloud.com sayfasının betiklerinden client_id okunur. Ses, SoundCloud'un
// verdiği HLS adresinden ffmpeg ile çalınır. README > Teknik notlar. Normalde dokunmana gerek yok.

import { muzik as M } from '../mesajlar.js';
import { ErrorCodes, MusicError } from './errors.js';

const SITE = 'https://soundcloud.com/';
const API = 'https://api-v2.soundcloud.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const REQUEST_TIMEOUT_MS = 10_000;
/** A set (playlist) is loaded up to this many tracks. */
export const SOUNDCLOUD_SET_LIMIT = 200;
/** Stream info of a resolved track is reused for this long, then fetched again. */
const TRANSCODING_TTL_MS = 30 * 60 * 1000;

/** Hosts SoundCloud links and its audio CDN use. */
const LINK_HOSTS = /^(?:(?:www|m)\.)?soundcloud\.com$/i;
const SHORT_HOST = /^on\.soundcloud\.com$/i;
const MEDIA_HOSTS = /(?:^|\.)(?:sndcdn\.com|soundcloud\.cloud|soundcloud\.com)$/i;
/** The only hosts the client_id is ever sent to (https). */
const CLIENT_ID_HOSTS = /^(?:api-v2\.soundcloud\.com|api\.soundcloud\.com|[a-z0-9-]+\.sndcdn\.com)$/i;
/** 429 (too many requests): wait 1 s, 2 s, 4 s (or Retry-After, at most 10 s) and try again. */
const RATE_LIMIT_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 10_000;

/** Whether the client_id may be attached to a request to this URL. */
export function mayCarryClientId(text) {
  try {
    const url = new URL(String(text));
    return url.protocol === 'https:' && CLIENT_ID_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** True for soundcloud.com / m.soundcloud.com / on.soundcloud.com links. */
export function isSoundCloudUrl(text) {
  try {
    const url = new URL(String(text).trim());
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      (LINK_HOSTS.test(url.hostname) || SHORT_HOST.test(url.hostname))
    );
  } catch {
    return false;
  }
}

/** Whether a stream URL handed out by SoundCloud points to SoundCloud's own media hosts (https). */
export function isSoundCloudMediaUrl(text) {
  try {
    const url = new URL(String(text));
    return url.protocol === 'https:' && MEDIA_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The transcoding to play: complete (not a 30 s preview) ones only; progressive MP3 first (plain
 * HTTP file), then HLS in the order MP3, AAC, Opus. Returns null when nothing is playable.
 */
export function pickTranscoding(transcodings) {
  const usable = (transcodings ?? []).filter((t) => t?.url && !t.snipped && t.format?.protocol);
  const score = (t) => {
    const mime = String(t.format.mime_type ?? '').toLowerCase();
    const protocol = t.format.protocol;
    if (protocol === 'progressive' && mime.includes('mpeg')) return 0;
    if (protocol === 'hls' && mime === 'audio/mpeg') return 1;
    if (protocol === 'hls' && mime.includes('mp4')) return 2;
    if (protocol === 'hls' && mime.includes('ogg')) return 3;
    if (protocol === 'progressive') return 4;
    return 9;
  };
  const sorted = usable.filter((t) => score(t) < 9).sort((a, b) => score(a) - score(b));
  return sorted[0] ?? null;
}

/** Converts SoundCloud's track JSON into the Lavalink-like track object the bot uses. */
export function soundcloudTrack(json) {
  const artwork = json.artwork_url ?? json.user?.avatar_url ?? null;
  const duration = Number.isFinite(json.full_duration) ? json.full_duration : (json.duration ?? 0);
  return {
    encoded: null,
    info: {
      identifier: String(json.id),
      title: json.title ?? null,
      author: json.user?.username ?? null,
      duration,
      length: duration,
      isStream: false,
      isSeekable: true,
      position: 0,
      uri: json.permalink_url ?? null,
      artworkUrl: typeof artwork === 'string' ? artwork.replace('-large.', '-t500x500.') : null,
      isrc: json.publisher_metadata?.isrc ?? null,
      sourceName: 'soundcloud',
    },
    pluginInfo: {},
    soundcloud: {
      transcodings: json.media?.transcodings ?? [],
      trackAuthorization: json.track_authorization ?? null,
      policy: json.policy ?? null,
      fetchedAt: Date.now(),
    },
  };
}

/** Why a SoundCloud track cannot be played (Turkish), or null when it can. */
export function unplayableReason(json) {
  if (json?.policy === 'BLOCK' || json?.streamable === false) return M.soundcloudEngelli;
  if (json?.policy === 'SNIP' || !pickTranscoding(json?.media?.transcodings)) return M.soundcloudOnizleme;
  return null;
}

/**
 * Minimal SoundCloud api-v2 client: resolves links to tracks and hands out the audio URL of a
 * track. The client_id is read from soundcloud.com's scripts (like lavaplayer does), cached and
 * read again when SoundCloud refuses it (401/403).
 */
export class SoundCloudClient {
  #fetch;
  #sleep;
  #clientId = null;
  #clientIdPromise = null;

  constructor({ fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
  }

  /** One GET; on 429 it waits longer each time (RATE_LIMIT_DELAYS_MS) before trying again. */
  async #get(url, { json = true, redirect = 'follow' } = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,*/*' },
        redirect,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status !== 429 || attempt >= RATE_LIMIT_DELAYS_MS.length) return response;
      await response.body?.cancel?.().catch(() => {});
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(MAX_RETRY_AFTER_MS, retryAfter * 1000)
          : RATE_LIMIT_DELAYS_MS[attempt];
      await this.#sleep(wait);
    }
  }

  async #findClientId() {
    const page = await this.#get(SITE, { json: false });
    if (!page.ok) throw new Error(`soundcloud.com HTTP ${page.status}`);
    const html = await page.text();
    const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(
      (m) => m[1],
    );
    // The id sits in one of the last bundles; read from the end.
    for (const src of scripts.reverse()) {
      const response = await this.#get(src, { json: false });
      if (!response.ok) continue;
      const match = (await response.text()).match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/);
      if (match) return match[1];
    }
    throw new Error('SoundCloud client_id bulunamadı');
  }

  async clientId({ refresh = false } = {}) {
    if (refresh) this.#clientId = null;
    if (this.#clientId) return this.#clientId;
    this.#clientIdPromise ??= this.#findClientId().finally(() => {
      this.#clientIdPromise = null;
    });
    this.#clientId = await this.#clientIdPromise;
    return this.#clientId;
  }

  /**
   * GET an api-v2 URL with the client_id; one retry with a fresh id after 401/403. The id is only
   * attached for SoundCloud's own API/CDN hosts (a transcoding URL pointing elsewhere is refused)
   * and redirects are not followed, so it cannot leak to another host.
   */
  async #api(url) {
    if (!mayCarryClientId(url)) throw new Error('SoundCloud beklenmeyen bir adres verdi');
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await this.clientId({ refresh: attempt > 0 });
      const target = new URL(url);
      target.searchParams.set('client_id', id);
      const response = await this.#get(target.toString(), { redirect: 'error' });
      if (response.status === 429) throw new MusicError(ErrorCodes.BUSY, M.soundcloudYogun);
      if ((response.status === 401 || response.status === 403) && attempt === 0) continue;
      if (response.status === 404) throw new MusicError(ErrorCodes.NOT_FOUND, M.soundcloudBulunamadi);
      if (!response.ok) throw new Error(`SoundCloud HTTP ${response.status}`);
      return response.json();
    }
    throw new Error('SoundCloud isteği reddetti');
  }

  /** on.soundcloud.com/xyz -> the soundcloud.com link it redirects to (checked to stay on SoundCloud). */
  async #expandShortLink(text) {
    const response = await this.#get(text, { json: false, redirect: 'manual' });
    const location = response.headers?.get?.('location');
    await response.body?.cancel?.().catch(() => {});
    if (!location) throw new MusicError(ErrorCodes.NOT_FOUND, M.soundcloudBulunamadi);
    const target = new URL(location, text);
    if (!LINK_HOSTS.test(target.hostname)) throw new MusicError(ErrorCodes.NOT_FOUND, M.soundcloudBulunamadi);
    target.search = '';
    return target.toString();
  }

  /**
   * Resolves a SoundCloud link: { kind: 'track'|'playlist', tracks, playlistName, unplayable }.
   * `unplayable` counts set tracks that are blocked or previews only (left out).
   * A single track that cannot be played throws a Turkish MusicError.
   */
  async resolve(text) {
    let link = String(text).trim();
    if (SHORT_HOST.test(new URL(link).hostname)) link = await this.#expandShortLink(link);
    const url = new URL(link);
    url.hostname = 'soundcloud.com';
    url.protocol = 'https:';
    // Tracking parameters (?si=..., utm_*) are not part of the link.
    url.search = '';
    url.hash = '';
    const json = await this.#api(`${API}/resolve?url=${encodeURIComponent(url.toString())}`);
    if (json?.kind === 'track') {
      const reason = unplayableReason(json);
      if (reason) throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, reason);
      return { kind: 'track', tracks: [soundcloudTrack(json)], playlistName: null, unplayable: 0 };
    }
    if (json?.kind === 'playlist') {
      const full = await this.#fullTracks((json.tracks ?? []).slice(0, SOUNDCLOUD_SET_LIMIT));
      const playable = full.filter((t) => !unplayableReason(t));
      return {
        kind: 'playlist',
        tracks: playable.map(soundcloudTrack),
        playlistName: json.title ?? null,
        unplayable: full.length - playable.length,
      };
    }
    throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, M.kaynakDesteklenmiyor('soundcloud'));
  }

  /** Sets list some tracks only as { id }: fetch those in batches of 50 (keeps the order). */
  async #fullTracks(items) {
    const missing = items.filter((t) => !t?.media).map((t) => t.id);
    const byId = new Map(items.filter((t) => t?.media).map((t) => [t.id, t]));
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const list = await this.#api(`${API}/tracks?ids=${batch.join(',')}`);
      for (const t of Array.isArray(list) ? list : []) byId.set(t.id, t);
    }
    return items.map((t) => byId.get(t.id)).filter(Boolean);
  }

  /**
   * The audio URL of a track for ffmpeg: { url, protocol: 'hls'|'progressive' }. Stream info older
   * than TRANSCODING_TTL_MS (or missing, e.g. a track from a saved list) is fetched again.
   */
  async streamUrl(track) {
    let sc = track.soundcloud;
    if (!sc?.transcodings?.length || Date.now() - (sc.fetchedAt ?? 0) > TRANSCODING_TTL_MS) {
      if (!track.info?.uri) throw new MusicError(ErrorCodes.LOAD_FAILED, M.soundcloudBulunamadi);
      const fresh = await this.resolve(track.info.uri);
      sc = fresh.tracks[0]?.soundcloud;
      if (!sc) throw new MusicError(ErrorCodes.LOAD_FAILED, M.soundcloudBulunamadi);
      track.soundcloud = sc;
    }
    const transcoding = pickTranscoding(sc.transcodings);
    if (!transcoding) throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, M.soundcloudOnizleme);
    const target = new URL(transcoding.url);
    if (sc.trackAuthorization) target.searchParams.set('track_authorization', sc.trackAuthorization);
    let json;
    try {
      json = await this.#api(target.toString());
    } catch (error) {
      track.soundcloud = null; // fetch everything again next time
      throw error;
    }
    if (!isSoundCloudMediaUrl(json?.url)) throw new Error('SoundCloud beklenmeyen bir ses adresi verdi');
    return { url: json.url, protocol: transcoding.format.protocol };
  }
}

let shared = null;

/** The SoundCloud client shared by MusicService and the players (one cached client_id). */
export function defaultSoundCloud() {
  shared ??= new SoundCloudClient();
  return shared;
}
