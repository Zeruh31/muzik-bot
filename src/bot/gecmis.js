// Sunucu başına son çalınan şarkılar (/gecmis ve otomatik çalmanın "tekrar etme" listesi).
// Bellekte ve data/gecmis.json dosyasında sunucu başına en fazla 100 kayıt tutulur.
// Şarkıyı kimin istediği SAKLANMAZ (durum dosyasındaki gizlilik kuralı): yalnız başlık, sanatçı,
// adres, süre ve kaynak. Dosya bozulursa yedeği alınır ve geçmiş boş başlar.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../util/atomicFile.js';

export const HISTORY_LIMIT = 100;

const SNOWFLAKE = /^\d{17,20}$/;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);
const httpUri = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value.slice(0, 500) : null);

/**
 * The stored form of a played track: only what is needed to show it and load it again.
 * Never the requester. Accepts a MusicService track view (or a stored entry).
 * @returns {object|null} null when there is nothing worth keeping (no title)
 */
export function historyEntry(view, playedAt = Date.now()) {
  if (!isPlainObject(view)) return null;
  const title = text(view.title, 200);
  if (!title) return null;
  return {
    title,
    author: text(view.author, 200),
    uri: httpUri(view.uri),
    duration: Number.isSafeInteger(view.duration) && view.duration > 0 ? view.duration : 0,
    isStream: Boolean(view.isStream),
    sourceName: text(view.sourceName, 40),
    // The YouTube video that was really played (Spotify & co.: the mirror). Autoplay uses it.
    videoId: text(view.videoId ?? view.mirror?.videoId ?? (view.sourceName === 'youtube' ? view.identifier : null), 20),
    sourceUri: httpUri(view.sourceUri ?? view.mirror?.uri),
    autoplay: Boolean(view.autoplay),
    playedAt: Number.isSafeInteger(view.playedAt) ? view.playedAt : playedAt,
  };
}

function sanitize(raw) {
  const out = Object.create(null); // keys come from a file: no prototype to reach
  const guilds = isPlainObject(raw?.guilds) ? raw.guilds : {};
  for (const [guildId, list] of Object.entries(guilds)) {
    if (!SNOWFLAKE.test(guildId) || !Array.isArray(list)) continue;
    const entries = list.map((entry) => historyEntry(entry, 0)).filter(Boolean);
    if (entries.length) out[guildId] = entries.slice(0, HISTORY_LIMIT);
  }
  return out;
}

/**
 * Per-guild play history, newest first. Changes are written in batches (`flushDelayMs` after
 * the first change) with an atomic write; close() writes what is pending.
 */
export function createHistoryStore({
  file,
  logger,
  fs = nodeFs,
  flushDelayMs = 3000,
  timers = globalThis,
  now = Date.now,
}) {
  const loaded = file ? readJsonOrBackup(file, null, { fs }) : { data: null, error: null };
  if (loaded.error) {
    logger?.warn(
      `Geçmiş dosyası okunamadı (${loaded.error.message}); geçmiş boş başlıyor.${loaded.backup ? ` Eski dosya: ${loaded.backup}` : ''}`,
    );
  }
  const guilds = sanitize(loaded.data);
  let timer = null;
  let dirty = false;
  let warned = false;

  function schedule() {
    dirty = true;
    if (timer || !file) return;
    timer = timers.setTimeout(() => {
      timer = null;
      flush();
    }, flushDelayMs);
    timer?.unref?.();
  }

  function flush() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (!dirty || !file) return;
    try {
      writeJsonAtomic(file, { schemaVersion: 1, guilds }, { fs });
      dirty = false;
      warned = false;
    } catch (error) {
      if (!warned) logger?.warn('Geçmiş dosyası yazılamadı:', error?.message ?? error);
      warned = true;
    }
  }

  return {
    /**
     * Adds a played track. The same track again right after itself (track repeat, a restart)
     * is not added twice. Returns the stored entry, or null when nothing was added.
     */
    record(guildId, view) {
      const entry = historyEntry(view, now());
      if (!entry || !guildId) return null;
      const list = (Object.hasOwn(guilds, guildId) && guilds[guildId]) || [];
      const last = list[0];
      if (last && last.title === entry.title && last.uri === entry.uri) return null;
      guilds[guildId] = [entry, ...list].slice(0, HISTORY_LIMIT);
      schedule();
      return entry;
    },
    /** Newest first; at most `limit` entries (copies). */
    list(guildId, limit = HISTORY_LIMIT) {
      return ((Object.hasOwn(guilds, guildId) && guilds[guildId]) || []).slice(0, limit).map((entry) => ({ ...entry }));
    },
    flush,
    close() {
      flush();
    },
  };
}
