// Botun anlık durumunu data/durum.json dosyasına yazar; masaüstü uygulaması "Sunucular" ve
// "İstatistikler" sekmelerini bu dosyadan doldurur. Ağ portu açılmaz, yalnız yerel bir dosya.
// İçinde token, şifre ya da kullanıcı bilgisi YOKTUR: sunucu/kanal adları, sayılar, parça bilgisi.
// Şema README > "Durum dosyası" ve test/contract.test.js içinde. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { Events, version as discordJsVersion } from 'discord.js';
import { writeJsonAtomic } from '../util/atomicFile.js';

export const STATUS_SCHEMA_VERSION = 1;

const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const num = (value) => (Number.isFinite(value) ? value : 0);

/** Voice channel the bot sits in and how many people (not bots) are there. */
function voiceView(guild, botId, fallbackChannelId) {
  const channelId = guild.members?.me?.voice?.channelId ?? fallbackChannelId ?? null;
  if (!channelId) return null;
  const channel = guild.channels?.cache?.get(channelId);
  let listeners = 0;
  for (const state of guild.voiceStates?.cache?.values() ?? []) {
    if (state.channelId === channelId && state.id !== botId && !state.member?.user?.bot) listeners += 1;
  }
  return { channelName: channel?.name ?? null, listeners };
}

function guildView(guild, { music, settings, songsByGuild, botId }) {
  const state = music.getState(guild.id);
  const current = state?.current;
  return {
    id: guild.id,
    name: guild.name,
    iconUrl: guild.iconURL?.({ size: 128, extension: 'png' }) ?? null,
    memberCount: num(guild.memberCount),
    joinedAt: iso(guild.joinedTimestamp),
    djRole: Boolean(settings?.getDjRole(guild.id)),
    voice: voiceView(guild, botId, state?.voiceChannelId),
    playing: current
      ? {
          title: current.title,
          author: current.author,
          uri: current.uri,
          positionMs: num(state.position),
          durationMs: num(current.duration),
          isStream: Boolean(current.isStream),
          paused: Boolean(state.paused),
        }
      : null,
    queueLength: state?.queue?.length ?? 0,
    repeatMode: state?.repeatMode ?? 'off',
    volume: state?.volume ?? null,
    songsPlayed: songsByGuild[guild.id] ?? 0,
  };
}

/** { kurulu, isci: 'kapali'|'basliyor'|'hazir'|'hata', cihaz: 'cuda'|'cpu'|null, model, dinlenenSunucu } */
function voiceCommandView(sesliKomut) {
  const state = sesliKomut?.durum?.() ?? null;
  return {
    kurulu: Boolean(state?.kurulu),
    isci: state?.isci ?? 'kapali',
    cihaz: state?.cihaz ?? null,
    model: state?.model ?? null,
    dinlenenSunucu: num(state?.dinlenenSunucu),
  };
}

/**
 * The whole data/durum.json object. Only reads from the context; never includes the token,
 * secrets or who requested a song.
 */
export function buildStatus(context, { running = true, now = Date.now() } = {}) {
  const { client, music, settings, stats, startedAt } = context;
  const guilds = [...(client.guilds?.cache?.values() ?? [])];
  const node = music.nodeStats();
  const memory = process.memoryUsage();
  const counters = stats?.snapshot() ?? { toplam: null, oturum: null };
  const botId = client.user?.id ?? null;
  const ping = client.ws?.ping;

  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    updatedAt: new Date(now).toISOString(),
    running,
    pid: process.pid,
    bot: {
      username: client.user?.tag ?? null,
      id: botId,
      avatarUrl: client.user?.displayAvatarURL?.({ size: 128, extension: 'png' }) ?? null,
      startedAt: iso(startedAt),
      uptimeMs: Math.max(0, now - startedAt),
      pingMs: Number.isFinite(ping) && ping >= 0 ? ping : null,
      guildCount: guilds.length,
      memberCount: guilds.reduce((sum, guild) => sum + num(guild.memberCount), 0),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal },
      versions: { node: process.version, discordJs: discordJsVersion },
    },
    lavalink: {
      connected: Boolean(node),
      version: node?.version ?? null,
      players: node?.players ?? 0,
      playingPlayers: node?.playingPlayers ?? 0,
      uptimeMs: node?.uptime ?? 0,
      cpuLoad: node?.cpuLoad ?? 0,
      memoryUsed: node?.memoryUsed ?? 0,
    },
    sayaclar: counters,
    // Voice commands (added later; the app shows "kurulu değil / hazır / çalışıyor"). No speech, only the state.
    sesliKomut: voiceCommandView(context.sesliKomut),
    sunucular: guilds.map((guild) =>
      guildView(guild, { music, settings, songsByGuild: counters.toplam?.songsByGuild ?? {}, botId }),
    ),
  };
}

/**
 * Writes `collect()` to `file`: right away on start, every `intervalMs`, after poke() at
 * most once per `minGapMs`, and a last time on stop() with running=false.
 * Write errors are logged once and never thrown.
 */
