// Bir sunucunun ses kanalında kişi başına ses alma: bot kanala girince kanaldakilere, sonra konuşmaya başlayan
// herkese abone olur (EndBehaviorType.Manual: abonelik cümleler arasında kapanmaz, paket kaybolmaz). Her Opus
// paketi çözülür, 16 kHz mono'ya çevrilir ve işçiye gider; bellekte işlenir, diske yazılmaz.
//   - Hariç tutulan kişiye abone olunmaz; zaten abonesi varsa abonelik kapatılır: paketleri işlenmeden atılır.
//   - Botlara abone olunmaz.
//   - Kişi susunca (Discord sessizlikte paket göndermez) işçiye "idle" gider; işçi cümleyi bitirir.
//   - DAVE çözümü bozulursa (art arda çözülemeyen paketler ya da kapanan akış) abonelik artan bekleme ile
//     (1, 2, 5, 10, 30 sn) yeniden açılır; iyi bir paket bekleme sayacını sıfırlar.
// Normalde bu dosyaya dokunmana gerek yok.

import * as discordVoice from '@discordjs/voice';
import { Downsampler48kStereoTo16kMono } from './pcm.js';

const { EndBehaviorType } = discordVoice;
/** After Discord's "speaking end" (100 ms without packets) this much more silence ends the sentence. */
export const IDLE_AFTER_MS = 400;
/** This many undecodable packets in a row (~1 s of speech) means a broken DAVE session: reopen the stream. */
export const REOPEN_AFTER_ERRORS = 50;
/** Waits before reopening, growing after each failure in a row (reset by a good packet). */
export const REOPEN_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10_000, 30_000]);

async function defaultOpus() {
  const { default: opus } = await import('@discordjs/opus');
  return opus.OpusEncoder;
}

/**
 * @param {object} deps
 * @param {string} deps.guildId
 * @param {object} deps.receiver the voice connection's VoiceReceiver
 * @param {() => string[]} deps.humans ids of the people in the bot's channel now
 * @param {(userId: string) => boolean} deps.isBot
 * @param {(userId: string) => boolean} deps.isExcluded
 * @param {{ audio(key, pcm), idle(key), end(key) }} deps.sink where the audio goes (the worker)
 * @param {Function} [deps.Opus] an OpusEncoder class (tests pass a fake)
 */
export async function createListener({
  guildId,
  receiver,
  humans,
  isBot,
  isExcluded,
  sink,
  Opus,
  logger,
  timers = globalThis,
}) {
  const OpusEncoder = Opus ?? (await defaultOpus());
  /** userId -> { stream, decoder, ds, idleTimer, errors } */
  const subs = new Map();
  /** userId -> { attempt, timer } while a broken stream waits to be reopened */
  const retries = new Map();
  let stopped = false;
  const keyOf = (userId) => `${guildId}:${userId}`;

  function drop(userId, { notify = true } = {}) {
    const sub = subs.get(userId);
    if (!sub) return;
    subs.delete(userId);
    if (sub.idleTimer) timers.clearTimeout(sub.idleTimer);
    sub.stream.removeAllListeners('data');
    try {
      sub.stream.destroy();
    } catch {
      // already closed
    }
    if (notify) sink.end(keyOf(userId));
  }

  function clearRetry(userId) {
    const retry = retries.get(userId);
    if (retry?.timer) timers.clearTimeout(retry.timer);
    retries.delete(userId);
  }

  /** Closes a broken stream and opens a new one after the backoff. */
  function reopenLater(userId) {
    if (stopped) return;
    const retry = retries.get(userId) ?? { attempt: 0, timer: null };
    if (retry.timer) return;
    const delay = REOPEN_BACKOFF_MS[Math.min(retry.attempt, REOPEN_BACKOFF_MS.length - 1)];
    retry.attempt += 1;
    retry.timer = timers.setTimeout(() => {
      retry.timer = null;
      subscribe(userId);
    }, delay);
    retries.set(userId, retry);
    logger?.debug(`Ses alma akışı ${delay} ms sonra yeniden açılacak (${guildId}/${userId})`);
  }

  function subscribe(userId) {
    if (stopped || subs.has(userId) || isBot(userId) || isExcluded(userId)) return;
    if (retries.get(userId)?.timer) return; // waiting for the backoff
    const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const sub = {
      stream,
      decoder: new OpusEncoder(48000, 2),
      ds: new Downsampler48kStereoTo16kMono(),
      idleTimer: null,
      errors: 0,
      errorsInRow: 0,
      failed: false,
    };
    subs.set(userId, sub);
    stream.on('data', (packet) => {
      if (subs.get(userId) !== sub) return;
      if (sub.idleTimer) {
        timers.clearTimeout(sub.idleTimer);
        sub.idleTimer = null;
      }
      let pcm;
      try {
        pcm = sub.ds.push(sub.decoder.decode(packet));
      } catch {
        sub.errors++; // e.g. a packet DAVE passed through still encrypted
        if (++sub.errorsInRow >= REOPEN_AFTER_ERRORS) {
          drop(userId, { notify: false });
          sink.idle(keyOf(userId));
          reopenLater(userId);
        }
        return;
      }
      sub.errorsInRow = 0;
      if (retries.has(userId) && !retries.get(userId).timer) retries.delete(userId); // healthy again
      if (pcm.length) sink.audio(keyOf(userId), pcm);
    });
    stream.once('error', (error) => {
      sub.failed = true;
      logger?.debug(`Ses alma akışı kapandı (${guildId}/${userId}): ${error?.message}`);
    });
    stream.once('close', () => {
      if (subs.get(userId) !== sub) return;
      subs.delete(userId);
      if (sub.idleTimer) timers.clearTimeout(sub.idleTimer);
      sink.idle(keyOf(userId)); // finish what was said
      if (sub.failed) reopenLater(userId); // e.g. DAVE gave up: not again at once
    });
  }

  const onStart = (userId) => {
    const sub = subs.get(userId);
    if (sub?.idleTimer) {
      timers.clearTimeout(sub.idleTimer);
      sub.idleTimer = null;
    }
    subscribe(userId);
  };
  const onEnd = (userId) => {
    const sub = subs.get(userId);
    if (!sub) return;
    if (sub.idleTimer) timers.clearTimeout(sub.idleTimer);
    sub.idleTimer = timers.setTimeout(() => {
      sub.idleTimer = null;
      if (subs.get(userId) === sub) sink.idle(keyOf(userId));
    }, IDLE_AFTER_MS);
  };
  receiver.speaking.on('start', onStart);
  receiver.speaking.on('end', onEnd);
  for (const userId of humans()) subscribe(userId);

  return {
    guildId,
    /** A person joined the bot's channel (or was let back in): listen to them. */
    add: subscribe,
    /** A person left the channel or excluded themselves: their audio is no longer even decoded. */
    remove: (userId) => {
      clearRetry(userId);
      drop(userId);
    },
    has: (userId) => subs.has(userId),
    get count() {
      return subs.size;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      receiver.speaking.off('start', onStart);
      receiver.speaking.off('end', onEnd);
      for (const userId of [...retries.keys()]) clearRetry(userId);
      for (const userId of [...subs.keys()]) drop(userId, { notify: false });
    },
  };
}
