// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Bir sunucunun oynatıcısı: Discord ses kanalına bağlanır, parçanın
// sesini alır (YouTube: Lavalink'in YouTube eklentisi; SoundCloud; doğrudan ses bağlantıları),
// ffmpeg ile PCM'e çevirir ve @discordjs/voice ile (DAVE uçtan uca şifreli) Discord'a gönderir.
// Kuyruk, tekrar, ses, bas, sarma, şarkılar arası geçiş (crossfade) ve konum burada tutulur.
// README > Teknik notlar bu tasarımın nedenini anlatır.
// ---------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import * as discordVoice from '@discordjs/voice';
import { muzik as M } from '../mesajlar.js';
import { MIRRORED_SOURCES, isLive, isStreamable, resolveStreamSource, sourceOf } from './audioSource.js';
import { CrossfadeMixer, PCM_BYTES_PER_MS, pcmBytes } from './crossfade.js';
import { DIRECT_LIVE_MAX_MS, DIRECT_MAX_DURATION_MS, openDirectStream } from './directLink.js';
import { ErrorCodes, MusicError } from './errors.js';
import { buildFfmpegArgs, findFfmpeg } from './ffmpeg.js';
import { LavalinkRequestError } from './lavalink.js';
import { TrackQueue } from './Queue.js';
import { defaultSoundCloud } from './soundcloud.js';

const { AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus } = discordVoice;

const VOICE_READY_TIMEOUT_MS = 20_000;
const VOICE_RECONNECT_GRACE_MS = 5000;
const POSITION_UPDATE_MS = 1000;
/** A track that ends before this much audio was played is treated as failed, not finished. */
const MIN_PLAYED_FOR_FINISHED_MS = 1500;
/** How much of a non-live track may be missing at an early end before it counts as cut off. */
const EARLY_END_TOLERANCE_MS = 5000;
/** How often a track whose source ended early is re-opened at its position before giving up. */
const MAX_RESUME_ATTEMPTS = 3;
/** A live stream that dropped is reconnected this many times (waiting 1 s, 2 s, 3 s) ... */
const MAX_LIVE_RECONNECTS = 3;
const LIVE_RECONNECT_DELAY_MS = 1000;
/** ... and the count starts again after it played this long without dropping. */
const LIVE_HEALTHY_MS = 60_000;
/** The next track's stream is opened this long before the crossfade starts. */
const CROSSFADE_PREPARE_LEAD_MS = 10_000;

/** Sources whose audio comes from Lavalink: a network error there may mean Lavalink is down. */
function usesLavalink(track) {
  const source = sourceOf(track);
  return source === 'youtube' || MIRRORED_SOURCES.has(source);
}

const sleepImmediate = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Position in a track: where the current stream started (seek) plus how much audio
 * @discordjs/voice has played since (pauses do not count), never past the duration.
 */
export function computePosition({ seekBaseMs = 0, playbackDuration = 0, duration = 0, isStream = false }) {
  const position = Math.max(0, seekBaseMs) + Math.max(0, playbackDuration);
  return duration > 0 && !isStream ? Math.min(position, duration) : position;
}

/**
 * One guild's voice connection, audio pipeline and queue.
 *
 * Every public operation runs through one promise chain per player, so commands that arrive
 * together (seek 30 / seek 60 / seek 90, seek then skip) are applied in order and the last one
 * wins; the end of a stream is handled in the same chain.
 *
 * Events are not emitted by the player itself but handed to `emit(name, ...args)` of the
 * engine that owns it, with the names MusicService listens to:
 *   trackStart(player, track), trackEnd(player, track, { reason }), trackError(player, track,
 *   { exception }), queueEnd(player), playerUpdate(null, player), playerDestroy(player, reason),
 *   sourceLost(player, { position, paused }) when the audio source (Lavalink) went away mid-track,
 *   voiceReady(player) when the voice connection became ready (first join and after a move).
 * trackEnd reasons: finished, replaced (skip), stopped, loadFailed, cleanup (destroyed).
 *
 * Crossfade (crossfadeMs > 0): CROSSFADE_PREPARE_LEAD_MS before the fade, the next track's
 * pipeline is opened ("prepared") without an audio resource. Every track's resource plays a
 * CrossfadeMixer; at `duration - crossfadeMs` the current mixer mixes in the prepared one and
 * ends after the fade. Invariants:
 *  - the switch (trackEnd(finished) of the old track, queue.next, trackStart of the new one)
 *    happens in the chain when the fade becomes audible; from then on the new track is current
 *    and its position counts the fade (carrier = the old resource that plays the mix);
 *  - when the old resource goes idle, the new track gets its own resource on its own mixer,
 *    which holds exactly the PCM the fade did not use (handover);
 *  - no crossfade into the same track (track repeat, or queue repeat with nothing else queued),
 *    from or into a live stream, or for tracks shorter than two fade lengths;
 *  - skip, seek, previous, stop, bass changes and destroy close the prepared pipeline and the
 *    fading one at once: they act immediately, without a fade.
 */
