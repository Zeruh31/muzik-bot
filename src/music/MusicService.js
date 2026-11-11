// Botun müzik "motoru": şarkı arama, kuyruk, atlama, ses seviyesi gibi bütün işler buradan geçer.
// Discord komutları ve web paneli bu dosyadaki işlevleri çağırır. Mesajların metni src/mesajlar.js'de.
// Yeni bir komut çoğu zaman buradaki hazır bir işlevi kullanır; buraya dokunman nadiren gerekir.

import { EventEmitter } from 'node:events';
import { etiketler, muzik as M, yuklemeHatasi } from '../mesajlar.js';
import { assertStreamable, isStreamable, sourceOf } from './audioSource.js';
import { CROSSFADE_MAX_SECONDS, CROSSFADE_MIN_SECONDS } from './crossfade.js';
import { hasAudioExtension, probeDirectLink } from './directLink.js';
import { ErrorCodes, MusicError, translateLavalinkError } from './errors.js';
import { BASSBOOST_FILTERS, findFfmpeg } from './ffmpeg.js';
import { VIDEO_ID_PATTERN } from './lavalink.js';
import { defaultSoundCloud, isSoundCloudUrl } from './soundcloud.js';

/** Bass boost levels: label for Discord, ffmpeg filter chain (null = off). */
export const BASSBOOST_LEVELS = Object.freeze({
  none: { label: etiketler.bas.none, filter: BASSBOOST_FILTERS.none },
  low: { label: etiketler.bas.low, filter: BASSBOOST_FILTERS.low },
  medium: { label: etiketler.bas.medium, filter: BASSBOOST_FILTERS.medium },
  high: { label: etiketler.bas.high, filter: BASSBOOST_FILTERS.high },
});

export const VOLUME_MIN = 1;
export const VOLUME_MAX = 150;
export const REPEAT_MODES = Object.freeze(['off', 'track', 'queue']);

const URL_PATTERN = /^https?:\/\//i;
const SPOTIFY_PATTERN = /^(https?:\/\/(open|play)\.spotify\.com\/|spotify:)/i;

/** True for open.spotify.com links and spotify: URIs. */
export function isSpotifyLink(text) {
  return SPOTIFY_PATTERN.test(String(text ?? '').trim());
}

/** Sites Lavalink itself resolves (YouTube, Spotify, Bandcamp, Twitch, Vimeo): never probed as files. */
const LAVALINK_HOSTS =
  /(?:^|\.)(?:youtube\.com|youtu\.be|youtube-nocookie\.com|spotify\.com|bandcamp\.com|twitch\.tv|vimeo\.com)$/i;

/**
 * How a URL is loaded first: 'soundcloud' (bot's own SoundCloud client), 'direct' (it ends in an
 * audio file ending: probed by the bot) or 'lavalink' (everything else, including short links like
 * spotify.link or youtu.be). A link Lavalink finds nothing for may still be a direct audio link,
 * see mayBeDirectLink.
 */
export function linkKind(text) {
  const value = String(text ?? '').trim();
  if (isSoundCloudUrl(value)) return 'soundcloud';
  return hasAudioExtension(value) ? 'direct' : 'lavalink';
}

