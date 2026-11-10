// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Bir sunucunun oynatıcısı: Discord ses kanalına bağlanır, parçanın
// sesini Lavalink'ten (YouTube eklentisi) akış olarak alır, ffmpeg ile PCM'e çevirir ve
// @discordjs/voice ile (DAVE uçtan uca şifreli) Discord'a gönderir. Kuyruk, tekrar, ses,
// bas, sarma ve konum burada tutulur. README > Teknik notlar bu tasarımın nedenini anlatır.
// ---------------------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import * as discordVoice from '@discordjs/voice';
import { muzik as M } from '../mesajlar.js';
import { resolveStreamSource } from './audioSource.js';
import { ErrorCodes, MusicError } from './errors.js';
import { buildFfmpegArgs, findFfmpeg } from './ffmpeg.js';
import { LavalinkRequestError } from './lavalink.js';
import { TrackQueue } from './Queue.js';

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
 *   sourceLost(player, { position, paused }) when the audio source (Lavalink) went away mid-track.
 * trackEnd reasons: finished, replaced (skip), stopped, loadFailed, cleanup (destroyed).
 */
export class GuildPlayer {
  guildId;
  textChannelId;
  queue = new TrackQueue();
  repeatMode = 'off';
  volume;
  bassboost = 'none';
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
  #data = new Map();
  #connection = null;
  #audioPlayer = null;
  /** { track, abort, stream, ffmpeg, resource, errors: string[], streamError } of the running stream */
  #pipeline = null;
  #seekBaseMs = 0;
  #resumeAttempts = 0;
  #updateTimer = null;
  #queueEndTimer = null;
  #ops = Promise.resolve();

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
  }) {
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
      playbackDuration: this.#pipeline?.resource?.playbackDuration ?? 0,
      duration: current.info?.duration ?? 0,
      isStream: Boolean(current.info?.isStream),
    });
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

  /** Joins the voice channel (self-deafened) and waits until Discord confirms it. */
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

  /** Stops the current track and leaves the queue as it is (the queue-end timer may follow). */
  stopPlaying() {
    return this.#run(() => this.#stopPlaying());
  }

  seek(positionMs) {
    return this.#run(() => this.#seek(positionMs));
  }

  async setVolume(volume) {
    this.volume = volume;
    this.#pipeline?.resource?.volume?.setVolume(volume / 100);
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
      selfDeaf: true,
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

  #onConnectionState(connection, _oldState, newState) {
    if (connection !== this.#connection || this.destroyed) return;
    if (newState.status === VoiceConnectionStatus.Disconnected) {
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
    if (this.#pipeline) {
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

  async #stopPlaying() {
    const track = this.queue.current;
    if (!track || this.destroyed) return;
    this.#stopPipeline();
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
   * Opens the source stream of the current track at `seekMs` and starts playing it.
   * Failures end the track (trackError + loadFailed) unless `rethrow` is set, or are handed to
   * the recovery ('sourceLost') when Lavalink itself is unreachable.
   */
  async #startCurrent(seekMs, { announce, rethrow = false }) {
    const track = this.queue.current;
    if (!track || this.destroyed) return;
    const abort = new AbortController();
    const pipeline = { track, abort, stream: null, ffmpeg: null, resource: null, errors: [], streamError: null };
    this.#pipeline = pipeline;
    this.#seekBaseMs = Math.max(0, seekMs ?? 0);

    try {
      const ffmpegPath = await this.#findFfmpeg();
      if (!ffmpegPath) throw new MusicError(ErrorCodes.LOAD_FAILED, M.ffmpegYok);
      const { videoId } = await resolveStreamSource(track, this.#rest);
      if (this.#pipeline !== pipeline || this.destroyed) return;
      const stream = await this.#rest.openStream(videoId, { signal: abort.signal });
      pipeline.stream = stream;
      if (this.#pipeline !== pipeline || this.destroyed) {
        this.#closePipeline(pipeline);
        return;
      }

      const ffmpeg = this.#spawn(ffmpegPath, buildFfmpegArgs({ seekMs: this.#seekBaseMs, bassboost: this.bassboost }), {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      pipeline.ffmpeg = ffmpeg;
      ffmpeg.stderr?.setEncoding?.('utf8');
      ffmpeg.stderr?.on('data', (chunk) => {
        pipeline.errors.push(String(chunk).trim());
        if (pipeline.errors.length > 20) pipeline.errors.shift();
      });
      ffmpeg.on('error', (error) => pipeline.errors.push(`ffmpeg: ${error.message}`));
      ffmpeg.stdin.on('error', () => {}); // EPIPE when ffmpeg quits first
      stream.on('error', (error) => {
        pipeline.streamError = error;
        ffmpeg.stdin.end();
      });
      stream.pipe(ffmpeg.stdin);

      const resource = this.#voice.createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });
      resource.volume?.setVolume(this.volume / 100);
      pipeline.resource = resource;
      this.#ensureAudioPlayer().play(resource);
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
      if (networkError && !this.#rest.connected) {
        // Lavalink is unreachable: not the track's fault, let the recovery resume it later.
        this.#emit('sourceLost', this, { position: this.#seekBaseMs, paused: this.paused });
        return;
      }
      await this.#handleFailure(track, error);
    }
  }

  /** Runs in the chain when @discordjs/voice reports that a resource ended. */
  async #handleIdle(resource) {
    const pipeline = this.#pipeline;
    // A stop we did on purpose already replaced/cleared #pipeline: nothing to do for that one.
    if (!pipeline || pipeline.resource !== resource || this.destroyed) return;
    this.#pipeline = null;
    this.#stopUpdateTimer();
    this.#closePipeline(pipeline);
    const track = pipeline.track;
    const played = this.#seekBaseMs + (resource?.playbackDuration ?? 0);
    const duration = track.info?.duration ?? 0;
    const cutShort = Boolean(duration > 0 && !track.info?.isStream && played < duration - EARLY_END_TOLERANCE_MS);
    const brokenSource = Boolean(pipeline.streamError || pipeline.errors.length > 0 || pipeline.stream?.truncated);
    this.#seekBaseMs = played;

    if ((brokenSource || cutShort) && !this.#rest.connected) {
      // Lavalink (the source) went away: keep the track, let the recovery resume it later.
      this.playing = false;
      this.#emit('sourceLost', this, { position: played, paused: this.paused });
      return;
    }
    if ((resource?.playbackDuration ?? 0) < MIN_PLAYED_FOR_FINISHED_MS && (brokenSource || cutShort)) {
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
    // Never repeat a track that cannot be played.
    this.queue.advance();
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

  /**
   * Stops the running pipeline on purpose and remembers the position reached. The Idle event
   * this causes finds a different (or no) pipeline and is ignored.
   */
  #stopPipeline() {
    const pipeline = this.#pipeline;
    if (!pipeline) return;
    this.#pipeline = null;
    this.#stopUpdateTimer();
    this.#seekBaseMs += pipeline.resource?.playbackDuration ?? 0;
    this.#closePipeline(pipeline);
    try {
      this.#audioPlayer?.stop(true);
    } catch {
      // ignore
    }
  }

  /** Releases the HTTP stream, ffmpeg and the audio resource of a pipeline. */
  #closePipeline(pipeline) {
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
    this.#updateTimer = setInterval(() => this.#emitUpdate(), POSITION_UPDATE_MS);
    this.#updateTimer.unref?.();
  }

  #stopUpdateTimer() {
    if (this.#updateTimer) clearInterval(this.#updateTimer);
    this.#updateTimer = null;
  }

  #emitUpdate() {
    if (!this.destroyed) this.#emit('playerUpdate', null, this);
  }
}
