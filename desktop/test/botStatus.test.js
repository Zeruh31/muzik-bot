'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeStatus, isStale, addSample, createStatusWatcher, cdnUrl } = require('../src/main/botStatus');
const { filterServers, sortServers, initials } = require('../src/renderer/serverList');

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

function sample(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: new Date(NOW).toISOString(),
    running: true,
    pid: 1234,
    bot: {
      username: 'Müzik#1234',
      id: '900000000000000001',
      avatarUrl: 'https://cdn.discordapp.com/avatars/9/a.png',
      startedAt: new Date(NOW - 3600_000).toISOString(),
      uptimeMs: 3600_000,
      pingMs: 87,
      guildCount: 2,
      memberCount: 49,
      memory: { rss: 120 * 1048576, heapUsed: 50 * 1048576, heapTotal: 80 * 1048576 },
      versions: { node: 'v24.16.0', discordJs: '14.28.1' },
    },
    lavalink: {
      connected: true,
      version: '4.2.2',
      players: 1,
      playingPlayers: 1,
      uptimeMs: 5000,
      cpuLoad: 0.05,
      memoryUsed: 1e8,
    },
    sayaclar: {
      toplam: {
        songsPlayed: 10,
        commandsUsed: 5,
        commands: { play: 4, skip: 1 },
        topSongs: [{ title: 'A', uri: 'https://youtu.be/a', count: 3 }],
        songsByGuild: {},
      },
      oturum: { songsPlayed: 1, commandsUsed: 1, commands: { play: 1 }, topSongs: [], songsByGuild: {} },
    },
    sunucular: [
      {
        id: '111111111111111111',
        name: '<img src=x onerror=alert(1)>',
        iconUrl: 'https://cdn.discordapp.com/icons/1/a.png?size=128',
        memberCount: 42,
        joinedAt: '2026-01-02T00:00:00.000Z',
        djRole: true,
        voice: { channelName: 'Müzik', listeners: 2 },
        playing: {
          title: 'A',
          author: 'X',
          uri: 'https://youtu.be/a',
          positionMs: 1000,
          durationMs: 2000,
          isStream: false,
          paused: false,
        },
        queueLength: 3,
        repeatMode: 'queue',
        volume: 80,
        songsPlayed: 3,
      },
      {
        id: '222222222222222222',
        name: 'Boş',
        iconUrl: null,
        memberCount: 7,
        joinedAt: null,
        djRole: false,
        voice: null,
        playing: null,
        queueLength: 0,
        repeatMode: 'off',
        volume: null,
        songsPlayed: 0,
      },
    ],
    ...overrides,
  };
}

test('a valid status file is normalised field by field', () => {
  const status = normalizeStatus(sample());
  assert.equal(status.updatedAt, NOW);
  assert.equal(status.bot.username, 'Müzik#1234');
  assert.equal(status.bot.memory.rss, 120 * 1048576);
  assert.equal(status.lavalink.cpuLoad, 0.05);
  assert.deepEqual(status.counters.total.commands, [
    { name: 'play', count: 4 },
    { name: 'skip', count: 1 },
  ]);
  assert.equal(status.servers.length, 2);
  assert.equal(status.servers[0].name, '<img src=x onerror=alert(1)>', 'kept as text; shown with textContent');
  assert.equal(status.servers[0].joinedAt, Date.UTC(2026, 0, 2));
  assert.equal(status.playingCount, 1);
});

test('wrong types, foreign URLs and junk are dropped', () => {
  const raw = sample();
  raw.bot.avatarUrl = 'https://evil.example.com/a.png';
  raw.bot.pingMs = 'çok';
  raw.lavalink.cpuLoad = 7;
  raw.sunucular.push({ id: 'not-an-id', name: 'x' }, 'junk', null);
  raw.sunucular[0].iconUrl = 'javascript:alert(1)';
  raw.sunucular[0].playing.uri = 'file:///C:/Windows/System32/calc.exe';
  raw.sunucular[0].repeatMode = 'forever';
  raw.sunucular[0].name = 'x'.repeat(500);
  raw.sayaclar.toplam.commands = { 'bad name!': 3, play: -1 };
  const status = normalizeStatus(raw);
  assert.equal(status.bot.avatarUrl, null);
  assert.equal(status.bot.pingMs, null);
  assert.equal(status.lavalink.cpuLoad, 1);
  assert.equal(status.servers.length, 2);
  assert.equal(status.servers[0].iconUrl, null);
  assert.equal(status.servers[0].playing.uri, null);
  assert.equal(status.servers[0].repeatMode, 'off');
  assert.equal(status.servers[0].name.length, 100);
  assert.deepEqual(status.counters.total.commands, [{ name: 'play', count: 0 }]);
  assert.equal(cdnUrl('https://cdn.discordapp.com.evil.com/x.png'), null);
  assert.equal(cdnUrl('http://cdn.discordapp.com/x.png'), null);
});

