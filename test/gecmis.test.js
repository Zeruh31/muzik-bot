// Play history (/gecmis): the last 100 per server in memory and in data/gecmis.json, never who
// requested a song, no double entry for a repeating track, survives restarts.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createHistoryStore, HISTORY_LIMIT, historyEntry } from '../src/bot/gecmis.js';

const GUILD = '222222222222222222';
const USER = '111111111111111111';

const dir = mkdtempSync(join(tmpdir(), 'muzikbot-gecmis-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const newFile = () => join(dir, `gecmis-${++fileNo}.json`);

/** Manual timers: the batched write happens when the test says so. */
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn) => {
      pending.push(fn);
      return { unref() {} };
    },
    clearTimeout: () => {},
    runAll() {
      while (pending.length) pending.shift()();
    },
  };
}

const view = (n) => ({
  title: `Şarkı ${n}`,
  author: 'Sanatçı',
  uri: `https://www.youtube.com/watch?v=v${String(n).padStart(10, '0')}`,
  duration: 200_000,
  sourceName: 'youtube',
  videoId: `v${String(n).padStart(10, '0')}`,
  requester: { id: USER, username: 'kisi', displayName: 'Kişi', avatarUrl: 'https://cdn.discordapp.com/a.png' },
});

describe('play history', () => {
  it('never stores the requester', () => {
    const entry = historyEntry(view(1), 10);
    assert.deepEqual(Object.keys(entry).sort(), [
      'author',
      'autoplay',
      'duration',
      'isStream',
      'playedAt',
      'sourceName',
      'sourceUri',
      'title',
      'uri',
      'videoId',
    ]);
    const file = newFile();
    const timers = fakeTimers();
    const store = createHistoryStore({ file, timers });
    store.record(GUILD, view(1));
    timers.runAll();
    const raw = readFileSync(file, 'utf8');
    for (const secret of [USER, 'kisi', 'Kişi', 'cdn.discordapp.com']) assert.ok(!raw.includes(secret), secret);
  });

  it('keeps the newest 100 per server, newest first, and survives a restart', () => {
    const file = newFile();
    const timers = fakeTimers();
    const store = createHistoryStore({ file, timers });
    for (let i = 1; i <= HISTORY_LIMIT + 30; i++) store.record(GUILD, view(i));
    store.record('999999999999999999', view(1));
    assert.equal(timers.pending.length, 1, 'writes are batched');
    timers.runAll();
    const list = store.list(GUILD);
    assert.equal(list.length, 100);
    assert.equal(list[0].title, 'Şarkı 130');
    assert.equal(list.at(-1).title, 'Şarkı 31');
    assert.equal(store.list(GUILD, 20).length, 20);

    const again = createHistoryStore({ file });
    assert.deepEqual(
      again.list(GUILD).map((e) => e.title),
      list.map((e) => e.title),
    );
    assert.equal(again.list('999999999999999999').length, 1);
  });

  it('does not add a track twice in a row (track repeat), but does after another song', () => {
    const store = createHistoryStore({ file: null });
    assert.ok(store.record(GUILD, view(1)));
    assert.equal(store.record(GUILD, view(1)), null);
    store.record(GUILD, view(2));
    store.record(GUILD, view(1));
    assert.deepEqual(
      store.list(GUILD).map((e) => e.title),
      ['Şarkı 1', 'Şarkı 2', 'Şarkı 1'],
    );
  });

  it('close() writes pending entries; a corrupt file starts an empty history', () => {
    const file = newFile();
    const store = createHistoryStore({ file, timers: fakeTimers() });
    store.record(GUILD, view(7));
    store.close();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).guilds[GUILD][0].title, 'Şarkı 7');

    const broken = newFile();
    writeFileSync(broken, 'çöp');
    const warnings = [];
    const empty = createHistoryStore({ file: broken, logger: { warn: (m) => warnings.push(m) } });
    assert.deepEqual(empty.list(GUILD), []);
    assert.match(warnings[0], /Geçmiş dosyası okunamadı/);
  });
});

describe('JSON stores and reserved keys', () => {
  it('history, settings and counters ignore keys such as "__proto__" and "constructor"', async () => {
    const { createServerSettings } = await import('../src/bot/serverSettings.js');
    const { createStatsStore } = await import('../src/bot/istatistik.js');
    const history = createHistoryStore({ file: null });
    assert.deepEqual(history.list('constructor'), []);
    assert.deepEqual(history.list('__proto__'), []);
    history.record('__proto__', view(1));
    assert.equal(history.list('__proto__').length, 1, 'kept as a plain key');
    assert.equal({}.length, undefined);

    const file = newFile();
    writeFileSync(file, '{"__proto__":{"djRoleId":"444444444444444444","autoplay":false}}');
    const settings = createServerSettings({ file });
    assert.equal(settings.getDjRole('constructor'), null);
    assert.equal(settings.getAutoplay('toString'), true);
    assert.equal(settings.getAutoplay(GUILD), true, 'nothing leaks from the "__proto__" entry');

    const statsFile = newFile();
    writeFileSync(
      statsFile,
      '{"commands":{"constructor":3,"__proto__":5},"songs":{"__proto__":{"title":"x","count":2}}}',
    );
    const stats = createStatsStore({ file: statsFile, timers: fakeTimers() });
    stats.recordCommand('constructor');
    stats.recordSong(GUILD, { title: 't', uri: 'toString' });
    const snapshot = stats.snapshot().toplam;
    assert.equal(snapshot.commands.constructor, 4);
    assert.equal(snapshot.topSongs.find((s) => s.uri === 'toString').count, 1);
  });
});