export class GuildPlayer {
  guildId;
  textChannelId;
  queue = new TrackQueue();
  repeatMode = 'off';
  volume;
  /** Volume before a voice-command mute (null: not muted). Only the muted state uses it; /muzik volume ignores it. */
  preMuteVolume = null;
  bassboost = 'none';
  /** Crossfade length in ms; 0 = off. */
  crossfadeMs = 0;
  playing = false;
  paused = false;
  destroyed = false;
  #voiceChannelId;
  #client;
  #rest;
  #config;
  #logger;
  #emit;
  #voice;
  #spawn;
  #findFfmpeg;
  #soundcloud;
  #openDirect;
  #data = new Map();
  #connection = null;
  #audioPlayer = null;
  /**
   * The current track's pipeline: { track, kind, live, abort, stream, ffmpeg, mixer, resource,
   * errors: string[], streamError, carrier, carrierBase, fadeFrom }. During a crossfade `resource`
   * is null and `carrier` is the previous track's resource that plays the mix (`fadeFrom`).
   */
  #pipeline = null;
  /** The next track's pipeline opened ahead for a crossfade: { track, pipeline, from, ready, failed } */
  #prepared = null;
  #seekBaseMs = 0;
  #resumeAttempts = 0;
  #liveReconnects = 0;
  #reconnectTimer = null;
  #updateTimer = null;
  #queueEndTimer = null;
  #ops = Promise.resolve();
  #listening;

  constructor({
    guildId,
    voiceChannelId,
    textChannelId,
    volume,
    client,
    rest,
    config,
    logger,
    emit,
    voice = discordVoice,
    spawnImpl = spawn,
    ffmpegFinder = findFfmpeg,
    soundcloud = defaultSoundCloud(),
    openDirect = openDirectStream,
    crossfadeSeconds = 0,
    // Voice commands (src/ozellikler/sesli-komut): true only for a guild where they are on and installed.
    // Otherwise the bot joins deafened, as always: it receives no audio at all.
    listening = () => false,
  }) {
    this.#listening = listening;
    this.#soundcloud = soundcloud;
    this.#openDirect = openDirect;
    this.crossfadeMs = Math.max(0, Number(crossfadeSeconds) || 0) * 1000;
    this.guildId = guildId;
    this.#voiceChannelId = voiceChannelId;
    this.textChannelId = textChannelId ?? null;
    this.volume = volume;
    this.#client = client;
    this.#rest = rest;
    this.#config = config;
    this.#logger = logger;
    this.#emit = emit;
    this.#voice = voice;
    this.#spawn = spawnImpl;
    this.#findFfmpeg = ffmpegFinder;
  }

  // ---------------------------------------------------------------- state

  /** The channel the bot is in (follows moves done by moderators). */
  get voiceChannelId() {
    return this.#connection?.joinConfig?.channelId ?? this.#voiceChannelId;
  }

  get connected() {
    return this.#connection?.state?.status === VoiceConnectionStatus.Ready;
  }