export function createStatusWriter({
  file,
  collect,
  logger,
  fs = nodeFs,
  intervalMs = 15_000,
  minGapMs = 2000,
  timers = globalThis,
  now = Date.now,
}) {
  let started = false;
  let interval = null;
  let pending = null;
  let lastWrite = 0;
  let warned = false;

  function write(running = true) {
    if (pending) timers.clearTimeout(pending);
    pending = null;
    lastWrite = now();
    try {
      writeJsonAtomic(file, collect({ running, now: lastWrite }), { fs });
      warned = false;
    } catch (error) {
      if (!warned) logger?.warn('Durum dosyası yazılamadı:', error?.message ?? error);
      warned = true;
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      write();
      interval = timers.setInterval(() => write(), intervalMs);
      interval?.unref?.();
    },
    /** Something changed (song, server list): write soon, but not more often than minGapMs. */
    poke() {
      if (!started || pending) return;
      const wait = Math.max(0, lastWrite + minGapMs - now());
      pending = timers.setTimeout(() => write(), wait);
      pending?.unref?.();
    },
    /** Final write with running=false. Does nothing if the writer never started. */
    stop() {
      if (!started) return;
      started = false;
      timers.clearInterval(interval);
      interval = null;
      write(false);
    },
    get started() {
      return started;
    },
  };
}

const trackKey = (track) => track?.uri ?? `${track?.title}|${track?.author}`;

/**
 * Decides when a song counts as "played", so restarts and failures are not counted twice:
 *  - not while a Lavalink recovery restarts the same song (music.isRecovering)
 *  - only after it really played `minPlayMs` (position checked, pauses do not count),
 *    or when it finished earlier on its own (Lavalink reason "finished", short songs)
 *  - never when it failed (trackFailed / trackRetried) or was skipped/stopped before that
 */
export function createPlayCounter({ music, onPlayed, minPlayMs = 10_000, timers = globalThis }) {
  const pending = new Map(); // guildId -> { key, track, timer }

  function cancel(guildId) {
    const entry = pending.get(guildId);
    if (entry) timers.clearTimeout(entry.timer);
    pending.delete(guildId);
  }

  function count(guildId, entry) {
    cancel(guildId);
    onPlayed(guildId, entry.track);
  }

  function arm(guildId, entry, wait) {
    entry.timer = timers.setTimeout(() => {
      if (pending.get(guildId) !== entry) return;
      const state = music.getState(guildId);
      if (!state?.current || trackKey(state.current) !== entry.key) {
        cancel(guildId);
      } else if ((state.position ?? 0) >= minPlayMs - 1000) {
        count(guildId, entry);
      } else {
        arm(guildId, entry, Math.max(2000, minPlayMs - (state.position ?? 0))); // paused: look again later
      }
    }, wait);
    entry.timer?.unref?.();
  }

  music.on('trackStarted', (guildId, track) => {
    if (music.isRecovering?.(guildId)) return; // same song resumed after a Lavalink restart
    cancel(guildId);
    const entry = { key: trackKey(track), track, timer: null };
    pending.set(guildId, entry);
    arm(guildId, entry, minPlayMs);
  });
  music.on('trackEnded', (guildId, track, reason) => {
    const entry = pending.get(guildId);
    if (entry && entry.key === trackKey(track) && reason === 'finished') count(guildId, entry);
    else if (entry && entry.key === trackKey(track)) cancel(guildId);
  });
  for (const event of ['trackFailed', 'trackRetried', 'playerDestroyed']) {
    music.on(event, (guildId) => cancel(guildId));
  }
  return { pendingCount: () => pending.size };
}

/**
 * Hooks the counters and the status file into a logged-in bot. Counting starts at once;
 * the status file is written from start() (called on login) until stop() (shutdown).
 */
export function attachStatusFile(context, { file, fs, intervalMs, minGapMs, minPlayMs } = {}) {
  const { client, music, commands, stats } = context;
  const writer = createStatusWriter({
    file,
    fs,
    intervalMs,
    minGapMs,
    logger: context.logger,
    collect: (options) => buildStatus(context, options),
  });

  createPlayCounter({
    music,
    minPlayMs,
    onPlayed: (guildId, track) => {
      stats?.recordSong(guildId, track);
      writer.poke();
    },
  });
  for (const event of ['trackStarted', 'queueEnded', 'playerDestroyed', 'trackFailed'])
    music.on(event, () => writer.poke());
  client.on(Events.GuildCreate, () => writer.poke());
  client.on(Events.GuildDelete, () => writer.poke());
  client.on(Events.InteractionCreate, (interaction) => {
    const command = interaction.isChatInputCommand?.() ? commands?.get(interaction.commandName) : null;
    // "/muzik seek" is counted as "seek", so the counters go on from before the commands moved.
    if (command) stats?.recordCommand(command.statName?.(interaction) ?? interaction.commandName);
  });
  return writer;
}