/** An http(s) link of a site Lavalink does not handle itself: worth probing as a direct link. */
export function mayBeDirectLink(text) {
  try {
    const url = new URL(String(text ?? '').trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && !LAVALINK_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** Own link loads (SoundCloud, direct links: the bot downloads them) per user and per server. */
export const LINK_LIMITS = Object.freeze({ windowMs: 60_000, perUser: 5, perGuild: 20 });

/** Sliding-window counter: allow(key, max) records a use and says whether it is within `max`. */
export class RateLimiter {
  #windowMs;
  #now;
  #uses = new Map();

  constructor({ windowMs, now = Date.now }) {
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** ms until the oldest use leaves the window when `key` is at `max`, else 0 (nothing recorded). */
  waitFor(key, max) {
    const recent = this.#recent(key);
    return recent.length >= max ? recent[0] + this.#windowMs - this.#now() : 0;
  }

  record(key) {
    const recent = this.#recent(key);
    recent.push(this.#now());
    this.#uses.set(key, recent);
    if (this.#uses.size > 10_000) this.#uses.delete(this.#uses.keys().next().value);
  }

  #recent(key) {
    const since = this.#now() - this.#windowMs;
    const list = (this.#uses.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.#uses.set(key, list);
    else this.#uses.delete(key);
    return list;
  }
}

/**
 * Kind of a Lavalink load/playback exception. Patterns follow youtube-source's own
 * messages (Client#getPlayabilityStatus, AllClientsFailedException); whole phrases are
 * matched so e.g. "The page needs to be reloaded" is not mistaken for an age restriction.
 * @returns {'allClientsFailed'|'age'|'login'|'private'|'unavailable'|'other'}
 */
export function loadErrorKind(exception) {
  const message = String(exception?.message ?? '');
  // "(yts.version: x) All clients failed to load the item." followed by one line per client.
  // Checked first: the per-client lines may mention login/age for only some clients.
  if (/All clients failed to load the item/i.test(message)) return 'allClientsFailed';
  if (/requires age verification|Sign in to confirm your age|age[- ]restricted/i.test(message)) return 'age';
  if (/confirm you.?re not a bot|requires login|cannot be viewed anonymously|login required/i.test(message)) {
    return 'login';
  }
  if (/private video|video is private/i.test(message)) return 'private';
  if (/video (is )?unavailable|has been removed|no longer available|not available in your country/i.test(message)) {
    return 'unavailable';
  }
  return 'other';
}

const LOAD_ERROR_TEXT = {
  allClientsFailed: yuklemeHatasi.youtubeVermiyor,
  age: yuklemeHatasi.yasKisitlamali,
  login: yuklemeHatasi.oturumGerekli,
  private: yuklemeHatasi.ozelVideo,
  unavailable: yuklemeHatasi.kullanilamiyor,
  other: yuklemeHatasi.genel,
};

/**
 * Turkish text for a Lavalink load/playback exception. An exception that already carries a
 * MusicError code (e.g. an unsupported source) keeps its own Turkish message.
 */
export function describeLoadError(exception) {
  if (exception?.code && Object.hasOwn(ErrorCodes, exception.code) && exception.message) return exception.message;
  return LOAD_ERROR_TEXT[loadErrorKind(exception)];
}

/** Autoplay does not pick any of the last this many played songs again. */
export const AUTOPLAY_RECENT = 50;
/** After this many autoplay songs in a row fail to play, autoplay stops for that queue. */
export const AUTOPLAY_MAX_FAILURES = 3;
/** /liste çal loads the songs after the first one in batches of this size. */
export const SAVED_BATCH_SIZE = 20;

/** off -> track -> queue -> off (the repeat button). */
export function nextRepeatMode(mode) {
  return REPEAT_MODES[(REPEAT_MODES.indexOf(mode) + 1) % REPEAT_MODES.length];
}
const HTTP_URI = /^https?:\/\//i;

/** The YouTube video id that is (or was) streamed for a track: its own id, or its mirror's. */
export function youtubeVideoId(track) {
  const info = track?.info ?? {};
  const id = sourceOf(track) === 'youtube' ? info.identifier : track?.mirror?.videoId;
  return typeof id === 'string' && VIDEO_ID_PATTERN.test(id) ? id : null;
}

/** "Song (Official Video) [4K]" -> "song": for spotting the same song in another upload. */
export function titleKey(title) {
  return String(title ?? '')
    .toLocaleLowerCase('tr')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The first autoplay candidate that is a playable, non-live YouTube video and none of the
 * recently played ones (same video id or same title). `recent`: { ids: Set, titles: Set }.
 */
export function pickAutoplayCandidate(tracks, recent) {
  for (const track of tracks ?? []) {
    const id = youtubeVideoId(track);
    if (!id || track.info?.isStream || !isStreamable(track)) continue;
    if (recent.ids.has(id)) continue;
    const key = titleKey(track.info?.title);
    if (key && recent.titles.has(key)) continue;
    return track;
  }
  return null;
}

/** After these errors the next result of the same search is tried (once). */
const RETRY_WITH_NEXT_RESULT = new Set(['age', 'unavailable']);

/** Plain, JSON-safe view of a track. Used by commands and the web panel. */
export function toTrackView(track) {
  if (!track) return null;
  const info = track.info ?? {};
  return {
    title: info.title ?? etiketler.bilinmeyenParca,
    author: info.author ?? etiketler.bilinmeyenSanatci,
    uri: info.uri ?? null,
    duration: Number.isFinite(info.duration) ? info.duration : 0,
    isStream: Boolean(info.isStream),
    isSeekable: Boolean(info.isSeekable),
    artworkUrl: info.artworkUrl ?? track.pluginInfo?.artworkUrl ?? null,
    sourceName: info.sourceName ?? null,
    requester: track.requester ?? null,
    // Added by /autoplay when the queue ran out (no requester then).
    autoplay: Boolean(track.autoplay),
    // For Spotify & co.: the YouTube video that is actually played (set once it is known).
    mirror: track.mirror
      ? { videoId: track.mirror.videoId, title: track.mirror.title, author: track.mirror.author, uri: track.mirror.uri }
      : null,
  };
}

/** Keeps only plain, serializable requester fields on each track. */
export function requesterView(user) {
  if (!user || typeof user !== 'object') return null;
  if (!('id' in user)) return user;
  return {
    id: user.id,
    username: user.username ?? null,
    displayName: user.globalName ?? user.displayName ?? user.username ?? null,
    avatarUrl: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 64 }) : null,
  };
}

/**
 * Single entry point for everything playback related.
 *
 * Slash commands and the web panel call this service and never touch the voice engine or
 * Lavalink directly, so both use the exact same operations and state.
 * Methods throw MusicError (Turkish message) for expected problems.
 *
 * Events:
 *   'stateChanged' (guildId)            - something visible changed (track, queue, volume, ...)
 *   'trackStarted' (guildId, trackView)
 *   'trackEnded'   (guildId, trackView, reason) - finished, loadFailed, stopped, replaced, cleanup
 *   'trackFailed'  (guildId, trackView, turkishReason)
 *   'trackRetried' (guildId, failedView, turkishReason, nextView) - next search result queued instead
 *   'queueEnded'   (guildId)            - nothing left and autoplay added nothing
 *   'autoplayAdded' (guildId, trackView) - autoplay queued a similar song at the queue end
 *   'autoplayStopped' (guildId)          - autoplay songs failed AUTOPLAY_MAX_FAILURES times in a row
 *   'playerDestroyed' (guildId, reason)
 */
export class MusicService extends EventEmitter {
  #lavalink;
  #engine;
  #stopHooks = [];
  #config;
  #logger;
  /**
   * guildId -> Map(encoded track -> { fallback, fromList }) for tracks that came from a search:
   * fallback = next result (when /play took the first result itself), fromList = the user picked it.
   */
  #searchOrigins = new Map();
  #history;
  #settings;
  #hasListeners;
  /** Guild ids whose autoplay lookup is running. */
  #autoplayBusy = new Set();
  /** guildId -> { failedIds: Set (never picked again while the player lives), failures (in a row) } */
  #autoplayState = new Map();
  /** Guild ids with a /liste load running in the background. */
  #savedLoads = new Set();
  /** guildId -> crossfade seconds, when the settings store cannot keep it. */
  #crossfade = new Map();
  #soundcloud;
  #probeDirect;
  #linkRate;

  /**
   * @param {object} deps
   * @param {import('./lavalink.js').LavalinkRest} deps.lavalink REST client (search, stream, lyrics)
   * @param {import('./engine.js').VoiceEngine} deps.engine voice engine (players, playback)
   * @param {object} [deps.history] play history store (src/bot/gecmis.js): record(), list()
   * @param {object} [deps.settings] per-server settings (src/bot/serverSettings.js): getAutoplay(),
   *   setAutoplay(), and when present getCrossfade(), setCrossfade() (kept in memory otherwise)
   * @param {(guildId: string, voiceChannelId: string) => boolean} [deps.hasListeners] whether people
   *   are in the bot's channel; autoplay adds nothing to an empty channel
   * @param {object} [deps.soundcloud] SoundCloud client (src/music/soundcloud.js)
   * @param {(url: string) => Promise<object>} [deps.probeDirect] checks a direct audio link (tests)
   */
  constructor({
    lavalink,
    engine,
    config,
    logger,
    history = null,
    settings = null,
    hasListeners = null,
    soundcloud = null,
    probeDirect = null,
    now = Date.now,
  }) {
    super();
    this.#lavalink = lavalink;
    this.#engine = engine;
    this.#config = config;
    this.#logger = logger;
    this.#history = history;
    this.#settings = settings;
    this.#hasListeners = hasListeners;
    this.#soundcloud = soundcloud ?? defaultSoundCloud();
    this.#linkRate = new RateLimiter({ windowMs: LINK_LIMITS.windowMs, now });
    this.#probeDirect = probeDirect ?? (async (url) => probeDirectLink(url, { ffmpegPath: await findFfmpeg() }));
    this.#bindEngineEvents();
  }

  /** Raw GuildPlayer, for advanced use. Prefer the methods below. */
  getPlayer(guildId) {
    return this.#engine.getPlayer(guildId) ?? null;
  }

  /** Guild ids that currently have a player. */
  activeGuildIds() {
    return [...this.#engine.players.keys()];
  }

  /** Lavalink node statistics for /stats (null when Lavalink is not reachable). */
  nodeStats() {
    const node = this.#lavalink;
    if (!node?.connected) return null;
    const players = [...this.#engine.players.values()];
    return {
      version: node.info?.version?.semver ?? null,
      players: players.length,
      playingPlayers: players.filter((p) => p.playing).length,
      uptime: node.stats?.uptime ?? 0,
      memoryUsed: node.stats?.memory?.used ?? 0,
      cpuLoad: node.stats?.cpu?.lavalinkLoad ?? 0,
      plugins: (node.info?.plugins ?? []).map((p) => `${p.name} ${p.version}`),
    };
  }

  // ---------------------------------------------------------------- state

  /** JSON-safe snapshot of a guild's player, or null when there is no player. */
  getState(guildId) {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const current = player.queue.current;
    return {
      guildId,
      voiceChannelId: player.voiceChannelId,
      textChannelId: player.textChannelId,
      connected: Boolean(player.connected),
      playing: Boolean(player.playing),
      paused: Boolean(player.paused),
      volume: player.volume,
      repeatMode: player.repeatMode,
      autoplay: this.isAutoplay(guildId),
      hasPrevious: (player.queue.previous?.length ?? 0) > 0,
      bassboost: player.bassboost ?? player.getData?.('bassboost') ?? 'none',
      // Seconds of crossfade between songs (0 = off).
      crossfade: this.getCrossfade(guildId),
      position: current ? player.position : 0,
      // Lets a client extrapolate the position between updates while playing.
      positionAt: Date.now(),
      current: toTrackView(current),
      queue: player.queue.tracks.map(toTrackView),
      queueDuration: player.queue.tracks.reduce((sum, t) => sum + (t.info?.isStream ? 0 : (t.info?.duration ?? 0)), 0),
    };
  }

  // ---------------------------------------------------------------- loading

  /**
   * Resolves a query (URL or search text) into tracks without touching any player.
   * @returns {Promise<{ kind: 'track'|'playlist'|'search', tracks: object[], playlistName: string|null }>}
   */
  async resolve(query, requester, { guildId = null } = {}) {
    const node = this.#requireNode();
    const text = String(query ?? '').trim();
    if (!text) throw new MusicError(ErrorCodes.INVALID_VALUE, M.bosSorgu);

    // A Spotify link with Spotify switched off in Lavalink would only yield "no results":
    // say what is really missing. Lavalink lists its active sources in /v4/info (sourceManagers).
    if (isSpotifyLink(text) && !node.hasSource('spotify')) {
      throw new MusicError(ErrorCodes.SOURCE_DISABLED, M.spotifyKapali);
    }
    const isUrl = URL_PATTERN.test(text);
    let result;
    if (isUrl) {
      result = await this.#loadUrl(text, { userId: requester?.id ?? null, guildId });
    } else {
      try {
        result = await node.loadTracks(`${this.#config.music.searchSource}:${text}`);
      } catch (error) {
        throw translateLavalinkError(error);
      }
    }

    if (result.loadType === 'error') {
      this.#logger.warn('Parça yüklenemedi:', result.exception?.message ?? result.exception);
      throw new MusicError(ErrorCodes.LOAD_FAILED, describeLoadError(result.exception));
    }
    if (result.loadType === 'empty' || !result.tracks.length) {
      throw new MusicError(ErrorCodes.NOT_FOUND, isSpotifyLink(text) ? M.spotifyBulunamadi : M.sonucYok);
    }
    const who = requesterView(requester);
    return {
      kind: result.loadType === 'playlist' ? 'playlist' : result.loadType === 'track' ? 'track' : 'search',
      tracks: result.tracks.map((track) => ({ ...track, requester: who })),
      playlistName: result.playlist?.name ?? null,
      // Tracks of a SoundCloud set that are blocked or previews only (left out).
      unplayable: result.unplayable ?? 0,
    };
  }

  /**
   * Loads a URL: SoundCloud and audio-file links with the bot's own loaders; anything else through
   * Lavalink first, and when Lavalink finds nothing for a site it does not know, as a direct link
   * (an internet radio or a file without an audio ending). Own loads count against LINK_LIMITS
   * when `limit` is given ({ userId, guildId }); saved lists pass none.
   */
  async #loadUrl(text, limit = null) {
    if (linkKind(text) !== 'lavalink') {
      this.#checkLinkRate(limit);
      return this.#loadOwnLink(text);
    }
    let result;
    try {
      result = await this.#lavalink.loadTracks(text);
    } catch (error) {
      throw translateLavalinkError(error);
    }
    if ((result.loadType === 'empty' || !result.tracks?.length) && mayBeDirectLink(text)) {
      this.#checkLinkRate(limit);
      return this.#loadOwnLink(text);
    }
    return result;
  }

  /** Refuses (BUSY) a user or server that loaded too many links in the last minute. */
  #checkLinkRate(limit) {
    if (!limit) return;
    const keys = [];
    if (limit.userId) keys.push([`u:${limit.userId}`, LINK_LIMITS.perUser]);
    if (limit.guildId) keys.push([`g:${limit.guildId}`, LINK_LIMITS.perGuild]);
    const wait = Math.max(0, ...keys.map(([key, max]) => this.#linkRate.waitFor(key, max)));
    if (wait > 0) throw new MusicError(ErrorCodes.BUSY, M.cokFazlaBaglanti(Math.ceil(wait / 1000)));
    for (const [key] of keys) this.#linkRate.record(key);
  }

  /**
   * Loads a link Lavalink cannot (SoundCloud: lavaplayer's source is broken; direct audio links:
   * Lavalink's http source stays off so links cannot make it fetch arbitrary hosts) in the
   * /v4/loadtracks result shape. Throws MusicError with a Turkish message.
   */
  async #loadOwnLink(text) {
    if (linkKind(text) === 'soundcloud') {
      let resolved;
      try {
        resolved = await this.#soundcloud.resolve(text);
      } catch (error) {
        if (error instanceof MusicError) throw error;
        this.#logger.warn('SoundCloud bağlantısı çözülemedi:', error?.message ?? error);
        throw new MusicError(ErrorCodes.LOAD_FAILED, M.soundcloudUlasilamadi);
      }
      if (!resolved.tracks.length) throw new MusicError(ErrorCodes.NOT_FOUND, M.soundcloudBulunamadi);
      return {
        loadType: resolved.kind,
        tracks: resolved.tracks,
        playlist: resolved.kind === 'playlist' ? { name: resolved.playlistName } : null,
        unplayable: resolved.unplayable ?? 0,
      };
    }
    const track = await this.#probeDirect(text);
    return { loadType: 'track', tracks: [track], playlist: null };
  }

  /**
   * Resolves a query and queues it: whole playlist for playlist links, otherwise the first match.
   * Joins the voice channel when needed and starts playback if idle.
   */
  async play({ guildId, voiceChannelId, textChannelId, query, requester }) {
    const resolved = await this.resolve(query, requester, { guildId });
    return this.playResolved({ guildId, voiceChannelId, textChannelId, resolved });
  }

  /** Second half of play(): queues what resolve() returned (playlist: all, otherwise the first). */
  async playResolved({ guildId, voiceChannelId, textChannelId, resolved }) {
    const isPlaylist = resolved.kind === 'playlist';
    const result = await this.enqueue({
      guildId,
      voiceChannelId,
      textChannelId,
      tracks: isPlaylist ? resolved.tracks : [resolved.tracks[0]],
      fallback: resolved.kind === 'search' ? resolved.tracks[1] : null,
    });
    return {
      ...result,
      skippedUnsupported: (result.skippedUnsupported ?? 0) + (resolved.unplayable ?? 0),
      kind: resolved.kind,
      playlistName: resolved.playlistName,
    };
  }

  /**
   * Adds already resolved tracks (e.g. picked from a search list) to the queue.
   * `fallback`: for a single track that /play took as the first search result, the next result.
   *   It is tried once if the track turns out to be age restricted or unavailable.
   * `fromList`: the user picked this track from a search list. It is never swapped for another
   *   result; if it fails, the error message suggests picking another one.
   * @returns {Promise<{ tracks: object[], startedPlaying: boolean, queuePosition: number }>}
   *   queuePosition is the 1-based position of the first added track (0 = playing now).
   */
  async enqueue({ guildId, voiceChannelId, textChannelId, tracks, fallback = null, fromList = false }) {
    if (!tracks?.length) throw new MusicError(ErrorCodes.NOT_FOUND, M.eklenecekYok);
    // Sources the bot cannot stream (Bandcamp, YouTube live streams, ...) are refused here, before anything is
    // queued: a single such track is an error, in a playlist they are left out.
    if (tracks.length === 1) assertStreamable(tracks[0]);
    const playable = tracks.filter(isStreamable);
    if (!playable.length) assertStreamable(tracks[0]);
    const skippedUnsupported = tracks.length - playable.length;
    const player = await this.#ensurePlayer({ guildId, voiceChannelId, textChannelId });

    const room = this.#config.music.maxQueueSize - player.queue.tracks.length;
    if (room <= 0) {
      throw new MusicError(ErrorCodes.QUEUE_FULL, M.kuyrukDolu(this.#config.music.maxQueueSize));
    }
    const accepted = playable.slice(0, room);
    const wasIdle = !player.queue.current;
    const queuePosition = wasIdle ? 0 : player.queue.tracks.length + 1;
    if ((fallback || fromList) && accepted.length === 1) {
      this.#rememberOrigin(guildId, accepted[0], { fallback: fromList ? null : fallback, fromList });
    }

    player.queue.add(accepted);
    // Someone queued music again: a stopped autoplay may try again after this queue.
    if (accepted.some((t) => !t.autoplay)) this.#autoplayFor(guildId).failures = 0;
    let startedPlaying = false;
    if (!player.playing && !player.paused) {
      try {
        await player.play();
        startedPlaying = true;
      } catch (error) {
        throw translateLavalinkError(error);
      }
    }
    this.#changed(guildId);
    return {
      tracks: accepted.map(toTrackView),
      skippedForLimit: playable.length - accepted.length,
      skippedUnsupported,
      startedPlaying: startedPlaying || wasIdle,
      queuePosition,
    };
  }

  /**
   * Loads saved entries ({ uri, title, duration, sourceUri? } from /liste or /gecmis) again
   * through Lavalink, a few at a time. An entry whose `uri` no longer loads is tried with its
   * `sourceUri` (the YouTube video of a Spotify track); entries that load nothing are counted.
   * @returns {Promise<{ tracks: object[], failed: number }>}
   */
  async resolveSaved(entries, requester, { concurrency = 4 } = {}) {
    const node = this.#requireNode();
    const who = requesterView(requester);
    const list = (entries ?? []).filter(Boolean);
    const results = new Array(list.length).fill(null);
    let next = 0;
    let unreachable = null;
    const worker = async () => {
      while (next < list.length && !unreachable) {
        const index = next++;
        for (const uri of [list[index].uri, list[index].sourceUri]) {
          if (typeof uri !== 'string' || !HTTP_URI.test(uri)) continue;
          try {
            const result = await this.#loadUrl(uri);
            const track = result.loadType === 'track' ? result.tracks[0] : null;
            if (track && isStreamable(track)) {
              results[index] = { ...track, requester: who };
              break;
            }
          } catch (error) {
            const translated = translateLavalinkError(error);
            if (translated instanceof MusicError && translated.code === ErrorCodes.NODE_UNAVAILABLE) {
              unreachable = translated;
              return;
            }
            this.#logger.debug?.('Kayıtlı parça yüklenemedi:', error?.message ?? error);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    if (unreachable) throw unreachable;
    const tracks = results.filter(Boolean);
    return { tracks, failed: list.length - tracks.length };
  }

  /**
   * Queues saved entries (a /liste playlist or a /gecmis pick). Only as many entries as fit in
   * the queue are loaded. The first entry that loads is queued (and starts playing) at once;
   * the rest are loaded and queued in order in the background, in batches of
   * SAVED_BATCH_SIZE, calling `onProgress(progress)` after each batch. One such load per
   * server at a time (BUSY otherwise). Loading stops when the player goes away (/stop).
   *
   * Resolves (after the first track) with the playResolved() shape plus `failedToResolve`,
   * `total` and `done`: a promise of the final progress
   * { added, failed, skippedForLimit, total, stopped }.
   */
  async playSaved({
    guildId,
    voiceChannelId,
    textChannelId,
    entries,
    requester,
    playlistName = null,
    onProgress = null,
  }) {
    if (this.#savedLoads.has(guildId)) throw new MusicError(ErrorCodes.BUSY, M.listeYukleniyor);
    this.#savedLoads.add(guildId);
    const release = () => this.#savedLoads.delete(guildId);
    try {
      const waiting = this.getPlayer(guildId)?.queue.tracks.length ?? 0;
      const room = this.#config.music.maxQueueSize - waiting;
      if (room <= 0) throw new MusicError(ErrorCodes.QUEUE_FULL, M.kuyrukDolu(this.#config.music.maxQueueSize));
      const all = (entries ?? []).filter(Boolean);
      const wanted = all.slice(0, room);

      let index = 0;
      let failed = 0;
      let first = null;
      while (!first && index < wanted.length) {
        const resolved = await this.resolveSaved([wanted[index++]], requester);
        failed += resolved.failed;
        first = resolved.tracks[0] ?? null;
      }
      if (!first) throw new MusicError(ErrorCodes.LOAD_FAILED, M.kayitliCozulemedi);
      const result = await this.enqueue({ guildId, voiceChannelId, textChannelId, tracks: [first] });

      const progress = {
        added: 1,
        failed,
        skippedForLimit: all.length - wanted.length + result.skippedForLimit,
        total: all.length,
        stopped: false,
      };
      const player = this.getPlayer(guildId);
      const done = this.#loadSavedRest({
        player,
        textChannelId,
        rest: wanted.slice(index),
        requester,
        progress,
        onProgress,
      })
        .catch((error) => {
          this.#logger.warn('Kayıtlı liste yüklenirken hata:', error?.message ?? error);
          progress.stopped = true;
          return progress;
        })
        .finally(release);
      return {
        ...result,
        skippedForLimit: progress.skippedForLimit,
        failedToResolve: failed,
        total: all.length,
        kind: playlistName ? 'playlist' : 'track',
        playlistName,
        done,
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Background part of playSaved(): loads and queues the remaining entries batch by batch. */
  async #loadSavedRest({ player, textChannelId, rest, requester, progress, onProgress }) {
    for (let start = 0; start < rest.length; start += SAVED_BATCH_SIZE) {
      const batch = rest.slice(start, start + SAVED_BATCH_SIZE);
      const alive = () => player && !player.destroyed && this.getPlayer(player.guildId) === player;
      if (!alive()) {
        progress.stopped = true;
        break;
      }
      const { tracks, failed } = await this.resolveSaved(batch, requester);
      progress.failed += failed;
      if (!alive()) {
        progress.stopped = true;
        break;
      }
      if (tracks.length) {
        try {
          const result = await this.enqueue({
            guildId: player.guildId,
            voiceChannelId: player.voiceChannelId,
            textChannelId,
            tracks,
          });
          progress.added += result.tracks.length;
          progress.skippedForLimit += result.skippedForLimit;
        } catch (error) {
          if (!(error instanceof MusicError) || error.code !== ErrorCodes.QUEUE_FULL) throw error;
          progress.skippedForLimit += rest.length - start;
          onProgress?.({ ...progress });
          break;
        }
      }
      onProgress?.({ ...progress });
    }
    return progress;
  }

  /** Joins a voice channel without playing anything (used to re-join in 24/7 mode). */
  async join({ guildId, voiceChannelId, textChannelId }) {
    await this.#ensurePlayer({ guildId, voiceChannelId, textChannelId });
    this.#changed(guildId);
  }

  // ---------------------------------------------------------------- controls

  async pause(guildId) {
    const player = this.#requireCurrent(guildId);
    if (player.paused) throw new MusicError(ErrorCodes.INVALID_VALUE, M.zatenDuraklatilmis);
    await player.pause();
    this.#changed(guildId);
  }

  async resume(guildId) {
    const player = this.#requireCurrent(guildId);
    if (!player.paused) throw new MusicError(ErrorCodes.INVALID_VALUE, M.zatenCaliyor);
    await player.resume();
    this.#changed(guildId);
  }

  /** Skips the current track. Returns the skipped track view. */
  async skip(guildId) {
    const player = this.#requireCurrent(guildId);
    const skipped = toTrackView(player.queue.current);
    if (player.queue.tracks.length === 0) {
      // Nothing next: stop the current track but keep the player (queue-end timer handles leaving).
      await player.stopPlaying();
    } else {
      await player.skip(0);
    }
    this.#changed(guildId);
    return skipped;
  }

  /** Jumps to the 1-based queue position, dropping the tracks before it. */
  async skipTo(guildId, position) {
    const player = this.#requireCurrent(guildId);
    this.#assertQueuePosition(player, position);
    const target = toTrackView(player.queue.tracks[position - 1]);
    await player.skip(position);
    this.#changed(guildId);
    return target;
  }

  /**
   * /previous: the current track goes back to the front of the queue and the previous one plays
   * (also after the queue ended). Repeat modes stay consistent, see TrackQueue#back.
   * Returns the view of the track now playing.
   */
  async previous(guildId) {
    const player = this.#requirePlayer(guildId);
    if (!player.queue.previous?.length) throw new MusicError(ErrorCodes.NO_PREVIOUS, M.oncekiYok);
    let track;
    try {
      track = await player.previous();
    } catch (error) {
      throw translateLavalinkError(error);
    }
    if (!track) throw new MusicError(ErrorCodes.NO_PREVIOUS, M.oncekiYok);
    this.#changed(guildId);
    return toTrackView(track);
  }

  /** Stops playback, clears the queue and leaves the voice channel. */
  async stop(guildId) {
    // Stop always works, also while a source recovery is running: hooks cancel it.
    // Without a player it is still a success when a pending recovery was cancelled.
    const cancelledRecovery = this.#stopHooks.map((hook) => hook(guildId)).some(Boolean);
    const player = this.getPlayer(guildId);
    if (!player) {
      if (cancelledRecovery) return;
      throw new MusicError(ErrorCodes.NO_PLAYER, M.calmiyor);
    }
    await player.destroy('Durduruldu');
  }

  /** Registers fn(guildId) => boolean, called on every stop request (used by recovery). */
  onStopRequest(fn) {
    this.#stopHooks.push(fn);
  }

  /** True while a player waits for its audio source (Lavalink) to come back. */
  isRecovering(guildId) {
    return this.getPlayer(guildId)?.getData?.('recovering') === true;
  }

  /** Sets the repeat mode directly ('off' | 'track' | 'queue'). */
  async setRepeatMode(guildId, mode) {
    if (!REPEAT_MODES.includes(mode)) throw new MusicError(ErrorCodes.INVALID_VALUE, M.tekrarModuGecersiz);
    const player = this.#requireCurrent(guildId);
    await player.setRepeatMode(mode);
    this.#changed(guildId);
    return mode;
  }

  /** Toggles single-track repeat. Returns the new repeat mode. */
  async toggleTrackLoop(guildId) {
    const mode = this.#requireCurrent(guildId).repeatMode === 'track' ? 'off' : 'track';
    return this.setRepeatMode(guildId, mode);
  }

  /** Toggles queue repeat. Returns the new repeat mode. */
  /**
   * Pause button: pauses or resumes, decided in the player's operation chain so quick
   * presses alternate. Returns the new paused flag.
   */
  async togglePause(guildId) {
    const player = this.#requireCurrent(guildId);
    const paused = await player.togglePause();
    this.#changed(guildId);
    return paused;
  }

  /** Repeat button: one step off -> track -> queue -> off per press (in the operation chain). */
  async cycleRepeatMode(guildId) {
    const player = this.#requireCurrent(guildId);
    const mode = await player.cycleRepeatMode(nextRepeatMode);
    this.#changed(guildId);
    return mode;
  }

  async toggleQueueLoop(guildId) {
    const mode = this.#requireCurrent(guildId).repeatMode === 'queue' ? 'off' : 'queue';
    return this.setRepeatMode(guildId, mode);
  }

  async shuffle(guildId) {
    const player = this.#requirePlayer(guildId);
    if (player.queue.tracks.length < 2) throw new MusicError(ErrorCodes.EMPTY_QUEUE, M.karistirmakIcinAz);
    player.queue.shuffle();
    this.#changed(guildId);
    return player.queue.tracks.length;
  }

  /** Removes the track at a 1-based queue position. Returns the removed track view. */
  async remove(guildId, position) {
    const player = this.#requirePlayer(guildId);
    this.#assertQueuePosition(player, position);
    const removed = player.queue.remove(position - 1);
    this.#changed(guildId);
    return toTrackView(removed);
  }

  /** Moves a track between 1-based queue positions. Returns the moved track view. */
  async move(guildId, from, to) {
    const player = this.#requirePlayer(guildId);
    this.#assertQueuePosition(player, from);
    this.#assertQueuePosition(player, to);
    if (from === to) throw new MusicError(ErrorCodes.INVALID_POSITION, M.zatenOSirada);
    const [track] = player.queue.splice(from - 1, 1);
    player.queue.add(track, to - 1);
    this.#changed(guildId);
    return toTrackView(track);
  }

  /**
   * /playfirst: moves the track at a 1-based queue position to the front, so it plays next.
   * Position 1 already plays next: nothing changes. Returns { track, moved }.
   */
  async playNext(guildId, position) {
    const player = this.#requirePlayer(guildId);
    this.#assertQueuePosition(player, position);
    if (position === 1) return { track: toTrackView(player.queue.tracks[0]), moved: false };
    return { track: await this.move(guildId, position, 1), moved: true };
  }

  /** Empties the queue (the current track keeps playing). Returns how many were removed. */
  async clear(guildId) {
    const player = this.#requirePlayer(guildId);
    const count = player.queue.tracks.length;
    if (count === 0) throw new MusicError(ErrorCodes.EMPTY_QUEUE, M.kuyrukZatenBos);
    player.queue.clear();
    this.#changed(guildId);
    return count;
  }

  async seek(guildId, positionMs) {
    const player = this.#requireCurrent(guildId);
    const track = player.queue.current;
    if (!track.info.isSeekable || track.info.isStream) throw new MusicError(ErrorCodes.NOT_SEEKABLE, M.sarilamaz);
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs >= track.info.duration) {
      throw new MusicError(ErrorCodes.INVALID_VALUE, M.zamanDisinda);
    }
    await player.seek(positionMs);
    this.#changed(guildId);
  }

  async setVolume(guildId, volume) {
    const player = this.#requirePlayer(guildId);
    if (!Number.isInteger(volume) || volume < VOLUME_MIN || volume > VOLUME_MAX) {
      throw new MusicError(ErrorCodes.INVALID_VALUE, M.sesAraligi(VOLUME_MIN, VOLUME_MAX));
    }
    await player.setVolume(volume);
    this.#changed(guildId);
  }

  /** level: one of BASSBOOST_LEVELS keys. */
  async setBassboost(guildId, level) {
    const player = this.#requirePlayer(guildId);
    if (!BASSBOOST_LEVELS[level]) throw new MusicError(ErrorCodes.INVALID_VALUE, M.basGecersiz);
    await player.setBassboost(level);
    this.#changed(guildId);
  }

  /** Crossfade seconds of a guild (0 = off, the default). */
  getCrossfade(guildId) {
    const stored = this.#settings?.getCrossfade?.(guildId) ?? this.#crossfade.get(guildId);
    return Number.isInteger(stored) ? stored : 0;
  }

  /**
   * Sets the crossfade between songs for a guild: 0 (off) to CROSSFADE_MAX_SECONDS. Works with or
   * without a player; a running player uses it from the next song change. Kept by the settings
   * store when it has setCrossfade(), otherwise in memory until the bot restarts.
   * Returns the new value.
   */
  async setCrossfade(guildId, seconds) {
    if (!Number.isInteger(seconds) || seconds < CROSSFADE_MIN_SECONDS || seconds > CROSSFADE_MAX_SECONDS) {
      throw new MusicError(ErrorCodes.INVALID_VALUE, M.crossfadeAraligi(CROSSFADE_MIN_SECONDS, CROSSFADE_MAX_SECONDS));
    }
    if (this.#settings?.setCrossfade) this.#settings.setCrossfade(guildId, seconds);
    else this.#crossfade.set(guildId, seconds);
    await this.getPlayer(guildId)?.setCrossfade?.(seconds);
    this.#changed(guildId);
    return seconds;
  }

  // ---------------------------------------------------------------- autoplay & history

  /** Whether /autoplay is on for a guild (kept in data/sunucular.json). */
  isAutoplay(guildId) {
    return Boolean(this.#settings?.getAutoplay?.(guildId));
  }

  /** Turns autoplay on or off. Throws the settings store's error when it cannot be saved. */
  setAutoplay(guildId, enabled) {
    if (!this.#settings?.setAutoplay) throw new Error('Sunucu ayarları yok: otomatik çalma ayarlanamaz.');
    this.#settings.setAutoplay(guildId, Boolean(enabled));
    this.#changed(guildId);
    return Boolean(enabled);
  }

  /** Recently played songs of a guild, newest first (no requester is ever stored). */
  getHistory(guildId, limit = 20) {
    return this.#history?.list(guildId, limit) ?? [];
  }

  /** Video ids and title keys of the last AUTOPLAY_RECENT songs (history + this player's memory). */
  #recentlyPlayed(guildId, player) {
    const ids = new Set();
    const titles = new Set();
    const add = (id, title) => {
      if (id) ids.add(id);
      const key = titleKey(title);
      if (key) titles.add(key);
    };
    for (const entry of this.getHistory(guildId, AUTOPLAY_RECENT)) add(entry.videoId, entry.title);
    for (const track of [player.queue.current, ...(player.queue.previous ?? [])].slice(0, AUTOPLAY_RECENT)) {
      if (track) add(youtubeVideoId(track), track.info?.title);
    }
    return { ids, titles };
  }

  /**
   * Finds a song similar to the last YouTube song: first YouTube's own mix for it
   * ("watch?v=<id>&list=RD<id>", which Lavalink loads as a playlist), then a search for
   * artist + title. Recently played songs are skipped. Returns a raw track or null.
   */
  async findAutoplayTrack(guildId) {
    const player = this.getPlayer(guildId);
    if (!player) return null;
    const node = this.#lavalink;
    const seedTrack = [player.queue.current, ...(player.queue.previous ?? [])].find((t) => youtubeVideoId(t));
    const seedEntry = seedTrack ? null : this.getHistory(guildId, AUTOPLAY_RECENT).find((e) => e.videoId);
    const videoId = youtubeVideoId(seedTrack) ?? seedEntry?.videoId ?? null;
    if (!videoId) return null;
    const recent = this.#recentlyPlayed(guildId, player);
    recent.ids.add(videoId);
    // Songs autoplay picked before that could not be played are never picked again.
    for (const id of this.#autoplayFor(guildId).failedIds) recent.ids.add(id);

    const mix = await node.loadTracks(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`).catch((error) => {
      this.#logger.debug?.('Otomatik çalma: mix yüklenemedi:', error?.message ?? error);
      return null;
    });
    const fromMix = mix?.loadType === 'playlist' ? pickAutoplayCandidate(mix.tracks, recent) : null;
    if (fromMix) return fromMix;

    const title = seedTrack?.mirror?.title ?? seedTrack?.info?.title ?? seedEntry?.title;
    const author = seedTrack?.mirror?.author ?? seedTrack?.info?.author ?? seedEntry?.author;
    const text = [author, title].filter(Boolean).join(' ').trim();
    if (!text) return null;
    const search = await node.loadTracks(`${this.#config.music.searchSource}:${text}`).catch(() => null);
    return search?.loadType === 'search' ? pickAutoplayCandidate(search.tracks, recent) : null;
  }

  #autoplayFor(guildId) {
    let state = this.#autoplayState.get(guildId);
    if (!state) this.#autoplayState.set(guildId, (state = { failedIds: new Set(), failures: 0 }));
    return state;
  }

  /**
   * An autoplay song could not be played: it is never picked again, and after
   * AUTOPLAY_MAX_FAILURES in a row autoplay stops for this queue ('autoplayStopped', once)
   * until someone queues a song themselves.
   */
  #autoplayFailed(guildId, track) {
    const state = this.#autoplayFor(guildId);
    const id = youtubeVideoId(track);
    if (id) state.failedIds.add(id);
    state.failures += 1;
    if (state.failures === AUTOPLAY_MAX_FAILURES) {
      this.#logger.warn(
        `Otomatik çalma ${AUTOPLAY_MAX_FAILURES} kez üst üste çalamadı (${guildId}); bu kuyruk için durdu.`,
      );
      this.emit('autoplayStopped', guildId);
    }
  }

  /** True while someone queued or plays something: autoplay has nothing to do then. */
  #hasMusic(player) {
    return Boolean(player.queue.current) || player.queue.tracks.length > 0;
  }

  /**
   * At the queue end: queues a similar song when autoplay is on. Returns true when the queue
   * end needs no announcement (a song was added, or someone queued one meanwhile).
   */
  async #tryAutoplay(player) {
    const guildId = player.guildId;
    if (this.#autoplayBusy.has(guildId)) return true;
    if (this.#autoplayFor(guildId).failures >= AUTOPLAY_MAX_FAILURES) return false;
    this.#autoplayBusy.add(guildId);
    try {
      if (this.#hasListeners && !this.#hasListeners(guildId, player.voiceChannelId)) return false;
      const track = await this.findAutoplayTrack(guildId);
      if (player.destroyed || this.getPlayer(guildId) !== player) return false;
      if (this.#hasMusic(player)) return true; // someone added a song during the lookup
      if (!track) return false;
      const result = await this.enqueue({
        guildId,
        voiceChannelId: player.voiceChannelId,
        textChannelId: player.textChannelId,
        tracks: [{ ...track, requester: null, autoplay: true }],
      });
      this.#logger.info(`Otomatik çalma ekledi (${guildId}): ${track.info?.title ?? '?'}`);
      this.emit('autoplayAdded', guildId, result.tracks[0]);
      return true;
    } catch (error) {
      this.#logger.warn('Otomatik çalma şarkı ekleyemedi:', error?.message ?? error);
      return this.#hasMusic(player);
    } finally {
      this.#autoplayBusy.delete(guildId);
    }
  }

  /** The player ran out of tracks: autoplay first (when on), otherwise announce the end. */
  #queueEnded(player) {
    const guildId = player.guildId;
    const announce = () => {
      this.emit('queueEnded', guildId);
      this.#changed(guildId);
    };
    if (!this.isAutoplay(guildId) || !this.#lavalink?.connected) {
      announce();
      return;
    }
    this.#tryAutoplay(player)
      .then((handled) => {
        if (!handled && !player.destroyed && !this.#hasMusic(player)) announce();
      })
      .catch((error) => this.#logger.warn('queueEnd:', error));
  }

  // ---------------------------------------------------------------- lyrics

  /**
   * Lyrics via the LavaLyrics plugin (sources: YouTube Music, LRCLIB).
   * Without a query it uses the guild's current track; with a query it searches first.
   * @returns {Promise<{ track: object, text: string, provider: string|null, sourceName: string|null }>}
   */
  async lyrics({ guildId, query }) {
    let track;
    if (query) {
      const resolved = await this.resolve(query, null);
      track = resolved.tracks[0];
    } else {
      track = this.#requireCurrent(guildId).queue.current;
    }

    const node = this.#requireNode();
    if (!node.hasPlugin('lavalyrics-plugin')) {
      throw new MusicError(ErrorCodes.LYRICS_UNAVAILABLE, M.sozEklentisiYok);
    }
    // SoundCloud tracks and direct links are not Lavalink tracks: LavaLyrics cannot look them up.
    if (!track.encoded) throw new MusicError(ErrorCodes.LYRICS_UNAVAILABLE, M.sozBulunamadi(track.info.title));
    let result;
    try {
      result = await node.lyrics(track.encoded);
    } catch (error) {
      const translated = translateLavalinkError(error);
      if (translated instanceof MusicError && translated.code === ErrorCodes.NODE_UNAVAILABLE) throw translated;
      this.#logger.warn('Şarkı sözü alınamadı:', error?.message ?? error);
      result = null;
    }

    const text =
      result?.text?.trim() ||
      result?.lines
        ?.map((l) => l.line)
        .join('\n')
        .trim() ||
      '';
    if (!text) throw new MusicError(ErrorCodes.LYRICS_UNAVAILABLE, M.sozBulunamadi(track.info.title));
    return {
      track: toTrackView(track),
      text,
      provider: result.provider ?? null,
      sourceName: result.sourceName ?? null,
    };
  }

  // ---------------------------------------------------------------- internals

  #requireNode() {
    if (!this.#lavalink?.connected) throw new MusicError(ErrorCodes.NODE_UNAVAILABLE, M.lavalinkYok);
    return this.#lavalink;
  }

  #requirePlayer(guildId) {
    const player = this.getPlayer(guildId);
    if (!player) throw new MusicError(ErrorCodes.NO_PLAYER, M.calmiyor);
    this.#assertNotRecovering(player);
    return player;
  }

  // While the audio source is being recovered, control commands would race the recovery;
  // refuse them with a clear message instead. /stop is the exception (see stop()).
  #assertNotRecovering(player) {
    if (player.getData?.('recovering') === true) throw new MusicError(ErrorCodes.RECOVERING, M.yenidenBaglaniyor);
  }

  #requireCurrent(guildId) {
    const player = this.#requirePlayer(guildId);
    if (!player.queue.current) throw new MusicError(ErrorCodes.NOTHING_PLAYING, M.calanYok);
    return player;
  }

  #assertQueuePosition(player, position) {
    const size = player.queue.tracks.length;
    if (size === 0) throw new MusicError(ErrorCodes.EMPTY_QUEUE, M.kuyrukBos);
    if (!Number.isInteger(position) || position < 1 || position > size) {
      throw new MusicError(ErrorCodes.INVALID_POSITION, M.siraAraligi(size));
    }
  }

  async #ensurePlayer({ guildId, voiceChannelId, textChannelId }) {
    this.#requireNode();
    let player = this.getPlayer(guildId);
    if (player) this.#assertNotRecovering(player);
    try {
      if (!player) {
        player = this.#engine.createPlayer({
          guildId,
          voiceChannelId,
          textChannelId,
          volume: this.#config.music.defaultVolume,
        });
        const crossfade = this.getCrossfade(guildId);
        if (crossfade > 0) await player.setCrossfade?.(crossfade);
      } else if (textChannelId) {
        player.textChannelId = textChannelId;
      }
      if (!player.connected) await player.connect();
    } catch (error) {
      throw translateLavalinkError(error);
    }
    return player;
  }

  #changed(guildId) {
    this.emit('stateChanged', guildId);
  }

  #rememberOrigin(guildId, track, { fallback, fromList }) {
    if (!track?.encoded) return;
    const usableFallback = fallback?.encoded && fallback.encoded !== track.encoded ? fallback : null;
    if (!usableFallback && !fromList) return;
    let byTrack = this.#searchOrigins.get(guildId);
    if (!byTrack) this.#searchOrigins.set(guildId, (byTrack = new Map()));
    byTrack.set(track.encoded, { fallback: usableFallback, fromList });
  }

  /** Returns and forgets where a track came from, so a search gets at most one retry. */
  #takeOrigin(guildId, track) {
    const byTrack = this.#searchOrigins.get(guildId);
    const origin = track?.encoded ? byTrack?.get(track.encoded) : undefined;
    if (origin) byTrack.delete(track.encoded);
    return origin ?? { fallback: null, fromList: false };
  }

  /**
   * A track failed. When /play took it as the first search result and it is age restricted or
   * unavailable, the next result goes to the front of the queue: the player follows the error
   * with a "loadFailed" track end and then plays the front of the queue. The retried track has
   * no fallback of its own, so this happens at most once per search.
   * A track the user picked from a list is not swapped; the message suggests picking another.
   */
  async #onTrackError(player, track, payload) {
    const exception = payload?.exception;
    const reason = describeLoadError(exception);
    const { fallback, fromList } = this.#takeOrigin(player.guildId, track);
    if (fallback && RETRY_WITH_NEXT_RESULT.has(loadErrorKind(exception))) {
      try {
        player.queue.add(fallback, 0);
        this.#logger.info(`Aramanın sıradaki sonucu deneniyor: ${fallback.info?.title ?? '?'}`);
        this.emit('trackRetried', player.guildId, toTrackView(track), reason, toTrackView(fallback));
        this.#changed(player.guildId);
        return;
      } catch (error) {
        this.#logger.warn('Sıradaki sonuç kuyruğa eklenemedi:', error?.message ?? error);
      }
    }
    const text = fromList ? `${reason}\n${yuklemeHatasi.listedenBaskasiniSec}` : reason;
    this.emit('trackFailed', player.guildId, toTrackView(track), text);
  }

  #bindEngineEvents() {
    const engine = this.#engine;
    engine.on('trackStart', (player, track) => {
      const view = toTrackView(track);
      try {
        this.#history?.record(player.guildId, { ...view, videoId: youtubeVideoId(track) });
      } catch (error) {
        this.#logger.warn('Geçmişe yazılamadı:', error?.message ?? error);
      }
      this.emit('trackStarted', player.guildId, view);
      this.#changed(player.guildId);
    });
    engine.on('trackEnd', (player, track, payload) => {
      this.#takeOrigin(player.guildId, track); // played or skipped: no retry needed any more
      if (String(payload?.reason ?? '').toLowerCase() === 'finished') this.#autoplayFor(player.guildId).failures = 0;
      this.emit('trackEnded', player.guildId, toTrackView(track), String(payload?.reason ?? 'unknown').toLowerCase());
      this.#changed(player.guildId);
    });
    engine.on('trackError', (player, track, payload) => {
      const reason = payload?.exception?.message ?? payload?.error ?? 'bilinmiyor';
      this.#logger.warn(`Parça çalınamadı (${track?.info?.title ?? '?'}): ${reason}`);
      // Synchronously, before the player moves on and reports the queue end.
      if (track?.autoplay) this.#autoplayFailed(player.guildId, track);
      this.#onTrackError(player, track, payload).catch((error) => this.#logger.warn('trackError:', error));
    });
    engine.on('trackStuck', (player, track) => {
      this.#logger.warn(`Parça takıldı (${track?.info?.title ?? '?'}), atlanıyor.`);
      this.emit('trackFailed', player.guildId, toTrackView(track), yuklemeHatasi.takildi);
    });
    engine.on('queueEnd', (player) => {
      // The last track gets no further events; nothing is queued any more, so forget it all.
      this.#searchOrigins.delete(player.guildId);
      this.#queueEnded(player);
    });
    engine.on('playerUpdate', (_old, player) => this.#changed(player.guildId));
    engine.on('playerDestroy', (player, reason) => {
      this.#searchOrigins.delete(player.guildId);
      this.#autoplayState.delete(player.guildId);
      this.emit('playerDestroyed', player.guildId, reason);
      this.#changed(player.guildId);
    });
  }
}
