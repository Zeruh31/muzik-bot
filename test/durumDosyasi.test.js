import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Events } from 'discord.js';
import {
  attachStatusFile,
  buildStatus,
  createPlayCounter,
  createStatusWriter,
  STATUS_SCHEMA_VERSION,
} from '../src/bot/durumDosyasi.js';
import { createStatsStore } from '../src/bot/istatistik.js';
import { readJsonOrBackup, writeJsonAtomic } from '../src/util/atomicFile.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** Manual timers: run them by advancing a fake clock. */
function fakeTimers() {
  let clock = 1_000_000;
  let id = 0;
  const pending = new Map();
  const api = {
    now: () => clock,
    setTimeout(fn, ms) {
      id += 1;
      pending.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    setInterval(fn, ms) {
      id += 1;
      const handle = id;
      const tick = () => {
        pending.set(handle, { fn: () => (fn(), tick()), at: clock + ms });
      };
      tick();
      return handle;
    },
    clearInterval(handle) {
      pending.delete(handle);
    },
    advance(ms) {
      const end = clock + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        clock = next[1].at;
        next[1].fn();
      }
      clock = end;
    },
  };
  return api;
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'durum-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('status file writer timing', () => {
  it('writes on start, every interval, at most once per minGap after poke, and running=false on stop', () => {
    const timers = fakeTimers();
    const writes = [];
    const writer = createStatusWriter({
      file: join(dir, 'durum.json'),
      collect: ({ running, now }) => {
        writes.push({ running, at: now });
        return { running };
      },
      timers,
      now: timers.now,
      intervalMs: 15_000,
      minGapMs: 2000,
    });
    writer.poke(); // not started: ignored
    assert.equal(writes.length, 0);
    writer.start();
    assert.equal(writes.length, 1);

    // Burst of events right after a write: one write, 2 s after the previous one.
    writer.poke();
    writer.poke();
    writer.poke();
    timers.advance(1999);
    assert.equal(writes.length, 1);
    timers.advance(1);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].at - writes[0].at, 2000);

    // Long after the last write: written immediately (next tick).
    timers.advance(5000);
    writer.poke();
    timers.advance(0);
    assert.equal(writes.length, 3);

    // Periodic writes.
    timers.advance(15_000);
    assert.ok(writes.length >= 4);

    writer.stop();
    assert.equal(writes.at(-1).running, false);
    const count = writes.length;
    timers.advance(60_000);
    assert.equal(writes.length, count, 'no writes after stop');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'durum.json'), 'utf8')), { running: false });
  });

  it('stop() without start() does not write (bot never logged in)', () => {
    const writer = createStatusWriter({ file: join(dir, 'durum.json'), collect: () => ({}), timers: fakeTimers() });
    writer.stop();
    assert.deepEqual(readdirSync(dir), []);
  });

  it('write errors are logged once and never thrown', () => {
    const warnings = [];
    const broken = {
      ...fs,
      writeFileSync: () => {
        throw Object.assign(new Error('disk dolu'), { code: 'ENOSPC' });
      },
    };
    const timers = fakeTimers();
    const writer = createStatusWriter({
      file: join(dir, 'durum.json'),
      collect: () => ({}),
      fs: broken,
      timers,
      now: timers.now,
      logger: { ...silent, warn: (...args) => warnings.push(args.join(' ')) },
    });
    writer.start();
    timers.advance(60_000);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /disk dolu/);
  });
});

describe('atomic JSON files', () => {
  it('writes through a temporary file and retries a locked rename', () => {
    const file = join(dir, 'x.json');
    let renames = 0;
    const flaky = {
      ...fs,
      renameSync: (from, to) => {
        renames += 1;
        if (renames < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        fs.renameSync(from, to);
      },
    };
    writeJsonAtomic(file, { a: 1 }, { fs: flaky });
    assert.equal(renames, 3);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 });
    assert.deepEqual(readdirSync(dir), ['x.json'], 'no temporary file left');

    const failing = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOSPC' });
      },
    };
    assert.throws(() => writeJsonAtomic(file, { a: 2 }, { fs: failing }), /nope/);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 }, 'old file intact');
    assert.deepEqual(readdirSync(dir), ['x.json']);
  });

  it('a corrupt file is backed up and the fallback is used', () => {
    const file = join(dir, 'x.json');
    writeFileSync(file, '{ yarım');
    const result = readJsonOrBackup(file, { empty: true }, { now: () => 42 });
    assert.deepEqual(result.data, { empty: true });
    assert.equal(result.backup, `${file}.bozuk-42`);
    assert.deepEqual(readdirSync(dir), ['x.json.bozuk-42']);
  });
});