  /** Position in the current track in ms (pauses excluded, seeks included). */
  get position() {
    const current = this.queue.current;
    if (!current) return 0;
    return computePosition({
      seekBaseMs: this.#seekBaseMs,
      playbackDuration: playedIn(this.#pipeline),
      duration: current.info?.duration ?? 0,
      isStream: Boolean(current.info?.isStream),
    });
  }

  /** True while the previous track fades out under the current one. */
  get crossfading() {
    return Boolean(this.#pipeline?.carrier);
  }

  /** The voice connection's receiver while connected and not deafened (voice commands), else null. */
  get voiceReceiver() {
    const connection = this.#connection;
    if (!connection || connection.state?.status !== VoiceConnectionStatus.Ready) return null;
    return connection.joinConfig?.selfDeaf === false ? (connection.receiver ?? null) : null;
  }

  /**
   * Deafens or undeafens the bot in its channel without leaving it (voice commands switched on or off).
   * Returns false when there is no connection.
   */
  setListening(on) {
    const connection = this.#connection;
    if (!connection || connection.state?.status === VoiceConnectionStatus.Destroyed) return false;
    return connection.rejoin({ selfDeaf: !on, selfMute: false });
  }

  getData(key) {
    return this.#data.get(key);
  }

  setData(key, value) {
    this.#data.set(key, value);
  }

  // ---------------------------------------------------------------- public operations (serialized)

  /** Runs `fn` after every operation queued before it; errors do not break the chain. */
  #run(fn) {
    const next = this.#ops.then(fn, fn);
    this.#ops = next.catch(() => {});
    return next;
  }

  /** Joins the voice channel (self-deafened unless voice commands listen) and waits until Discord confirms it. */
  connect() {
    return this.#run(() => this.#connect());
  }

  /** Starts the current track, or the next one when nothing is current. No-op while playing. */
  play() {
    return this.#run(() => this.#play());
  }

  pause() {
    return this.#run(() => this.#pause());
  }

  resume() {
    return this.#run(() => this.#resume());
  }

  /**
   * Ends the current track and plays the next one. `skipTo` > 1 drops the tracks before that
   * 1-based queue position first.
   */
  skip(skipTo = 0) {
    return this.#run(() => this.#skip(skipTo));
  }

  /**
   * Goes back one track: the current track returns to the front of the queue and the previous
   * one plays (also when the queue had ended). Resolves with the track now playing, or null
   * when there was nothing to go back to. See TrackQueue#back for the repeat modes.
   */
  previous() {
    return this.#run(() => this.#previous());
  }

  /** Stops the current track and leaves the queue as it is (the queue-end timer may follow). */
  stopPlaying() {
    return this.#run(() => this.#stopPlaying());
  }

  seek(positionMs) {
    return this.#run(() => this.#seek(positionMs));
  }

  async setVolume(volume) {
    this.preMuteVolume = null;
    this.#applyVolume(volume);
  }

  /** Mutes (volume 0) and remembers the level; a second call keeps the first remembered level. */
  async mute() {
    if (this.preMuteVolume === null) this.preMuteVolume = this.volume;
    this.#applyVolume(0);
  }

  /** Back to the level before the mute. @returns {number} the level */
  async unmute() {
    const level = this.preMuteVolume ?? this.volume;
    this.preMuteVolume = null;
    this.#applyVolume(level);
    return level;
  }

  #applyVolume(volume) {
    this.volume = volume;
    // During a crossfade the mix plays through the previous track's resource (the carrier).
    for (const resource of [this.#pipeline?.resource, this.#pipeline?.carrier]) {
      resource?.volume?.setVolume(volume / 100);
    }
  }

  /**
   * Sets the crossfade length (0-12 s, 0 = off). Applies from the next track change; a fade that
   * is already audible finishes, one that is only prepared is dropped when switched off.
   */
  setCrossfade(seconds) {
    return this.#run(async () => {
      this.crossfadeMs = Math.max(0, Number(seconds) || 0) * 1000;
      this.setData('crossfade', this.crossfadeMs / 1000);
      // A different length needs a new schedule; off needs none.
      this.#dropPrepared({ force: false });
      return this.crossfadeMs / 1000;
    });
  }

  /** Changes the bass filter; a playing track restarts at its position with the new filter. */
  setBassboost(level) {
    return this.#run(async () => {
      this.bassboost = level;
      this.setData('bassboost', level);
      if (this.queue.current && this.#pipeline) await this.#seek(this.position);
    });
  }

  async setRepeatMode(mode) {
    this.repeatMode = mode;
  }

  /**
   * Pauses when playing, resumes when paused, decided inside the operation chain so quick
   * repeated presses alternate instead of racing. Resolves with the new paused flag.
   */
  togglePause() {
    return this.#run(async () => {
      if (this.paused) await this.#resume();
      else await this.#pause();
      return this.paused;
    });
  }

  /** Moves the repeat mode one step with `next(mode)` inside the chain; resolves with the new mode. */
  cycleRepeatMode(next) {
    return this.#run(async () => {
      this.repeatMode = next(this.repeatMode);
      return this.repeatMode;
    });
  }

  /**
   * Stops the audio pipeline but keeps the current track and its position, without any
   * track events. Used when the audio source (Lavalink) dropped; see restartCurrent().
   */
  suspend() {
    return this.#run(async () => {
      if (!this.#pipeline) return;
      this.#stopPipeline();
      this.playing = false;
      this.#emitUpdate();
    });
  }

  /**
   * Restarts the current track at `positionMs` (after suspend() or a lost source).
   * Rejects when the source cannot be opened again; the caller decides what to do then.
   */
  restartCurrent(positionMs, { paused = false } = {}) {
    return this.#run(async () => {
      if (!this.queue.current || this.destroyed) return;
      this.#stopPipeline();
      await this.#startCurrent(positionMs, { announce: false, rethrow: true });
      if (paused) await this.#pause();
    });
  }

  destroy(reason = 'Kapatıldı') {
    if (this.destroyed) return this.#ops;
    // Flag at once so a running operation stops as early as possible; the clean-up itself
    // waits for that operation like everything else.
    this.destroyed = true;
    this.#pipeline?.abort.abort();
    this.#prepared?.pipeline.abort.abort();
    return this.#run(() => this.#destroy(reason));
  }

  // ---------------------------------------------------------------- voice connection

  async #connect() {
    if (this.destroyed) throw new MusicError(ErrorCodes.NO_PLAYER, M.calmiyor);
    if (this.connected) return;
    const guild = this.#client.guilds.cache.get(this.guildId);
    if (!guild) throw new MusicError(ErrorCodes.NO_PLAYER, M.calmiyor);

    const connection = this.#voice.joinVoiceChannel({
      channelId: this.#voiceChannelId,
      guildId: this.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: !this.#listening(this.guildId),
      selfMute: false,
    });
    if (connection !== this.#connection) {
      this.#connection = connection;
      connection.on('stateChange', (oldState, newState) => this.#onConnectionState(connection, oldState, newState));
      connection.on('error', (error) =>
        this.#logger.warn(`Ses bağlantısı hatası (${this.guildId}): ${error?.message}`),
      );
      connection.subscribe(this.#ensureAudioPlayer());
    }
    try {
      await this.#voice.entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
    } catch {
      this.destroyed = true;
      await this.#destroy('Ses kanalına bağlanılamadı');
      throw new MusicError(ErrorCodes.VOICE_REQUIRED, M.sesBaglanamadi);
    }
  }

  #onConnectionState(connection, oldState, newState) {
    if (connection !== this.#connection || this.destroyed) return;
    if (newState.status === VoiceConnectionStatus.Ready && oldState?.status !== VoiceConnectionStatus.Ready) {
      // First join and every reconnect (a move): voice commands (re)attach to the receiver.
      this.#emit('voiceReady', this);
    } else if (newState.status === VoiceConnectionStatus.Disconnected) {
      // Either a moderator moved/kicked the bot or the websocket closed: @discordjs/voice
      // re-signals for a move; a kick stays disconnected and the player is closed.
      Promise.race([
        this.#voice.entersState(connection, VoiceConnectionStatus.Signalling, VOICE_RECONNECT_GRACE_MS),
        this.#voice.entersState(connection, VoiceConnectionStatus.Connecting, VOICE_RECONNECT_GRACE_MS),
      ]).catch(() => {
        if (this.#connection === connection && !this.destroyed) this.destroy('Ses kanalından çıkarıldı');
      });
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      if (!this.destroyed) this.destroy('Ses bağlantısı kapandı');
    }
  }

  #ensureAudioPlayer() {
    if (this.#audioPlayer) return this.#audioPlayer;
    const player = this.#voice.createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 250 },
    });
    player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        this.#run(() => this.#handleIdle(oldState.resource)).catch((error) =>
          this.#logger.error('Parça sonu işlenemedi:', error),
        );
      }
    });
    player.on('error', (error) => {
      // The resource stream broke (ffmpeg or the source). The Idle transition that follows decides.
      const pipeline = this.#pipeline;
      if (pipeline && pipeline.resource === error.resource) pipeline.errors.push(String(error?.message ?? error));
    });
    this.#audioPlayer = player;
    return player;
  }

  // ---------------------------------------------------------------- playback (inside the chain)

  async #play() {
    this.#clearQueueEndTimer();
    if (this.destroyed) throw new MusicError(ErrorCodes.NO_PLAYER, M.calmiyor);
    if (this.#pipeline) return;
    if (!this.queue.current) this.queue.advance();
    if (!this.queue.current) return;
    await this.#connect();
    this.#resumeAttempts = 0;
    await this.#startCurrent(0, { announce: true });
  }

  async #pause() {
    if (!this.queue.current || this.paused) return;
    this.paused = true;
    this.playing = false;
    this.#audioPlayer?.pause(true);
    this.#emitUpdate();
  }

  async #resume() {
    if (!this.queue.current || !this.paused) return;
    this.paused = false;
    if (this.#pipeline?.live) {
      // A live stream continues at "now", not with the audio buffered before the pause (whose
      // connection the server has probably closed meanwhile): open it again.
      this.#stopPipeline();
      await this.#startCurrent(this.#seekBaseMs, { announce: false });
    } else if (this.#pipeline) {
      this.playing = true;
      this.#audioPlayer?.unpause();
    } else {
      // Paused while the source was lost (recovery): restart from the remembered position.
      await this.#startCurrent(this.#seekBaseMs, { announce: false });
    }
    this.#emitUpdate();
  }

  async #skip(skipTo) {
    if (!this.queue.current || this.destroyed) return;
    if (skipTo > 1) this.queue.splice(0, skipTo - 1);
    const track = this.queue.current;
    this.#stopPipeline();
    await this.#afterTrackEnd(track, 'replaced');
  }

  async #previous() {
    if (this.destroyed) return null;
    const ended = this.queue.current;
    if (!this.queue.back(this.repeatMode)) return null;
    this.#clearQueueEndTimer();
    this.#stopPipeline();
    this.playing = false;
    this.paused = false;
    if (ended) this.#emit('trackEnd', this, ended, { reason: 'replaced' });
    if (this.destroyed) return null;
    await this.#connect();
    this.#resumeAttempts = 0;
    await this.#startCurrent(0, { announce: true });
    return this.queue.current;
  }

  async #stopPlaying() {
    const track = this.queue.current;
    if (!track || this.destroyed) return;
    this.#stopPipeline();
    this.queue.remember(track); // /previous can bring it back
    this.queue.current = null;
    this.playing = false;
    this.paused = false;
    this.#emit('trackEnd', this, track, { reason: 'stopped' });
    this.#onQueueEnd();
  }

  async #seek(positionMs) {
    if (!this.queue.current || this.destroyed) return;
    const wasPaused = this.paused;
    this.#stopPipeline();
    await this.#startCurrent(positionMs, { announce: false });
    if (wasPaused) await this.#pause();
  }

  async #destroy(reason) {
    this.destroyed = true;
    this.#clearQueueEndTimer();
    this.#stopUpdateTimer();
    const track = this.queue.current;
    this.#stopPipeline();
    if (track) this.#emit('trackEnd', this, track, { reason: 'cleanup' });
    this.queue.current = null;
    this.queue.clear();
    this.playing = false;
    this.paused = false;
    try {
      this.#audioPlayer?.stop(true);
    } catch {
      // already stopped
    }
    const connection = this.#connection;
    this.#connection = null;
    try {
      if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    } catch {
      // already destroyed
    }
    this.#emit('playerDestroy', this, reason);
  }

  // ---------------------------------------------------------------- pipeline

  /**
   * Opens the source stream of the current track at `seekMs` and starts playing it. A pipeline
   * prepared for a crossfade that did not happen (the previous track ended before the fade) is
   * used as it is when the track starts from the beginning.
   * Failures end the track (trackError + loadFailed) unless `rethrow` is set, or are handed to
   * the recovery ('sourceLost') when Lavalink itself is unreachable.
   */
  async #startCurrent(seekMs, { announce, rethrow = false }) {
    const track = this.queue.current;
    if (!track || this.destroyed) return;
    this.#clearReconnect();
    const prepared = this.#takePrepared(track, seekMs);
    const pipeline = prepared ?? newPipeline(track);
    this.#pipeline = pipeline;
    this.#seekBaseMs = Math.max(0, seekMs ?? 0);

    try {
      if (!prepared) {
        const opened = await this.#openPipeline(pipeline, this.#seekBaseMs, () => this.#pipeline === pipeline);
        if (!opened) return;
      }
      this.#attachResource(pipeline);
      this.playing = true;
      this.paused = false;
      this.#startUpdateTimer();
      if (announce) this.#emit('trackStart', this, track);
      this.#emitUpdate();
    } catch (error) {
      if (this.#pipeline !== pipeline) return; // replaced or stopped on purpose meanwhile
      this.#closePipeline(pipeline);
      this.#pipeline = null;
      this.#stopUpdateTimer();
      this.playing = false;
      if (this.destroyed) return;
      if (rethrow) throw error;
      const networkError = !(error instanceof MusicError) && !(error instanceof LavalinkRequestError);
      if (networkError && usesLavalink(track) && !this.#rest.connected) {
        // Lavalink is unreachable: not the track's fault, let the recovery resume it later.
        this.#emit('sourceLost', this, { position: this.#seekBaseMs, paused: this.paused });
        return;
      }
      await this.#handleFailure(track, error);
    }
  }

  /**
   * Opens the audio source of `pipeline.track` and starts ffmpeg on it; the PCM ends up in
   * `pipeline.mixer` (no audio resource yet). `stillWanted()` is checked after every wait: when it
   * says no, everything opened so far is closed and false is returned. Throws on failures.
   */
  async #openPipeline(pipeline, seekMs, stillWanted) {
    const { track, abort } = pipeline;
    const valid = () => stillWanted() && !this.destroyed;
    const ffmpegPath = await this.#findFfmpeg();
    if (!ffmpegPath) throw new MusicError(ErrorCodes.LOAD_FAILED, M.ffmpegYok);
    const source = await resolveStreamSource(track, this.#rest, { soundcloud: this.#soundcloud });
    if (!valid()) return false;
    pipeline.kind = source.kind;
    // Byte 0 of this pipeline's PCM is this point of the track (kept across a crossfade hand-over).
    pipeline.startMs = Math.max(0, seekMs ?? 0);
    pipeline.live = isLive(track);
    let input = 'pipe:0';
    let maxDurationMs = null;
    if (source.kind === 'youtube') {
      pipeline.stream = await this.#rest.openStream(source.videoId, { signal: abort.signal });
    } else if (source.kind === 'http') {
      pipeline.stream = await this.#openDirect(source.url, { signal: abort.signal, live: pipeline.live });
      maxDurationMs = pipeline.live ? DIRECT_LIVE_MAX_MS : DIRECT_MAX_DURATION_MS;
    } else {
      input = source.url; // https only (buildFfmpegArgs refuses anything else)
    }
    if (!valid()) {
      this.#closePipeline(pipeline);
      return false;
    }

    // A live stream cannot be seeked: the position keeps counting, ffmpeg starts at "now".
    const args = buildFfmpegArgs({
      seekMs: pipeline.live ? 0 : seekMs,
      bassboost: this.bassboost,
      input,
      maxDurationMs,
    });
    const ffmpeg = this.#spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    pipeline.ffmpeg = ffmpeg;
    ffmpeg.stderr?.setEncoding?.('utf8');
    ffmpeg.stderr?.on('data', (chunk) => {
      pipeline.errors.push(String(chunk).trim());
      if (pipeline.errors.length > 20) pipeline.errors.shift();
    });
    ffmpeg.on('error', (error) => pipeline.errors.push(`ffmpeg: ${error.message}`));
    ffmpeg.stdin.on('error', () => {}); // EPIPE when ffmpeg quits first
    const stream = pipeline.stream;
    if (stream) {
      stream.on('error', (error) => {
        pipeline.streamError = error;
        ffmpeg.stdin.end();
      });
      stream.pipe(ffmpeg.stdin);
    } else {
      ffmpeg.stdin.end(); // ffmpeg reads the network input itself
    }
    pipeline.mixer = new CrossfadeMixer(ffmpeg.stdout);
    pipeline.mixer.on('error', (error) => pipeline.errors.push(String(error?.message ?? error)));
    return true;
  }

  /** Plays `pipeline.mixer` through a new audio resource at the current volume. */
  #attachResource(pipeline) {
    const resource = this.#voice.createAudioResource(pipeline.mixer, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume?.setVolume(this.volume / 100);
    pipeline.resource = resource;
    this.#ensureAudioPlayer().play(resource);
  }

  /** Runs in the chain when @discordjs/voice reports that a resource ended. */
  async #handleIdle(resource) {
    const pipeline = this.#pipeline;
    if (!pipeline || this.destroyed) return;
    // The fading-out track's resource ended: the current track continues on its own resource.
    if (pipeline.carrier && pipeline.carrier === resource) {
      this.#handover(pipeline);
      return;
    }
    // A stop we did on purpose already replaced/cleared #pipeline: nothing to do for that one.
    if (pipeline.resource !== resource) return;
    this.#pipeline = null;
    this.#stopUpdateTimer();
    this.#dropPrepared({ unless: pipeline });
    this.#closePipeline(pipeline);
    const track = pipeline.track;
    const playedNow = resource?.playbackDuration ?? 0;
    const played = this.#seekBaseMs + playedNow;
    const duration = track.info?.duration ?? 0;
    const cutShort = Boolean(duration > 0 && !track.info?.isStream && played < duration - EARLY_END_TOLERANCE_MS);
    const brokenSource = Boolean(pipeline.streamError || pipeline.errors.length > 0 || pipeline.stream?.truncated);
    this.#seekBaseMs = played;

    if ((brokenSource || cutShort) && usesLavalink(track) && !this.#rest.connected) {
      // Lavalink (the source) went away: keep the track, let the recovery resume it later.
      this.playing = false;
      this.#emit('sourceLost', this, { position: played, paused: this.paused });
      return;
    }
    if (pipeline.live) {
      await this.#handleLiveEnd(track, pipeline, { playedNow, played });
      return;
    }
    if (playedNow < MIN_PLAYED_FOR_FINISHED_MS && (brokenSource || cutShort)) {
      const detail = pipeline.streamError?.message ?? pipeline.errors.filter(Boolean).slice(-2).join(' | ');
      await this.#handleFailure(track, new Error(detail || M.kaynakKesildi));
      return;
    }
    if (cutShort && this.#resumeAttempts < MAX_RESUME_ATTEMPTS) {
      // The source stopped early (e.g. the HTTP stream was cut): continue from where we are.
      this.#resumeAttempts += 1;
      this.#logger.warn(
        `Ses kaynağı erken bitti (${track.info?.title ?? '?'}, ${Math.round(played / 1000)}/${Math.round(duration / 1000)} sn); ` +
          `kaldığı yerden yeniden açılıyor (${this.#resumeAttempts}/${MAX_RESUME_ATTEMPTS}).`,
      );
      await this.#startCurrent(played, { announce: false });
      return;
    }
    if (cutShort) this.#logger.warn(`Parça erken bitti (${track.info?.title ?? '?'}): ${pipeline.errors.at(-1) ?? ''}`);
    this.playing = false;
    await this.#afterTrackEnd(track, 'finished');
  }

  /**
   * A live stream has no end of its own: when it stops, it is reconnected (MAX_LIVE_RECONNECTS
   * times, the count restarting after LIVE_HEALTHY_MS of play). One that never played fails at once.
   */
  async #handleLiveEnd(track, pipeline, { playedNow, played }) {
    if (played < MIN_PLAYED_FOR_FINISHED_MS && this.#liveReconnects === 0) {
      const detail = pipeline.streamError?.message ?? pipeline.errors.filter(Boolean).slice(-2).join(' | ');
      await this.#handleFailure(track, new Error(detail || M.kaynakKesildi));
      return;
    }
    if (playedNow >= LIVE_HEALTHY_MS) this.#liveReconnects = 0;
    if (this.#liveReconnects >= MAX_LIVE_RECONNECTS) {
      this.#logger.warn(`Canlı yayın yeniden bağlanamadı (${track.info?.title ?? '?'}).`);
      await this.#handleFailure(track, new MusicError(ErrorCodes.LOAD_FAILED, M.canliYayinKoptu));
      return;
    }
    this.#liveReconnects += 1;
    const attempt = this.#liveReconnects;
    this.#logger.warn(
      `Canlı yayın kesildi (${track.info?.title ?? '?'}); yeniden bağlanılıyor (${attempt}/${MAX_LIVE_RECONNECTS}).`,
    );
    this.#clearReconnect();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#run(async () => {
        if (this.destroyed || this.paused || this.#pipeline || this.queue.current !== track) return;
        await this.#startCurrent(this.#seekBaseMs, { announce: false });
      }).catch((error) => this.#logger.error('Canlı yayın yeniden bağlanamadı:', error));
    }, LIVE_RECONNECT_DELAY_MS * attempt);
    this.#reconnectTimer.unref?.();
  }

  #clearReconnect() {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  async #handleFailure(track, error) {
    const message = error instanceof MusicError ? error.message : String(error?.message ?? error);
    const exception = error instanceof MusicError ? { message, code: error.code } : { message };
    this.playing = false;
    this.paused = false;
    this.#emit('trackError', this, track, { exception });
    // Let the trackError listeners queue a replacement (next search result) before we move on.
    await sleepImmediate();
    if (this.destroyed || this.queue.current !== track) return;
    this.#emit('trackEnd', this, track, { reason: 'loadFailed' });
    // Never repeat a track that cannot be played, and do not offer it to /previous either.
    this.queue.advance();
    if (this.queue.previous[0] === track) this.queue.previous.shift();
    await this.#playNextOrEnd();
  }

  /** Emits trackEnd and continues with what the repeat mode says. */
  async #afterTrackEnd(track, reason) {
    this.#emit('trackEnd', this, track, { reason });
    if (this.destroyed) return;
    this.queue.next(this.repeatMode, reason);
    await this.#playNextOrEnd();
  }

  async #playNextOrEnd() {
    if (this.destroyed) return;
    if (this.queue.current) {
      this.#resumeAttempts = 0;
      this.#liveReconnects = 0;
      await this.#startCurrent(0, { announce: true });
    } else {
      this.playing = false;
      this.paused = false;
      this.#onQueueEnd();
    }
  }

  #onQueueEnd() {
    this.#emit('queueEnd', this);
    this.#emitUpdate();
    if (this.#config.music.twentyFourSeven) return;
    const seconds = this.#config.music.leaveAfterQueueEndSeconds ?? 120;
    this.#clearQueueEndTimer();
    this.#queueEndTimer = setTimeout(
      () => {
        this.#queueEndTimer = null;
        if (!this.destroyed && !this.queue.current) this.destroy('Kuyruk bitti').catch(() => {});
      },
      Math.max(1, seconds) * 1000,
    );
    this.#queueEndTimer.unref?.();
  }

  // ---------------------------------------------------------------- crossfade

  /** The track a crossfade may go into now, or null (see the invariants on the class). */
  #crossfadeCandidate(current) {
    if (this.repeatMode === 'track') return null;
    const next = this.queue.tracks[0] ?? null;
    if (!next || next === current || isLive(next) || isLive(current) || !isStreamable(next)) return null;
    const minimum = this.crossfadeMs * 2;
    if ((current.info?.duration ?? 0) < minimum || (next.info?.duration ?? 0) < minimum) return null;
    return next;
  }

  /** Called every POSITION_UPDATE_MS while playing: opens the next track in time for the fade. */
  #maybePrepare() {
    if (this.crossfadeMs <= 0 || this.#prepared || this.destroyed || this.paused) return;
    const from = this.#pipeline;
    if (!from?.resource || from.carrier || !from.mixer || from.live) return;
    const current = from.track;
    if (current !== this.queue.current) return;
    const next = this.#crossfadeCandidate(current);
    if (!next) return;
    const duration = current.info.duration;
    const position = this.position;
    if (position < duration - this.crossfadeMs - CROSSFADE_PREPARE_LEAD_MS || position > duration - 1500) return;

    const prepared = { track: next, pipeline: newPipeline(next), from, ready: false, failed: false };
    this.#prepared = prepared;
    this.#openPipeline(prepared.pipeline, 0, () => this.#prepared === prepared).then(
      (opened) => {
        if (!opened || this.#prepared !== prepared) return;
        prepared.ready = true;
        this.#scheduleFade(prepared);
      },
      (error) => {
        this.#closePipeline(prepared.pipeline);
        // Kept as failed so it is not retried every second; the normal start reports the error.
        if (this.#prepared === prepared) prepared.failed = true;
        this.#logger.debug?.(`Geçiş için sıradaki parça açılamadı: ${error?.message ?? error}`);
      },
    );
  }

  /** Tells the current mixer where the fade starts and what it fades into. */
  #scheduleFade(prepared) {
    const from = prepared.from;
    if (this.#pipeline !== from || !from.mixer || from.carrier) {
      this.#dropPrepared({ force: true });
      return;
    }
    // The mixer counts bytes from where this pipeline's PCM starts (its seek point), not from
    // #seekBaseMs: after a crossfade hand-over that also holds the fade played on the carrier.
    const fadeStartMs = from.track.info.duration - this.crossfadeMs - from.startMs;
    from.mixer.scheduleFade({
      atByte: pcmBytes(fadeStartMs),
      fadeBytes: pcmBytes(this.crossfadeMs),
      next: prepared.pipeline.mixer,
      shouldStart: () => {
        const ok = this.#canStartFade(prepared);
        // Not this fade any more (queue changed, repeat on, ...): close the prepared track.
        if (!ok) queueMicrotask(() => this.#prepared === prepared && this.#dropPrepared({ force: true }));
        return ok;
      },
      onStart: () => {
        const startByte = from.mixer.bytesOut;
        this.#run(() => this.#beginCrossfade(prepared, startByte)).catch((error) =>
          this.#logger.error('Geçiş başlatılamadı:', error),
        );
      },
    });
  }

  /** Synchronous check right before the first mixed byte: is this still the right fade? */
  #canStartFade(prepared) {
    return (
      this.#prepared === prepared &&
      prepared.ready &&
      !this.destroyed &&
      !this.paused &&
      this.crossfadeMs > 0 &&
      this.#pipeline === prepared.from &&
      this.repeatMode !== 'track' &&
      this.queue.tracks[0] === prepared.track
    );
  }

  /**
   * In the chain, once the fade is audible: the old track ends (finished), the prepared one becomes
   * current and is announced. Its position counts on the old resource until the handover.
   */
  async #beginCrossfade(prepared, startByte) {
    const from = prepared.from;
    // Stale: a stop/seek/skip queued before this closed both pipelines already.
    if (this.#prepared !== prepared || this.#pipeline !== from || this.destroyed) return;
    this.#prepared = null;
    const pipeline = prepared.pipeline;
    pipeline.carrier = from.resource;
    pipeline.carrierBase = startByte / PCM_BYTES_PER_MS;
    pipeline.fadeFrom = from;
    // The mix ends exactly where the next resource continues: no silence padding in between.
    if (from.resource && from.resource.silenceRemaining === -1) from.resource.silencePaddingFrames = 0;

    const ended = from.track;
    this.#emit('trackEnd', this, ended, { reason: 'finished' });
    if (this.destroyed) return;
    const next = this.queue.next(this.repeatMode, 'finished');
    if (next !== pipeline.track) {
      // The queue changed between the check and now: cut over to what plays next, without a fade.
      this.#pipeline = null;
      this.#stopUpdateTimer();
      this.#closePipeline(from);
      this.#closePipeline(pipeline);
      this.#stopAudioPlayer();
      await this.#playNextOrEnd();
      return;
    }
    this.#pipeline = pipeline;
    this.#seekBaseMs = 0;
    this.#resumeAttempts = 0;
    this.#liveReconnects = 0;
    this.playing = true;
    this.#emit('trackStart', this, pipeline.track);
    this.#emitUpdate();
  }

  /** The fading track's resource ended: the current track goes on with its own resource. */
  #handover(pipeline) {
    const carrier = pipeline.carrier;
    const fading = pipeline.fadeFrom;
    this.#seekBaseMs += Math.max(0, (carrier?.playbackDuration ?? 0) - pipeline.carrierBase);
    pipeline.carrier = null;
    pipeline.fadeFrom = null;
    pipeline.carrierBase = 0;
    if (fading) this.#closePipeline(fading);
    this.#attachResource(pipeline);
    this.#emitUpdate();
  }

  /**
   * Uses the prepared pipeline for `track` when it starts from the beginning and nothing of it
   * was played yet; otherwise closes it. Returns the pipeline or null.
   */
  #takePrepared(track, seekMs) {
    const prepared = this.#prepared;
    if (!prepared) return null;
    const usable =
      prepared.track === track &&
      prepared.ready &&
      !prepared.failed &&
      !(seekMs > 0) &&
      prepared.pipeline.mixer &&
      prepared.pipeline.mixer.consumed === 0 &&
      !prepared.pipeline.mixer.destroyed;
    this.#prepared = null;
    if (usable) return prepared.pipeline;
    this.#closePipeline(prepared.pipeline);
    return null;
  }

  /**
   * Closes the prepared pipeline. `force: false` keeps it when its fade is already being mixed
   * (then it is about to become current). `unless`: the pipeline that just ended on its own; when
   * the prepared track was to fade in after it but the fade never started (the track ended
   * earlier than its stated duration), it is kept so the next track starts from it without a gap.
   */
  #dropPrepared({ force = true, unless = null } = {}) {
    const prepared = this.#prepared;
    if (!prepared) return;
    const mixing = prepared.from?.mixer?.mode === 'fade';
    if (!force && mixing) return;
    if (unless && prepared.from === unless && !mixing && prepared.ready && !prepared.failed) {
      unless.mixer?.cancelFade?.();
      return;
    }
    prepared.from?.mixer?.cancelFade?.();
    this.#prepared = null;
    this.#closePipeline(prepared.pipeline);
  }

  /**
   * Stops the running pipeline on purpose and remembers the position reached. The Idle event
   * this causes finds a different (or no) pipeline and is ignored. A prepared next track and a
   * fading previous one are closed too.
   */
  #stopPipeline() {
    this.#clearReconnect();
    this.#dropPrepared({ force: true });
    const pipeline = this.#pipeline;
    if (!pipeline) return;
    this.#pipeline = null;
    this.#stopUpdateTimer();
    this.#seekBaseMs += playedIn(pipeline);
    if (pipeline.fadeFrom) this.#closePipeline(pipeline.fadeFrom);
    this.#closePipeline(pipeline);
    this.#stopAudioPlayer();
  }

  #stopAudioPlayer() {
    try {
      this.#audioPlayer?.stop(true);
    } catch {
      // ignore
    }
  }

  /** Releases the HTTP stream, ffmpeg, the mixer and the audio resource of a pipeline. */
  #closePipeline(pipeline) {
    if (!pipeline) return;
    try {
      pipeline.abort.abort();
    } catch {
      // ignore
    }
    try {
      pipeline.stream?.destroy();
    } catch {
      // ignore
    }
    try {
      pipeline.mixer?.destroy();
    } catch {
      // ignore
    }
    try {
      pipeline.ffmpeg?.stdin?.destroy();
      pipeline.ffmpeg?.stdout?.destroy();
      pipeline.ffmpeg?.kill();
    } catch {
      // ignore
    }
  }

  #clearQueueEndTimer() {
    if (this.#queueEndTimer) clearTimeout(this.#queueEndTimer);
    this.#queueEndTimer = null;
  }

  #startUpdateTimer() {
    this.#stopUpdateTimer();
    this.#updateTimer = setInterval(() => {
      this.#emitUpdate();
      this.#maybePrepare();
    }, POSITION_UPDATE_MS);
    this.#updateTimer.unref?.();
  }

  #stopUpdateTimer() {
    if (this.#updateTimer) clearInterval(this.#updateTimer);
    this.#updateTimer = null;
  }

  #emitUpdate() {
    if (!this.destroyed) this.#emit('playerUpdate', null, this);
  }

  /** For tests: runs the crossfade preparation check now instead of on the next timer tick. */
  checkCrossfade() {
    this.#maybePrepare();
  }
}

/** A new, not yet opened pipeline for `track` (see #pipeline). */
function newPipeline(track) {
  return {
    track,
    kind: null,
    live: false,
    startMs: 0,
    abort: new AbortController(),
    stream: null,
    ffmpeg: null,
    mixer: null,
    resource: null,
    errors: [],
    streamError: null,
    carrier: null,
    carrierBase: 0,
    fadeFrom: null,
  };
}

/** Audio of a pipeline played so far (ms): on its own resource, or on the carrier during a fade. */
function playedIn(pipeline) {
  if (!pipeline) return 0;
  if (pipeline.carrier) return Math.max(0, (pipeline.carrier.playbackDuration ?? 0) - pipeline.carrierBase);
  return pipeline.resource?.playbackDuration ?? 0;
}
