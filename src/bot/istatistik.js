// Kalıcı sayaçlar: kaç şarkı çalındı, hangi komut kaç kez kullanıldı, en çok çalınan şarkılar.
// data/istatistik.json dosyasında tutulur; masaüstü uygulaması bunları data/durum.json üzerinden gösterir.
// Kullanıcı bilgisi tutulmaz (kim istedi yok), yalnız şarkı başlığı/adresi ve sayılar.
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../util/atomicFile.js';

const MAX_SONGS = 2000; // distinct songs remembered for the top list
const KEEP_SONGS = 1500; // after pruning
const TOP_SONGS = 10;

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function emptyCounters() {
  return { songsPlayed: 0, commandsUsed: 0, commands: {}, songs: {}, songsByGuild: {} };
}

/** Keeps only well-formed parts of a loaded file; anything odd starts from zero. */
function sanitize(raw) {
  const out = emptyCounters();
  if (!isPlainObject(raw)) return out;
  out.songsPlayed = count(raw.songsPlayed);
  out.commandsUsed = count(raw.commandsUsed);
  for (const [name, n] of Object.entries(isPlainObject(raw.commands) ? raw.commands : {})) {
    if (/^[\w-]{1,32}$/.test(name)) out.commands[name] = count(n);
  }
  for (const [key, song] of Object.entries(isPlainObject(raw.songs) ? raw.songs : {})) {
    if (!isPlainObject(song) || typeof song.title !== 'string') continue;
    out.songs[key] = {
      title: song.title,
      uri: typeof song.uri === 'string' ? song.uri : null,
      count: count(song.count),
    };
  }
  for (const [guildId, n] of Object.entries(isPlainObject(raw.songsByGuild) ? raw.songsByGuild : {})) {
    if (/^\d{17,20}$/.test(guildId)) out.songsByGuild[guildId] = count(n);
  }
  return out;
}

function addSong(counters, guildId, track) {
  counters.songsPlayed += 1;
  if (guildId) counters.songsByGuild[guildId] = (counters.songsByGuild[guildId] ?? 0) + 1;
  const title = String(track?.title ?? '?').slice(0, 200);
  const uri = typeof track?.uri === 'string' ? track.uri.slice(0, 500) : null;
  const key = uri ?? `${title}|${track?.author ?? ''}`;
  const song = counters.songs[key] ?? { title, uri, count: 0 };
  song.count += 1;
  song.title = title;
  counters.songs[key] = song;
  const keys = Object.keys(counters.songs);
  if (keys.length > MAX_SONGS) {
    keys
      .sort((a, b) => counters.songs[a].count - counters.songs[b].count)
      .slice(0, keys.length - KEEP_SONGS)
      .forEach((k) => delete counters.songs[k]);
  }
}

function addCommand(counters, name) {
  counters.commandsUsed += 1;
  counters.commands[name] = (counters.commands[name] ?? 0) + 1;
}

/** JSON view for data/durum.json: top songs instead of the whole song table. */
function view(counters) {
  const topSongs = Object.values(counters.songs)
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'tr'))
    .slice(0, TOP_SONGS)
    .map(({ title, uri, count: n }) => ({ title, uri, count: n }));
  return {
    songsPlayed: counters.songsPlayed,
    commandsUsed: counters.commandsUsed,
    commands: { ...counters.commands },
    topSongs,
    songsByGuild: { ...counters.songsByGuild },
  };
}

/**
 * Counters kept across restarts (data/istatistik.json) and for this run only.
 * Changes are written in batches (`flushDelayMs` after the first change), not on every event.
 * A corrupt file is backed up as "istatistik.json.bozuk-<time>" and counting starts again.
 */
export function createStatsStore({ file, logger, fs = nodeFs, flushDelayMs = 5000, timers = globalThis }) {
  const loaded = readJsonOrBackup(file, null, { fs });
  if (loaded.error) {
    logger?.warn(
      `İstatistik dosyası okunamadı (${loaded.error.message}); sayaçlar sıfırdan başlıyor.${loaded.backup ? ` Eski dosya: ${loaded.backup}` : ''}`,
    );
  }
  const total = sanitize(loaded.data);
  const session = emptyCounters();
  let timer = null;
  let dirty = false;
  let warned = false;

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = timers.setTimeout(() => {
      timer = null;
      flush();
    }, flushDelayMs);
    timer?.unref?.();
  }

  function flush() {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    try {
      writeJsonAtomic(file, { schemaVersion: 1, ...total }, { fs });
      dirty = false;
      warned = false;
    } catch (error) {
      if (!warned) logger?.warn('İstatistik dosyası yazılamadı:', error?.message ?? error);
      warned = true;
    }
  }

  return {
    recordSong(guildId, track) {
      addSong(total, guildId, track);
      addSong(session, guildId, track);
      schedule();
    },
    recordCommand(name) {
      addCommand(total, name);
      addCommand(session, name);
      schedule();
    },
    /** { toplam, oturum } as written into data/durum.json. */
    snapshot() {
      return { toplam: view(total), oturum: view(session) };
    },
    flush,
    close() {
      flush();
    },
  };
}