describe('persistent counters (data/istatistik.json)', () => {
  it('counts songs and commands, survives a restart, keeps session counts apart', () => {
    const file = join(dir, 'istatistik.json');
    const timers = fakeTimers();
    const first = createStatsStore({ file, logger: silent, timers, flushDelayMs: 5000 });
    const song = { title: 'Şarkı A', author: 'X', uri: 'https://youtu.be/a' };
    first.recordSong('111111111111111111', song);
    first.recordSong('111111111111111111', song);
    first.recordSong('222222222222222222', { title: 'Şarkı B', author: 'Y', uri: 'https://youtu.be/b' });
    first.recordCommand('play');
    first.recordCommand('play');
    first.recordCommand('skip');
    assert.deepEqual(readdirSync(dir), [], 'batched: nothing written yet');
    timers.advance(5000);
    assert.deepEqual(readdirSync(dir), ['istatistik.json']);

    const second = createStatsStore({ file, logger: silent, timers });
    second.recordSong('111111111111111111', song);
    const { toplam, oturum } = second.snapshot();
    assert.equal(toplam.songsPlayed, 4);
    assert.equal(toplam.commandsUsed, 3);
    assert.deepEqual(toplam.commands, { play: 2, skip: 1 });
    assert.deepEqual(toplam.topSongs[0], { title: 'Şarkı A', uri: 'https://youtu.be/a', count: 3 });
    assert.deepEqual(toplam.songsByGuild, { '111111111111111111': 3, '222222222222222222': 1 });
    assert.equal(oturum.songsPlayed, 1, 'session starts at zero');
    assert.equal(oturum.commandsUsed, 0);
    second.close();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).songsPlayed, 4, 'close() flushes');
  });

  it('a corrupt counter file is backed up and counting starts again', () => {
    const file = join(dir, 'istatistik.json');
    writeFileSync(file, 'bozuk{');
    const warnings = [];
    const store = createStatsStore({
      file,
      logger: { ...silent, warn: (m) => warnings.push(m) },
      timers: fakeTimers(),
    });
    assert.equal(store.snapshot().toplam.songsPlayed, 0);
    assert.match(warnings[0], /sıfırdan başlıyor/);
    assert.ok(readdirSync(dir).some((name) => name.startsWith('istatistik.json.bozuk-')));
  });

  it('wrong field types are ignored, not trusted', () => {
    const file = join(dir, 'istatistik.json');
    writeFileSync(
      file,
      JSON.stringify({ songsPlayed: -5, commandsUsed: 'çok', commands: { play: 3, 'a b': 1 }, songs: [] }),
    );
    const { toplam } = createStatsStore({ file, logger: silent, timers: fakeTimers() }).snapshot();
    assert.equal(toplam.songsPlayed, 0);
    assert.equal(toplam.commandsUsed, 0);
    assert.deepEqual(toplam.commands, { play: 3 });
  });
});

// ---- the status object ---------------------------------------------------------------------

// Fake token, joined at runtime so secret scanners do not flag the test file.
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');