test('unknown schema or missing timestamps are rejected', () => {
  assert.equal(normalizeStatus(sample({ schemaVersion: 2 })), null);
  assert.equal(normalizeStatus(sample({ updatedAt: 'dün' })), null);
  assert.equal(normalizeStatus([]), null);
  assert.equal(normalizeStatus(null), null);
});

test('stale detection: missing, stopped, or older than 60 s', () => {
  const live = normalizeStatus(sample());
  assert.equal(isStale(live, NOW + 59_000), false);
  assert.equal(isStale(live, NOW + 61_000), true);
  assert.equal(isStale(normalizeStatus(sample({ running: false })), NOW), true);
  assert.equal(isStale(null, NOW), true);
});

test('stale at once when the bot process is gone or the app saw it exit', () => {
  const live = normalizeStatus(sample());
  assert.equal(live.pid, 1234);
  assert.equal(isStale(live, NOW, { isAlive: () => true }), false);
  assert.equal(isStale(live, NOW, { isAlive: () => false }), true, 'killed bot: no 60 s wait');
  assert.equal(isStale(live, NOW, { isAlive: () => true, stoppedPids: new Set([1234]) }), true, 'reused PID');
  assert.equal(normalizeStatus(sample({ pid: 'x' })).pid, null);
  assert.equal(isStale(normalizeStatus(sample({ pid: undefined })), NOW, { isAlive: () => false }), false);
});

test('chart samples: one per update while running, capped', () => {
  const history = [];
  const a = normalizeStatus(sample());
  addSample(history, a);
  addSample(history, a); // same update: ignored
  addSample(history, normalizeStatus(sample({ running: false, updatedAt: new Date(NOW + 1000).toISOString() })));
  assert.deepEqual(history, [{ t: NOW, pingMs: 87, rssMb: 120, activePlayers: 1 }]);
  for (let i = 1; i <= 5; i += 1)
    addSample(history, normalizeStatus(sample({ updatedAt: new Date(NOW + i * 15_000).toISOString() })), 3);
  assert.equal(history.length, 3);
});

test('search and sort', () => {
  const servers = [
    { name: 'İstanbul Müzik', memberCount: 10, joinedAt: 3, songsPlayed: 1 },
    { name: 'ankara', memberCount: 50, joinedAt: 1, songsPlayed: 9 },
    { name: 'Çay Ocağı', memberCount: 10, joinedAt: null, songsPlayed: 5 },
  ];
  assert.deepEqual(
    filterServers(servers, 'istanbul').map((s) => s.name),
    ['İstanbul Müzik'],
    'Turkish İ/i',
  );
  assert.deepEqual(filterServers(servers, ' ').length, 3);
  assert.deepEqual(
    sortServers(servers, 'name').map((s) => s.name),
    ['ankara', 'Çay Ocağı', 'İstanbul Müzik'],
  );
  assert.deepEqual(
    sortServers(servers, 'members').map((s) => s.name),
    ['ankara', 'Çay Ocağı', 'İstanbul Müzik'],
  );
  assert.deepEqual(
    sortServers(servers, 'joined').map((s) => s.name),
    ['İstanbul Müzik', 'ankara', 'Çay Ocağı'],
  );
  assert.deepEqual(
    sortServers(servers, 'songs').map((s) => s.name),
    ['ankara', 'Çay Ocağı', 'İstanbul Müzik'],
  );
  assert.equal(sortServers(servers, 'bogus')[0].name, 'ankara');
  assert.equal(initials('Müzik Kulübü'), 'MK');
  assert.equal(initials('ışık'), 'I');
  assert.equal(initials('🎵 !!'), '?');
});

test('watcher reads the file, ignores repeats and reports a missing file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-status-'));
  const changes = [];
  const watcher = createStatusWatcher({ getProjectDir: () => dir, onChange: (s) => changes.push(s), pollMs: 50 });
  try {
    watcher.start();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, null);
    assert.equal(changes[0].stale, true);

    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(
      path.join(dir, 'data', 'durum.json'),
      JSON.stringify(sample({ updatedAt: new Date().toISOString() })),
    );
    for (let i = 0; i < 40 && changes.length < 2; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.equal(changes.length, 2);
    assert.equal(changes[1].status.servers.length, 2);
    assert.equal(changes[1].stale, false);

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(changes.length, 2, 'unchanged file is not re-sent');

    fs.writeFileSync(path.join(dir, 'data', 'durum.json'), '{ yarım');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(changes.length, 2, 'a half-written file keeps the last good data');

    fs.rmSync(path.join(dir, 'data', 'durum.json'));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(changes.length, 2, 'a missing file (being replaced) keeps the last good data');
    assert.equal(watcher.snapshot().status.servers.length, 2);
  } finally {
    watcher.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
