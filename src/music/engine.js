// Ses motoru: sunucu başına bir GuildPlayer tutar ve oynatıcı olaylarını tek yerden yayar.
// MusicService bu motoru kullanır; normalde dokunmana gerek yok.

import { EventEmitter } from 'node:events';
import { GuildPlayer } from './GuildPlayer.js';

/**
 * Owns the per-guild players and re-emits their events (trackStart, trackEnd, trackError,
 * queueEnd, playerUpdate, playerDestroy, sourceLost) with the player as the first argument.
 */
export class VoiceEngine extends EventEmitter {
  /** @type {Map<string, GuildPlayer>} */
  players = new Map();
  #client;
  #rest;
  #config;
  #logger;
  #playerOptions;

  constructor({ client, rest, config, logger, playerOptions = {} }) {
    super();
    this.#client = client;
    this.#rest = rest;
    this.#config = config;
    this.#logger = logger;
    this.#playerOptions = playerOptions;
  }

  getPlayer(guildId) {
    return this.players.get(guildId) ?? null;
  }

  /** Creates (or returns) the player of a guild. It is not connected yet; call player.connect(). */
  createPlayer({ guildId, voiceChannelId, textChannelId, volume }) {
    const existing = this.players.get(guildId);
    if (existing) return existing;
    const player = new GuildPlayer({
      guildId,
      voiceChannelId,
      textChannelId,
      volume,
      client: this.#client,
      rest: this.#rest,
      config: this.#config,
      logger: this.#logger,
      emit: (event, ...args) => this.#forward(event, ...args),
      ...this.#playerOptions,
    });
    this.players.set(guildId, player);
    return player;
  }

  #forward(event, ...args) {
    if (event === 'playerDestroy') {
      const [player] = args;
      if (this.players.get(player.guildId) === player) this.players.delete(player.guildId);
    }
    try {
      this.emit(event, ...args);
    } catch (error) {
      this.#logger.error(`Oynatıcı olayı işlenemedi (${event}):`, error);
    }
  }

  /** Closes every player (shutdown). */
  async destroyAll(reason = 'Bot kapanıyor') {
    await Promise.all([...this.players.values()].map((player) => player.destroy(reason).catch(() => {})));
  }
}

export function createVoiceEngine(options) {
  return new VoiceEngine(options);
}