function fakeContext() {
  const voiceStates = new Map([
    [
      '900000000000000001',
      { id: '900000000000000001', channelId: '500000000000000001', member: { user: { bot: true } } },
    ],
    [
      '800000000000000001',
      { id: '800000000000000001', channelId: '500000000000000001', member: { user: { bot: false } } },
    ],
    ['800000000000000002', { id: '800000000000000002', channelId: '500000000000000001', member: null }],
    [
      '800000000000000003',
      { id: '800000000000000003', channelId: '500000000000000099', member: { user: { bot: false } } },
    ],
  ]);
  const guildA = {
    id: '111111111111111111',
    name: '<img src=x onerror=alert(1)> Sunucu',
    memberCount: 42,
    joinedTimestamp: Date.UTC(2026, 0, 2),
    iconURL: () => 'https://cdn.discordapp.com/icons/111111111111111111/abc.png?size=128',
    members: { me: { voice: { channelId: '500000000000000001' } } },
    channels: { cache: new Map([['500000000000000001', { name: 'Müzik' }]]) },
    voiceStates: { cache: voiceStates },
  };
  const guildB = {
    id: '222222222222222222',
    name: 'Boş sunucu',
    memberCount: 7,
    joinedTimestamp: Date.UTC(2026, 5, 1),
    iconURL: () => null,
    members: { me: { voice: { channelId: null } } },
    channels: { cache: new Map() },
    voiceStates: { cache: new Map() },
  };
  const client = Object.assign(new EventEmitter(), {
    token: TOKEN,
    user: {
      tag: 'Müzik#1234',
      id: '900000000000000001',
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/9/a.png',
    },
    ws: { ping: 87 },
    guilds: {
      cache: new Map([
        [guildA.id, guildA],
        [guildB.id, guildB],
      ]),
    },
  });
  const music = Object.assign(new EventEmitter(), {
    nodeStats: () => ({
      version: '4.2.2',
      players: 1,
      playingPlayers: 1,
      uptime: 5000,
      memoryUsed: 1e8,
      cpuLoad: 0.05,
      plugins: [],
    }),
    getState: (guildId) =>
      guildId === guildA.id
        ? {
            voiceChannelId: '500000000000000001',
            position: 30_000,
            paused: false,
            volume: 80,
            repeatMode: 'queue',
            current: {
              title: 'Şarkı A',
              author: 'X',
              uri: 'https://youtu.be/a',
              duration: 200_000,
              isStream: false,
              requester: { id: '800000000000000001', username: 'gizli-kullanici' },
            },
            queue: [{}, {}, {}],
          }
        : null,
  });
  return {
    client,
    music,
    commands: new Map([['play', {}]]),
    settings: { getDjRole: (id) => (id === guildA.id ? '333333333333333333' : null) },
    config: {
      discord: { token: TOKEN },
      panel: { clientSecret: 'cok-gizli-panel-secret', sessionSecret: 'oturum-anahtari-1234567890' },
    },
    stats: createStatsStore({ file: join(dir, 'istatistik.json'), logger: silent, timers: fakeTimers() }),
    startedAt: Date.now() - 60_000,
    logger: silent,
  };
}

describe('data/durum.json content', () => {
  it('has the documented shape', () => {
    const context = fakeContext();
    context.stats.recordSong('111111111111111111', { title: 'Şarkı A', uri: 'https://youtu.be/a' });
    const status = buildStatus(context, { now: Date.UTC(2026, 10, 10) });
    assert.equal(status.schemaVersion, STATUS_SCHEMA_VERSION);
    assert.equal(status.updatedAt, '2026-11-10T00:00:00.000Z');
    assert.equal(status.running, true);
    assert.deepEqual(Object.keys(status.bot).sort(), [
      'avatarUrl',
      'guildCount',
      'id',
      'memberCount',
      'memory',
      'pingMs',
      'startedAt',
      'uptimeMs',
      'username',
      'versions',
    ]);
    assert.equal(status.bot.guildCount, 2);
    assert.equal(status.bot.memberCount, 49);
    assert.equal(status.bot.pingMs, 87);
    assert.equal(status.lavalink.connected, true);
    assert.equal(status.lavalink.playingPlayers, 1);
    assert.equal(status.sayaclar.toplam.songsPlayed, 1);
    assert.equal(status.sayaclar.oturum.songsPlayed, 1);

    const [a, b] = status.sunucular;
    assert.equal(
      a.name,
      '<img src=x onerror=alert(1)> Sunucu',
      'stored as plain text; the app shows it with textContent',
    );
    assert.equal(a.djRole, true);
    assert.deepEqual(a.voice, { channelName: 'Müzik', listeners: 2 }, 'bots and other channels are not counted');
    assert.deepEqual(a.playing, {
      title: 'Şarkı A',
      author: 'X',
      uri: 'https://youtu.be/a',
      positionMs: 30_000,
      durationMs: 200_000,
      isStream: false,
      paused: false,
    });
    assert.equal(a.queueLength, 3);
    assert.equal(a.repeatMode, 'queue');
    assert.equal(a.songsPlayed, 1);
    assert.equal(b.voice, null);
    assert.equal(b.playing, null);
    assert.equal(b.iconUrl, null);
    assert.equal(b.joinedAt, '2026-06-01T00:00:00.000Z');
  });

  it('contains no token, secret or requester data', () => {
    const context = fakeContext();
    const text = JSON.stringify(buildStatus(context));
    assert.ok(!text.includes(TOKEN));
    assert.ok(!/[\w-]{23,28}\.[\w-]{6}\.[\w-]{27,}/.test(text), 'nothing shaped like a Discord token');
    assert.ok(!/\b1\/\/[\w-]{20,}|ya29\./.test(text), 'nothing shaped like a Google token');
    for (const secret of [
      'cok-gizli-panel-secret',
      'oturum-anahtari-1234567890',
      'gizli-kullanici',
      '800000000000000001',
    ]) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('events count songs and commands and trigger a write', async () => {
    const context = fakeContext();
    const file = join(dir, 'durum.json');
    const writer = attachStatusFile(context, { file, minGapMs: 0, minPlayMs: 5 });
    context.client.emit(Events.InteractionCreate, { isChatInputCommand: () => true, commandName: 'play' });
    context.client.emit(Events.InteractionCreate, { isChatInputCommand: () => true, commandName: 'yok' });
    context.music.emit('trackStarted', '111111111111111111', { title: 'Şarkı A', uri: 'https://youtu.be/a' });
    assert.equal(context.stats.snapshot().oturum.songsPlayed, 0, 'not counted the moment it starts');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const counters = context.stats.snapshot().oturum;
    assert.equal(counters.commandsUsed, 1, 'unknown commands are not counted');
    assert.equal(counters.songsPlayed, 1, 'counted once it has played (position 30 s >= 5 ms)');
    writer.start();
    writer.stop();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).running, false);
  });
});

