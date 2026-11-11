// Saved playlists (/liste): name rules, limits (500 songs, 50 lists), what is stored per song,
// delete rights, autocomplete and the atomic write (a failed write changes nothing).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createPlaylistStore, LIMITS, normalizeName, savedEntry } from '../src/bot/listeler.js';

const GUILD = '222222222222222222';
const OWNER = '111111111111111111';
const OTHER = '333333333333333333';

const dir = mkdtempSync(join(tmpdir(), 'muzikbot-listeler-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const newFile = () => join(dir, `listeler-${++fileNo}.json`);

const view = (n, extra = {}) => ({
  title: `Şarkı ${n}`,
  author: 'Sanatçı',
  uri: `https://www.youtube.com/watch?v=${String(n).padStart(11, '0')}`,
  duration: 180_000,
  requester: { id: OWNER, username: 'gizli' },
  artworkUrl: 'https://i.ytimg.com/x.jpg',
  ...extra,
});
const views = (count) => Array.from({ length: count }, (_, i) => view(i + 1));

describe('playlist store', () => {
  it('validates names and treats case (Turkish rules) and spaces as the same name', () => {
    assert.deepEqual(normalizeName('  Yol   Şarkıları '), { name: 'Yol Şarkıları', key: 'yol şarkıları' });
    assert.equal(normalizeName('IŞIK').key, 'ışık');
    assert.equal(normalizeName('liste_1-a').name, 'liste_1-a');
    for (const bad of ['', '   ', 'a'.repeat(LIMITS.nameLength + 1), 'kötü/ad', '<@123>', 'a.b', '**kalın**']) {
      assert.throws(
        () => normalizeName(bad),
        (e) => e.code === 'INVALID_VALUE' && /harf, rakam/.test(e.message),
        bad,
      );
    }
  });

  it('stores only uri, title, duration (and the YouTube source of a mirrored track), no requester', () => {
    assert.deepEqual(savedEntry(view(1)), {
      uri: 'https://www.youtube.com/watch?v=00000000001',
      title: 'Şarkı 1',
      duration: 180_000,
    });
    const spotify = view(2, {
      uri: 'https://open.spotify.com/track/abc',
      mirror: { videoId: 'x', uri: 'https://www.youtube.com/watch?v=yt', title: 't' },
    });
    assert.deepEqual(Object.keys(savedEntry(spotify)).sort(), ['duration', 'sourceUri', 'title', 'uri']);
    assert.equal(savedEntry(spotify).sourceUri, 'https://www.youtube.com/watch?v=yt');
    assert.equal(savedEntry(view(3, { uri: 'ytsearch:bir şey' })), null, 'only http(s) addresses');
    assert.equal(savedEntry(view(4, { uri: null })), null);

    const file = newFile();
    createPlaylistStore({ file }).create(GUILD, 'Liste', OWNER, [view(1)]);
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes('gizli') && !raw.includes('artworkUrl') && !raw.includes('Sanatçı'));
  });

  it('keeps lists across restarts and shows them sorted', () => {
    const file = newFile();
    const store = createPlaylistStore({ file, now: () => 5 });
    assert.deepEqual(store.create(GUILD, 'Zeybek', OWNER, views(3)), { name: 'Zeybek', saved: 3, dropped: 0 });
    store.create(GUILD, 'akşam', OTHER, views(1));
    const again = createPlaylistStore({ file });
    assert.deepEqual(
      again.list(GUILD).map((l) => [l.name, l.count, l.ownerId]),
      [
        ['akşam', 1, OTHER],
        ['Zeybek', 3, OWNER],
      ],
    );
    assert.equal(again.get(GUILD, 'ZEYBEK').tracks.length, 3);
    assert.throws(
      () => again.get(GUILD, 'yok'),
      (e) => e.code === 'NOT_FOUND',
    );
    assert.throws(() => again.create(GUILD, 'zeybek', OWNER, views(1)), /zaten var/);
  });

  it('a list holds at most 500 songs', () => {
    const store = createPlaylistStore({ file: newFile() });
    const result = store.create(GUILD, 'Büyük', OWNER, views(LIMITS.tracksPerList + 20));
    assert.deepEqual([result.saved, result.dropped], [500, 20]);
    assert.throws(
      () => store.append(GUILD, 'Büyük', OWNER, view(9999)),
      (e) => e.code === 'QUEUE_FULL' && /500/.test(e.message),
    );
    assert.equal(store.get(GUILD, 'Büyük').tracks.length, 500);
  });

  it('a server holds at most 50 lists (also when /liste ekle would create one)', () => {
    const store = createPlaylistStore({ file: newFile() });
    for (let i = 0; i < LIMITS.listsPerGuild; i++) store.create(GUILD, `liste ${i}`, OWNER, [view(i)]);
    assert.throws(
      () => store.create(GUILD, 'bir fazla', OWNER, [view(1)]),
      (e) => /en fazla 50/.test(e.message),
    );
    assert.throws(
      () => store.append(GUILD, 'bir fazla', OWNER, view(1)),
      (e) => /en fazla 50/.test(e.message),
    );
    assert.equal(store.list(GUILD).length, 50);
    assert.equal(store.list('999999999999999999').length, 0, 'other servers are separate');
  });

  it('/liste ekle creates a missing list, appends, refuses duplicates', () => {
    const store = createPlaylistStore({ file: newFile() });
    assert.deepEqual(store.append(GUILD, 'Yeni', OTHER, view(1)), { name: 'Yeni', count: 1, created: true });
    assert.deepEqual(store.append(GUILD, 'yeni', OWNER, view(2)), { name: 'Yeni', count: 2, created: false });
    assert.equal(store.get(GUILD, 'Yeni').ownerId, OTHER, 'the creator stays the owner');
    assert.throws(() => store.append(GUILD, 'Yeni', OWNER, view(2)), /zaten/);
    assert.throws(
      () => store.create(GUILD, 'Boş', OWNER, []),
      (e) => e.code === 'EMPTY_QUEUE',
    );
  });

  it('only the creator or someone with Manage Server can delete', () => {
    const store = createPlaylistStore({ file: newFile() });
    store.create(GUILD, 'Benim', OWNER, [view(1)]);
    assert.throws(
      () => store.remove(GUILD, 'Benim', { userId: OTHER }),
      (e) => e.code === 'MISSING_PERMISSIONS' && /oluşturan/.test(e.message),
    );
    assert.equal(store.remove(GUILD, 'benim', { userId: OWNER }), 'Benim');
    store.create(GUILD, 'Benim', OWNER, [view(1)]);
    assert.equal(store.remove(GUILD, 'Benim', { userId: OTHER, canManageGuild: true }), 'Benim');
    assert.equal(store.list(GUILD).length, 0);
    assert.throws(
      () => store.remove(GUILD, 'Benim', { userId: OWNER }),
      (e) => e.code === 'NOT_FOUND',
    );
  });

  it('autocomplete suggests names that start with the typed text first, at most 25', () => {
    const store = createPlaylistStore({ file: newFile() });
    for (const name of ['Rock', 'Pop rock', 'Rap', 'Klasik']) store.create(GUILD, name, OWNER, [view(1)]);
    assert.deepEqual(store.suggest(GUILD, 'ro'), ['Rock', 'Pop rock']);
    assert.deepEqual(store.suggest(GUILD, ''), ['Klasik', 'Pop rock', 'Rap', 'Rock']);
    for (let i = 0; i < 30; i++) store.create(GUILD, `x${i}`, OWNER, [view(1)]);
    assert.equal(store.suggest(GUILD, '').length, 25);
  });

  it('writes atomically: a failed write keeps the old file and changes nothing in memory', () => {
    const file = newFile();
    const store = createPlaylistStore({ file });
    store.create(GUILD, 'Eski', OWNER, [view(1)]);
    const before = readFileSync(file, 'utf8');
    const failingFs = {
      ...fs,
      renameSync: () => {
        throw Object.assign(new Error('disk dolu'), { code: 'ENOSPC' });
      },
    };
    const broken = createPlaylistStore({ file, fs: failingFs, logger: { warn() {} } });
    assert.throws(
      () => broken.create(GUILD, 'Yeni', OWNER, [view(2)]),
      (e) => e.code === 'SAVE_FAILED' && /listeler\.json/.test(e.message),
    );
    assert.throws(
      () => broken.remove(GUILD, 'Eski', { userId: OWNER }),
      (e) => e.code === 'SAVE_FAILED',
    );
    assert.deepEqual(
      broken.list(GUILD).map((l) => l.name),
      ['Eski'],
      'memory unchanged',
    );
    assert.equal(readFileSync(file, 'utf8'), before, 'file unchanged');
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes('yaziliyor')),
      [],
      'no temporary files left',
    );
  });

  it('a corrupt file is backed up and the store starts empty; odd entries are dropped', () => {
    const file = newFile();
    writeFileSync(file, '{ bozuk');
    const store = createPlaylistStore({ file, logger: { warn() {} } });
    assert.deepEqual(store.list(GUILD), []);
    assert.ok(readdirSync(dir).some((f) => f.startsWith(`listeler-${fileNo}.json.bozuk-`)));

    const odd = newFile();
    writeFileSync(
      odd,
      JSON.stringify({
        guilds: {
          [GUILD]: {
            iyi: { name: 'İyi', ownerId: OWNER, tracks: [savedEntry(view(1)), { uri: 'javascript:alert(1)' }] },
            kotu: { name: '<b>', ownerId: OWNER, tracks: [] },
            sahipsiz: { name: 'Sahipsiz', tracks: [] },
          },
          'değil-bir-kimlik': {},
        },
      }),
    );
    const loaded = createPlaylistStore({ file: odd });
    assert.deepEqual(
      loaded.list(GUILD).map((l) => [l.name, l.count]),
      [['İyi', 1]],
    );
  });

  it('reserved names (__proto__, constructor, ...) are refused and cannot break the store', () => {
    for (const bad of ['__proto__', 'constructor', 'Constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.throws(
        () => normalizeName(bad),
        (e) => e.code === 'INVALID_VALUE',
        bad,
      );
    }
    const store = createPlaylistStore({ file: newFile() });
    for (const bad of ['__proto__', 'constructor']) {
      assert.throws(
        () => store.get(GUILD, bad),
        (e) => e.code === 'INVALID_VALUE',
      );
      assert.throws(
        () => store.append(GUILD, bad, OWNER, view(1)),
        (e) => e.code === 'INVALID_VALUE',
      );
      assert.throws(
        () => store.create(GUILD, bad, OWNER, [view(1)]),
        (e) => e.code === 'INVALID_VALUE',
      );
    }
    // Nothing is inherited for a server without lists, nor for a list name that is not there.
    assert.deepEqual(store.list('toString'), []);
    assert.throws(
      () => store.get(GUILD, 'yok'),
      (e) => e.code === 'NOT_FOUND',
    );
    assert.equal(store.create(GUILD, 'normal', OWNER, [view(1)]).saved, 1);
    assert.equal({}.polluted, undefined);
  });

  it('a file with "__proto__" keys loads safely', () => {
    const file = newFile();
    writeFileSync(
      file,
      `{"guilds":{"__proto__":{"x":{"name":"x","ownerId":"${OWNER}","tracks":[]}},"${GUILD}":{"__proto__":{"name":"Kötü","ownerId":"${OWNER}","tracks":[]},"iyi":{"name":"iyi","ownerId":"${OWNER}","tracks":[]}}}}`,
    );
    const store = createPlaylistStore({ file });
    assert.deepEqual(
      store.list(GUILD).map((l) => l.name),
      ['iyi', 'Kötü'],
      'the entry is keyed by its own name, not by "__proto__"',
    );
    assert.equal({}.name, undefined, 'Object.prototype untouched');
  });
});
