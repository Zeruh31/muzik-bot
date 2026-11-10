// Botun müzik "motoru": şarkı arama, kuyruk, atlama, ses seviyesi gibi bütün işler buradan geçer.
// Discord komutları ve web paneli bu dosyadaki işlevleri çağırır. Mesajların metni src/mesajlar.js'de.
// Yeni bir komut çoğu zaman buradaki hazır bir işlevi kullanır; buraya dokunman nadiren gerekir.

import { EventEmitter } from 'node:events';
import { etiketler, muzik as M, yuklemeHatasi } from '../mesajlar.js';
import { assertStreamable, isStreamable } from './audioSource.js';
import { ErrorCodes, MusicError, translateLavalinkError } from './errors.js';
import { BASSBOOST_FILTERS } from './ffmpeg.js';

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
 *   'queueEnded'   (guildId)
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

  /**
   * @param {object} deps
   * @param {import('./lavalink.js').LavalinkRest} deps.lavalink REST client (search, stream, lyrics)
   * @param {import('./engine.js').VoiceEngine} deps.engine voice engine (players, playback)
   */
  constructor({ lavalink, engine, config, logger }) {
    super();
    this.#lavalink = lavalink;
    this.#engine = engine;
    this.#config = config;
    this.#logger = logger;
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
      bassboost: player.bassboost ?? player.getData?.('bassboost') ?? 'none',
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
  async resolve(query, requester) {
    const node = this.#requireNode();
    const text = String(query ?? '').trim();
    if (!text) throw new MusicError(ErrorCodes.INVALID_VALUE, M.bosSorgu);

    // A Spotify link with Spotify switched off in Lavalink would only yield "no results":
    // say what is really missing. Lavalink lists its active sources in /v4/info (sourceManagers).
    if (isSpotifyLink(text) && !node.hasSource('spotify')) {
      throw new MusicError(ErrorCodes.SOURCE_DISABLED, M.spotifyKapali);
    }
    const identifier = URL_PATTERN.test(text) ? text : `${this.#config.music.searchSource}:${text}`;
    let result;
    try {
      result = await node.loadTracks(identifier);
    } catch (error) {
      throw translateLavalinkError(error);
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
    };
  }

  /**
   * Resolves a query and queues it: whole playlist for playlist links, otherwise the first match.
   * Joins the voice channel when needed and starts playback if idle.
   */
  async play({ guildId, voiceChannelId, textChannelId, query, requester }) {
    const resolved = await this.resolve(query, requester);
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
    return { ...result, kind: resolved.kind, playlistName: resolved.playlistName };
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
    // Sources the bot cannot stream (SoundCloud, ...) are refused here, before anything is
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
      this.emit('trackStarted', player.guildId, toTrackView(track));
      this.#changed(player.guildId);
    });
    engine.on('trackEnd', (player, track, payload) => {
      this.#takeOrigin(player.guildId, track); // played or skipped: no retry needed any more
      this.emit('trackEnded', player.guildId, toTrackView(track), String(payload?.reason ?? 'unknown').toLowerCase());
      this.#changed(player.guildId);
    });
    engine.on('trackError', (player, track, payload) => {
      const reason = payload?.exception?.message ?? payload?.error ?? 'bilinmiyor';
      this.#logger.warn(`Parça çalınamadı (${track?.info?.title ?? '?'}): ${reason}`);
      this.#onTrackError(player, track, payload).catch((error) => this.#logger.warn('trackError:', error));
    });
    engine.on('trackStuck', (player, track) => {
      this.#logger.warn(`Parça takıldı (${track?.info?.title ?? '?'}), atlanıyor.`);
      this.emit('trackFailed', player.guildId, toTrackView(track), yuklemeHatasi.takildi);
    });
    engine.on('queueEnd', (player) => {
      // The last track gets no further events; nothing is queued any more, so forget it all.
      this.#searchOrigins.delete(player.guildId);
      this.emit('queueEnded', player.guildId);
      this.#changed(player.guildId);
    });
    engine.on('playerUpdate', (_old, player) => this.#changed(player.guildId));
    engine.on('playerDestroy', (player, reason) => {
      this.#searchOrigins.delete(player.guildId);
      this.emit('playerDestroyed', player.guildId, reason);
      this.#changed(player.guildId);
    });
  }
}