describe('when a song counts as played', () => {
  const G = '111111111111111111';
  const A = { title: 'A', author: 'x', uri: 'https://youtu.be/a' };
  const B = { title: 'B', author: 'y', uri: 'https://youtu.be/b' };

  function setup() {
    const timers = fakeTimers();
    const state = { current: null, position: 0, recovering: false };
    const music = Object.assign(new EventEmitter(), {
      getState: () => (state.current ? { current: state.current, position: state.position } : null),
      isRecovering: () => state.recovering,
    });
    const played = [];
    createPlayCounter({ music, timers, minPlayMs: 10_000, onPlayed: (guildId, track) => played.push(track.title) });
    const start = (track) => {
      state.current = track;
      state.position = 0;
      music.emit('trackStarted', G, track);
    };
    return { timers, state, music, played, start };
  }

  it('counts after 10 s of real playback, once', () => {
    const { timers, state, music, played, start } = setup();
    start(A);
    state.position = 9000;
    timers.advance(9999);
    assert.deepEqual(played, []);
    state.position = 10_000;
    timers.advance(1);
    assert.deepEqual(played, ['A']);
    music.emit('trackEnded', G, A, 'finished');
    assert.deepEqual(played, ['A'], 'finishing later does not count again');
  });

  it('a short song that finishes on its own counts', () => {
    const { music, played, start } = setup();
    start(A);
    music.emit('trackEnded', G, A, 'finished');
    assert.deepEqual(played, ['A']);
  });

  it('skipped, stopped or failed before 10 s does not count', () => {
    const { timers, music, played, start } = setup();
    start(A);
    music.emit('trackEnded', G, A, 'replaced');
    start(B);
    music.emit('trackFailed', G, B, 'yüklenemedi');
    music.emit('trackEnded', G, B, 'loadfailed');
    start(A);
    music.emit('trackRetried', G, A, 'yaş sınırı', B);
    start(B);
    music.emit('playerDestroyed', G, 'Durduruldu');
    timers.advance(60_000);
    assert.deepEqual(played, []);
  });

  it('a Lavalink recovery restarting the same song does not count it again', () => {
    const { timers, state, music, played, start } = setup();
    start(A);
    state.position = 20_000;
    timers.advance(10_000);
    assert.deepEqual(played, ['A']);
    state.recovering = true;
    music.emit('trackStarted', G, A); // updatePlayer with the same track during recovery
    state.recovering = false;
    timers.advance(60_000);
    assert.deepEqual(played, ['A']);
  });

  it('a paused song is counted only once it has really played 10 s', () => {
    const { timers, state, played, start } = setup();
    start(A);
    state.position = 3000; // paused at 0:03
    timers.advance(10_000);
    assert.deepEqual(played, []);
    timers.advance(7000);
    assert.deepEqual(played, [], 'still paused');
    state.position = 10_000;
    timers.advance(7000);
    assert.deepEqual(played, ['A']);
  });
});
