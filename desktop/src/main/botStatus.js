'use strict';

// Reads the bot's data/durum.json (written by src/bot/durumDosyasi.js) and turns it into a
// strictly shaped object for the window. Everything is copied field by field with type,
// length and URL checks: the file is written by another program, and server names or song
// titles are user data.

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_SCHEMA = 1;
const STALE_AFTER_MS = 60_000;
const MAX_SERVERS = 2000;
const HISTORY_LIMIT = 360; // ~90 min at one sample per 15 s

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const bool = (v) => v === true;
const snowflake = (v) => (typeof v === 'string' && /^\d{17,20}$/.test(v) ? v : null);

function time(v) {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** Only images from Discord's CDN may be shown (the window's CSP allows nothing else). */
function cdnUrl(v) {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && url.hostname === 'cdn.discordapp.com' && !url.username ? url.href : null;
  } catch {
    return null;
  }
}

/** Song links are only kept when they are plain http(s) addresses. */
function webUrl(v) {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const url = new URL(v);
    return ['https:', 'http:'].includes(url.protocol) && !url.username ? url.href : null;
  } catch {
    return null;
  }
}

function counters(raw) {
  const c = isObject(raw) ? raw : {};
  const commands = Object.entries(isObject(c.commands) ? c.commands : {})
    .filter(([name]) => /^[\w-]{1,32}$/.test(name))
    .map(([name, count]) => ({ name, count: num(count) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 100);
  const topSongs = (Array.isArray(c.topSongs) ? c.topSongs : [])
    .filter(isObject)
    .slice(0, 10)
    .map((s) => ({ title: str(s.title) ?? '?', uri: webUrl(s.uri), count: num(s.count) }));
  return { songsPlayed: num(c.songsPlayed), commandsUsed: num(c.commandsUsed), commands, topSongs };
}

function server(raw) {
  if (!isObject(raw) || !snowflake(raw.id)) return null;
  const voice = isObject(raw.voice)
    ? { channelName: str(raw.voice.channelName, 100), listeners: num(raw.voice.listeners) }
    : null;
  const p = isObject(raw.playing) ? raw.playing : null;
  const playing = p
    ? {
        title: str(p.title) ?? '?',
        author: str(p.author) ?? '',
        uri: webUrl(p.uri),
        positionMs: num(p.positionMs),
        durationMs: num(p.durationMs),
        isStream: bool(p.isStream),
        paused: bool(p.paused),
      }
    : null;
  return {
    id: raw.id,
    name: str(raw.name, 100) ?? '(adsız sunucu)',
    iconUrl: cdnUrl(raw.iconUrl),
    memberCount: num(raw.memberCount),
    joinedAt: time(raw.joinedAt),
    djRole: bool(raw.djRole),
    voice,
    playing,
    queueLength: num(raw.queueLength),
    repeatMode: ['off', 'track', 'queue'].includes(raw.repeatMode) ? raw.repeatMode : 'off',
    volume: numOrNull(raw.volume),
    songsPlayed: num(raw.songsPlayed),
  };
}

/**
 * Validates and normalises the parsed JSON. Returns null when it is not a status file this
 * app understands.
 */
function normalizeStatus(raw) {
  if (!isObject(raw) || raw.schemaVersion !== SUPPORTED_SCHEMA) return null;
  const updatedAt = time(raw.updatedAt);
  if (updatedAt === null) return null;
  const bot = isObject(raw.bot) ? raw.bot : {};
  const memory = isObject(bot.memory) ? bot.memory : {};
  const versions = isObject(bot.versions) ? bot.versions : {};
  const lavalink = isObject(raw.lavalink) ? raw.lavalink : {};
  const sayaclar = isObject(raw.sayaclar) ? raw.sayaclar : {};
  const servers = (Array.isArray(raw.sunucular) ? raw.sunucular : []).slice(0, MAX_SERVERS).map(server).filter(Boolean);
  return {
    updatedAt,
    running: bool(raw.running),
    pid: Number.isSafeInteger(raw.pid) && raw.pid > 0 ? raw.pid : null,
    bot: {
      username: str(bot.username, 100),
      id: snowflake(bot.id),
      avatarUrl: cdnUrl(bot.avatarUrl),
      startedAt: time(bot.startedAt),
      uptimeMs: num(bot.uptimeMs),
      pingMs: numOrNull(bot.pingMs),
      guildCount: num(bot.guildCount),
      memberCount: num(bot.memberCount),
      memory: { rss: num(memory.rss), heapUsed: num(memory.heapUsed) },
      versions: { node: str(versions.node, 30), discordJs: str(versions.discordJs, 30) },
    },
    lavalink: {
      connected: bool(lavalink.connected),
      version: str(lavalink.version, 30),
      players: num(lavalink.players),
      playingPlayers: num(lavalink.playingPlayers),
      uptimeMs: num(lavalink.uptimeMs),
      cpuLoad: Math.min(num(lavalink.cpuLoad), 1),
      memoryUsed: num(lavalink.memoryUsed),
    },
    counters: { total: counters(sayaclar.toplam), session: counters(sayaclar.oturum) },
    servers,
    playingCount: servers.filter((s) => s.playing && !s.playing.paused).length,
  };
}

/**
 * True when the data is not live: no file, the bot said it stopped, no update for 60 s,
 * its process is gone (killed bots cannot write "running": false), or it is a bot process
 * this app itself saw exit (`stoppedPids`, covers a reused PID).
 */
function isStale(status, now = Date.now(), { maxAgeMs = STALE_AFTER_MS, isAlive = null, stoppedPids = null } = {}) {
  if (!status || !status.running || now - status.updatedAt > maxAgeMs) return true;
  if (status.pid && stoppedPids?.has(status.pid)) return true;
  if (status.pid && isAlive && !isAlive(status.pid)) return true;
  return false;
}

/** Adds one chart sample per new file update while the bot runs. */
function addSample(history, status, limit = HISTORY_LIMIT) {
  if (!status || !status.running || history.at(-1)?.t === status.updatedAt) return history;
  history.push({
    t: status.updatedAt,
    pingMs: status.bot.pingMs,
    rssMb: Math.round(status.bot.memory.rss / 1048576),
    activePlayers: status.lavalink.playingPlayers,
  });
  if (history.length > limit) history.splice(0, history.length - limit);
  return history;
}

/**
 * Watches <project>/data/durum.json: fs.watch on the folder for quick updates plus polling
 * as a fallback (fs.watch can miss renames or the folder may not exist yet).
 */
function createStatusWatcher({
  getProjectDir,
  onChange,
  pollMs = 5000,
  fsImpl = fs,
  isAlive = null,
  stoppedPids = null,
}) {
  let watcher = null;
  let watchedDir = null;
  let poll = null;
  let lastKey = null;
  let current = null;
  const history = [];

  const file = () => {
    const dir = getProjectDir();
    return dir ? path.join(dir, 'data', 'durum.json') : null;
  };

  function read() {
    const target = file();
    let next = null;
    let key = 'yok';
    let stat = null;
    try {
      stat = target ? fsImpl.statSync(target) : null;
    } catch {
      stat = null;
    }
    if (!stat && current) {
      // No file right now (being replaced, locked, cleaned up): keep the last good data;
      // isStale() tells the window it is no longer live.
      return;
    }
    if (stat) {
      key = `${target}|${stat.mtimeMs}|${stat.size}`;
      if (key === lastKey) return;
      try {
        next = normalizeStatus(JSON.parse(fsImpl.readFileSync(target, 'utf8')));
      } catch {
        return; // unreadable right now (being replaced): the next event or poll tries again
      }
    }
    if (key === lastKey) return;
    lastKey = key;
    current = next;
    addSample(history, current);
    onChange?.(snapshot());
  }

  function watchFolder() {
    const target = file();
    const dir = target ? path.dirname(target) : null;
    if (dir === watchedDir && watcher) return;
    watcher?.close();
    watcher = null;
    watchedDir = dir;
    if (!dir) return;
    try {
      watcher = fsImpl.watch(dir, (_event, name) => {
        if (!name || name === 'durum.json') read();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null; // folder missing: polling covers it until the bot creates it
    }
  }

  function snapshot(now = Date.now()) {
    return { status: current, stale: isStale(current, now, { isAlive, stoppedPids }), history: [...history] };
  }

  return {
    start() {
      read();
      watchFolder();
      poll = setInterval(() => {
        watchFolder();
        read();
      }, pollMs);
      poll.unref?.();
    },
    /** Project folder changed: forget the old data and look again. */
    refresh() {
      lastKey = null;
      history.length = 0;
      watchFolder();
      read();
    },
    stop() {
      clearInterval(poll);
      watcher?.close();
    },
    snapshot,
  };
}

module.exports = { normalizeStatus, isStale, addSample, createStatusWatcher, cdnUrl, STALE_AFTER_MS };
