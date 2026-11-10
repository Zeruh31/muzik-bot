// Müzik hatalarının türleri. Mesaj metinleri src/mesajlar.js içinde (muzik bölümü).

import { muzik as M } from '../mesajlar.js';

/**
 * An expected, user-facing music error. `message` is Turkish and safe to show to users;
 * `code` is stable so other front-ends (e.g. the web panel) can map it to HTTP statuses.
 */
export class MusicError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MusicError';
    this.code = code;
  }
}

export const ErrorCodes = Object.freeze({
  NODE_UNAVAILABLE: 'NODE_UNAVAILABLE',
  NO_PLAYER: 'NO_PLAYER',
  NOTHING_PLAYING: 'NOTHING_PLAYING',
  EMPTY_QUEUE: 'EMPTY_QUEUE',
  INVALID_POSITION: 'INVALID_POSITION',
  INVALID_VALUE: 'INVALID_VALUE',
  NOT_FOUND: 'NOT_FOUND',
  LOAD_FAILED: 'LOAD_FAILED',
  SOURCE_DISABLED: 'SOURCE_DISABLED',
  SOURCE_UNSUPPORTED: 'SOURCE_UNSUPPORTED',
  QUEUE_FULL: 'QUEUE_FULL',
  NOT_SEEKABLE: 'NOT_SEEKABLE',
  LYRICS_UNAVAILABLE: 'LYRICS_UNAVAILABLE',
  VOICE_REQUIRED: 'VOICE_REQUIRED',
  WRONG_CHANNEL: 'WRONG_CHANNEL',
  MISSING_PERMISSIONS: 'MISSING_PERMISSIONS',
  RECOVERING: 'RECOVERING',
});

/**
 * Converts raw Lavalink REST / network errors into MusicError with a Turkish message.
 * Unknown errors are returned unchanged so they still get logged with a stack.
 */
export function translateLavalinkError(error) {
  if (error instanceof MusicError) return error;
  const text = String(error?.message ?? error);

  const disabledSource = text.match(/has not '([a-z]+)' enabled/i);
  if (disabledSource) {
    const source = disabledSource[1].toLowerCase();
    if (source === 'spotify') {
      return new MusicError(ErrorCodes.SOURCE_DISABLED, M.spotifyKapali);
    }
    return new MusicError(ErrorCodes.SOURCE_DISABLED, M.kaynakKapali(source));
  }
  if (
    /No Lavalink Node|No available Node|not connected|ECONNREFUSED|fetch failed|Node is either not ready/i.test(text)
  ) {
    return new MusicError(ErrorCodes.NODE_UNAVAILABLE, M.lavalinkYok);
  }
  if (/Query is not allowed|blacklist|not whitelisted/i.test(text)) {
    return new MusicError(ErrorCodes.INVALID_VALUE, M.baglantiyaIzinYok);
  }
  if (/Node Request resulted into an error/i.test(text)) {
    return new MusicError(ErrorCodes.LOAD_FAILED, M.sunucuIsleyemedi);
  }
  return error;
}
