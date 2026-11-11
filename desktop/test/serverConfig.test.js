'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeStructure,
  normalizeSchema,
  normalizeView,
  validateChange,
  writeRequest,
  waitForAnswer,
  createServerConfigWatcher,
  REQUEST_NAME,
} = require('../src/main/serverConfig');
const SS = require('../src/renderer/serverSettings');

const GUILD = '111111111111111111';
const TEXT = '222222222222222221';
const MUTE = '222222222222222222';
const VOICE = '222222222222222223';
const ROLE = '333333333333333331';
const HIGH = '333333333333333332';
const BOTROLE = '333333333333333333';

const structureFile = () => ({
  schemaVersion: 1,
  sunucular: [
    {
      id: GUILD,
      ad: 'Örnek',
      botRolPozisyonu: 10,
      rolleriYonetebilir: true,
      kanallar: [
        { id: TEXT, ad: 'genel', tur: 'metin', kategoriId: null, kategori: null, yazabilir: true, baglanabilir: false },
        {
          id: MUTE,
          ad: 'duyuru',
          tur: 'metin',
          kategoriId: null,
          kategori: null,
          yazabilir: false,
          baglanabilir: false,
        },
        {
          id: VOICE,
          ad: 'Sohbet',
          tur: 'ses',
          kategoriId: null,
          kategori: 'Ses',
          yazabilir: false,
          baglanabilir: true,
        },
        { id: 'x', ad: 'bozuk', tur: 'metin' },
        { id: '222222222222222229', ad: 'konu', tur: 'gonderi' },
      ],
      roller: [
        {
          id: HIGH,
          ad: 'Yönetim',
          renk: '#FF0000',
          pozisyon: 20,
          verilebilir: false,
          neden: 'rol, botun rolünden yukarıda',
          tehlikeli: false,
        },
        { id: ROLE, ad: 'Üye', renk: 'red', pozisyon: 2, verilebilir: true, neden: null, tehlikeli: false },
        {
          id: BOTROLE,
          ad: 'Bot',
          renk: '#000000',
          pozisyon: 9,
          yonetilen: true,
          verilebilir: false,
          neden: 'bota ait',
        },
      ],
    },
  ],
});

const schemaFile = () => ({
  schemaVersion: 1,
  kategoriler: ['Müzik', 'Karşılama'],
  moduller: [
    {
      ad: 'karsilama',
      baslik: 'Karşılama',
      emoji: '👋',
      kategori: 'Karşılama',
      kapali: null,
      alanlar: [
        { anahtar: 'hosgeldin-kanal', tur: 'kanal', etiket: 'Kanal', kanalTurleri: ['metin'] },
        { anahtar: 'hosgeldin-metni', tur: 'metin', etiket: 'Metin', enAz: 1, enFazla: 20, varsayilan: 'Selam' },
        { anahtar: 'hosgeldin-kart', tur: 'bayrak', etiket: 'Kart', varsayilan: true },
        { anahtar: 'otorol-1', tur: 'rol', etiket: 'Rol', verilebilir: true },
        { anahtar: 'bekleme', tur: 'sayi', etiket: 'Bekleme', enAz: 0, enFazla: 600 },
        { anahtar: 'haric', tur: 'kanal-listesi', etiket: 'Hariç', kanalTurleri: ['metin'], enFazla: 2 },
        { anahtar: 'roller', tur: 'ozel', etiket: 'Seviye rolleri', yalnizDiscord: '/seviye rol' },
        { anahtar: 'gizemli', tur: 'ozel', etiket: 'Komutsuz' },
        { anahtar: 'constructor', tur: 'bayrak', etiket: 'Kötü' },
        { anahtar: '__proto__', tur: 'bayrak', etiket: 'Kötü' },
        { anahtar: 'yeni-tur', tur: 'renk', etiket: 'Bilinmeyen tür' },
        { anahtar: 'ters', tur: 'sayi', etiket: 'Ters aralık', enAz: 5, enFazla: 1 },
      ],
    },
    { ad: '__proto__', baslik: 'Kötü', alanlar: [{ anahtar: 'a', tur: 'bayrak' }] },
    {
      ad: 'kapali-modul',
      baslik: 'Kapalı',
      kategori: 'Uzay',
      kapali: 'Intent yok',
      alanlar: [{ anahtar: 'a', tur: 'bayrak' }],
    },
  ],
});

/** One data/sunucu-yapisi/<guildId>.json. */
const guildFile = () => ({
  schemaVersion: 1,
  guncellendi: '2026-11-11T10:00:00Z',
  sunucu: structureFile().sunucular[0],
});
const loaded = () => {
  const guild = normalizeStructure(guildFile(), GUILD);
  return { schema: normalizeSchema(schemaFile()), guildOf: (id) => (id === GUILD ? guild : null) };
};
const change = (fields) => ({ guildId: GUILD, modul: 'karsilama', alan: 'hosgeldin-kanal', deger: null, ...fields });

test('structure file: only valid channels and roles, names and colours checked', () => {
  assert.equal(normalizeStructure({ ...guildFile(), schemaVersion: 2 }, GUILD), null);
  assert.equal(
    normalizeStructure(guildFile(), '999999999999999999'),
    null,
    'a file must hold the server it is named after',
  );
  const guild = normalizeStructure(guildFile(), GUILD);
  assert.deepEqual(
    guild.kanallar.map((c) => c.id),
    [TEXT, MUTE, VOICE],
  );
  assert.equal(guild.roller.find((r) => r.id === ROLE).renk, '#000000', 'a colour that is not #rrggbb is dropped');
  assert.equal(guild.roller.find((r) => r.id === HIGH).renk, '#ff0000');
  assert.equal(
    normalizeStructure({ schemaVersion: 1, sunucu: { id: GUILD, ad: 'x'.repeat(500) } }, GUILD).ad.length,
    100,
  );
});

test('schema file: reserved names, unknown types and broken ranges are dropped; Discord-only is enforced', () => {
  const schema = normalizeSchema(schemaFile());
  assert.deepEqual(
    schema.moduller.map((m) => m.ad),
    ['karsilama', 'kapali-modul'],
  );
  const keys = schema.moduller[0].alanlar.map((f) => f.anahtar);
  assert.deepEqual(keys, [
    'hosgeldin-kanal',
    'hosgeldin-metni',
    'hosgeldin-kart',
    'otorol-1',
    'bekleme',
    'haric',
    'roller',
    'gizemli',
  ]);
  assert.equal(schema.moduller[0].alanlar.find((f) => f.anahtar === 'gizemli').yalnizDiscord, '/ayar');
  assert.equal(schema.moduller[1].kategori, 'Diğer');
  assert.equal(normalizeSchema({ schemaVersion: 1 }), null);
});

test('view file: only "modul.alan" keys and plain values', () => {
  const view = normalizeView({
    schemaVersion: 1,
    sunucular: {
      [GUILD]: {
        degerler: { 'karsilama.hosgeldin-kanal': TEXT, __proto__x: 1, 'a.b': { nesne: true }, 'karsilama.n': 1.5 },
        ayarli: ['karsilama.hosgeldin-kanal', 'kötü'],
        uyarilar: { 'karsilama.otorol-1': 'verilmiyor' },
        listeler: { 'kayit.haric': [TEXT, 5] },
      },
      bozuk: {},
    },
  });
  const g = view.sunucular.get(GUILD);
  assert.deepEqual(g.degerler, { 'karsilama.hosgeldin-kanal': TEXT, 'karsilama.n': null });
  assert.deepEqual(g.ayarli, ['karsilama.hosgeldin-kanal']);
  assert.deepEqual(g.listeler, { 'kayit.haric': [TEXT] });
  assert.equal(view.sunucular.size, 1);
});

test('IPC: only { guildId, modul, alan, deger } that fit the schema and the server get through', () => {
  const ctx = loaded();
  const refused = (fields, pattern, payload = change(fields)) => {
    const result = validateChange(payload, ctx);
    assert.equal(result.ok, false, JSON.stringify(fields));
    assert.match(result.hata, pattern);
  };
  refused({}, /Geçersiz istek/, { ...change({}), yol: 'C:\\Windows' });
  refused({}, /Geçersiz istek/, { guildId: GUILD, modul: 'karsilama', alan: 'hosgeldin-kanal' });
  refused({}, /Geçersiz istek/, 'metin');
  refused({ modul: '__proto__' }, /Geçersiz istek/);
  refused({ alan: 'constructor' }, /Geçersiz istek/);
  refused({ guildId: '999999999999999999' }, /kanal ve rol listesi yok/);
  refused({ alan: 'yok' }, /Bilinmeyen ayar/);
  refused({ alan: 'roller', deger: [] }, /Discord'da \/seviye rol ile/);
  refused({ modul: 'kapali-modul', alan: 'a', deger: true }, /Intent yok/);
  refused({ deger: VOICE }, /başka türde/);
  refused({ deger: '222222222222222299' }, /bu sunucuda yok/);
  refused({ alan: 'otorol-1', deger: HIGH }, /verilemez: rol, botun rolünden yukarıda/);
  refused({ alan: 'otorol-1', deger: BOTROLE }, /bota ya da sunucu takviyesine/);
  refused({ alan: 'otorol-1', deger: GUILD }, /geçersiz/);
  refused({ alan: 'hosgeldin-metni', deger: 'x'.repeat(21) }, /1-20 karakter/);
  refused({ alan: 'hosgeldin-metni', deger: 'a\u0007b' }, /denetim/);
  refused({ alan: 'hosgeldin-metni', deger: 5 }, /Metin bekleniyordu/);
  refused({ alan: 'bekleme', deger: 601 }, /0 ile 600/);
  refused({ alan: 'bekleme', deger: '5' }, /0 ile 600/);
  refused({ alan: 'hosgeldin-kart', deger: 'evet' }, /Açık ya da kapalı/);
  refused({ alan: 'haric', deger: [TEXT, TEXT] }, /iki kez/);
  refused({ alan: 'haric', deger: [TEXT, MUTE, TEXT.replace(/1$/, '0')] }, /En fazla 2/);
  refused({ alan: 'haric', deger: [VOICE] }, /başka türde/);
  refused({ alan: 'haric', deger: 'liste' }, /Liste bekleniyordu/);
  assert.match(validateChange(change({}), { schema: null, guildOf: () => null }).hata, /henüz yok/);

  assert.deepEqual(validateChange(change({ deger: MUTE }), ctx).istek, change({ deger: MUTE }));
  assert.equal(validateChange(change({ alan: 'hosgeldin-metni', deger: '  Selam  ' }), ctx).istek.deger, 'Selam');
  assert.equal(validateChange(change({ alan: 'otorol-1', deger: ROLE }), ctx).ok, true);
  assert.equal(validateChange(change({ alan: 'otorol-1', deger: null }), ctx).ok, true, 'null resets');
  assert.deepEqual(validateChange(change({ alan: 'haric', deger: null }), ctx).istek.deger, []);
});

test('request file is written atomically under data/istekler with a uuid name; the answer is read and removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-ayar-'));
  try {
    const id = writeRequest(dir, change({ deger: TEXT }), { now: () => Date.parse('2026-11-11T10:00:00Z') });
    assert.ok(REQUEST_NAME.test(id));
    const requests = fs.readdirSync(path.join(dir, 'data', 'istekler'));
    assert.deepEqual(requests, [`${id}.json`], 'no temporary file is left');
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'istekler', `${id}.json`), 'utf8'));
    assert.deepEqual(body, { surum: 1, ...change({ deger: TEXT }), istenen: '2026-11-11T10:00:00.000Z' });

    const answers = path.join(dir, 'data', 'yanitlar');
    fs.mkdirSync(answers, { recursive: true });
    setTimeout(
      () =>
        fs.writeFileSync(
          path.join(answers, `${id}.json`),
          JSON.stringify({ ok: false, hata: 'Rol yüksek.', yeniDeger: null }),
        ),
      30,
    );
    const answer = await waitForAnswer(dir, id, { timeoutMs: 3000, intervalMs: 10 });
    assert.deepEqual(answer, { ok: false, hata: 'Rol yüksek.', yeniDeger: null });
    assert.equal(fs.existsSync(path.join(answers, `${id}.json`)), false);

    // No answer: the request is taken back (renamed away, then removed), so it never applies later.
    const late = writeRequest(dir, change({ deger: TEXT }));
    const timedOut = await waitForAnswer(dir, late, { timeoutMs: 50, intervalMs: 10 });
    assert.equal(timedOut.zamanAsimi, true);
    assert.match(timedOut.hata, /geri alındı/);
    assert.deepEqual(
      fs.readdirSync(path.join(dir, 'data', 'istekler')).filter((n) => n.startsWith(late)),
      [],
    );

    // Removing the taken-back file fails (e.g. EPERM): still reported as taken back, never thrown.
    const flaky = writeRequest(dir, change({ deger: TEXT }));
    const failingFs = {
      ...fs,
      rmSync: () => {
        throw Object.assign(new Error('meşgul'), { code: 'EPERM' });
      },
    };
    const kept = await waitForAnswer(dir, flaky, { fsImpl: failingFs, timeoutMs: 30, intervalMs: 10 });
    assert.match(kept.hata, /geri alındı/);
    assert.ok(
      fs.existsSync(path.join(dir, 'data', 'istekler', `${flaky}.geri-alindi`)),
      'left for the bot to clean up',
    );

    // The bot claimed it (renamed to .isleniyor) just before the timeout: it is not "taken back", the window
    // hears "uygulanıyor" and the late answer still arrives.
    const claimed = writeRequest(dir, change({ deger: TEXT }));
    const requestsDir = path.join(dir, 'data', 'istekler');
    const progress = [];
    setTimeout(
      () => fs.renameSync(path.join(requestsDir, `${claimed}.json`), path.join(requestsDir, `${claimed}.isleniyor`)),
      20,
    );
    setTimeout(() => {
      fs.writeFileSync(
        path.join(answers, `${claimed}.json`),
        JSON.stringify({ ok: true, hata: null, yeniDeger: TEXT }),
      );
      fs.rmSync(path.join(requestsDir, `${claimed}.isleniyor`));
    }, 200);
    const applied = await waitForAnswer(dir, claimed, {
      timeoutMs: 60,
      claimedWaitMs: 3000,
      intervalMs: 10,
      onProgress: (durum) => progress.push(durum),
    });
    assert.deepEqual(applied, { ok: true, hata: null, yeniDeger: TEXT });
    assert.deepEqual(progress, ['uygulaniyor']);

    // Claimed and never answered: still not reported as taken back.
    const stuck = writeRequest(dir, change({ deger: TEXT }));
    fs.renameSync(path.join(requestsDir, `${stuck}.json`), path.join(requestsDir, `${stuck}.isleniyor`));
    const pending = await waitForAnswer(dir, stuck, { timeoutMs: 30, claimedWaitMs: 30, intervalMs: 10 });
    assert.doesNotMatch(pending.hata, /geri alındı/);
    assert.match(pending.hata, /uyguluyor/);
    assert.equal((await waitForAnswer(dir, '../durum')).ok, false, 'only uuid ids are looked up');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("watcher reads the schema, the view and only the asked server's structure file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-ayar-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'));
    let changes = 0;
    const watcher = createServerConfigWatcher({
      getProjectDir: () => dir,
      onChange: () => (changes += 1),
      pollMs: 60_000,
    });
    watcher.start();
    assert.equal(watcher.guildView(GUILD).sema, null);
    fs.mkdirSync(path.join(dir, 'data', 'sunucu-yapisi'));
    fs.writeFileSync(path.join(dir, 'data', 'sunucu-yapisi', `${GUILD}.json`), JSON.stringify(guildFile()));
    // Another server's file under this server's name is refused.
    fs.writeFileSync(path.join(dir, 'data', 'sunucu-yapisi', '999999999999999999.json'), JSON.stringify(guildFile()));
    fs.writeFileSync(path.join(dir, 'data', 'ayar-semasi.json'), JSON.stringify(schemaFile()));
    watcher.refresh();
    const view = watcher.guildView(GUILD);
    assert.equal(view.yapi.kanallar.length, 3);
    assert.equal(view.sema.moduller.length, 2);
    assert.equal(watcher.guildView('../../etc'), null);
    assert.equal(watcher.guildView('999999999999999999').yapi, null);
    assert.equal(watcher.guildStructure(GUILD).ad, 'Örnek');
    assert.ok(changes >= 1);
    watcher.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('window helpers: channel and role choices, typed inputs', () => {
  const guild = normalizeStructure(guildFile(), GUILD);
  const channels = SS.channelChoices(guild, ['metin']);
  assert.deepEqual(
    channels.map((c) => [c.label, Boolean(c.warning)]),
    [
      ['#genel', false],
      ['#duyuru', true],
    ],
  );
  assert.equal(SS.channelChoices(guild, ['ses'])[0].label, 'Ses › 🔊 Sohbet');
  const roles = SS.roleChoices(guild, { verilebilir: true });
  assert.deepEqual(
    roles.map((r) => [r.label, r.disabled]),
    [
      ['@Yönetim', true],
      ['@Üye', false],
      ['@Bot', true],
    ],
  );
  assert.match(roles[0].reason, /botun rolünden yukarıda/);
  assert.equal(SS.roleChoices(guild, {})[0].disabled, false, 'a role only mentioned may be above the bot');
  assert.deepEqual(
    SS.roleBlock({ tehlikeli: true, verilebilir: false }, { verilebilir: true }),
    'yönetim izni var (dağıtılamaz)',
  );
  const sayi = { tur: 'sayi', enAz: 0, enFazla: 99 };
  assert.deepEqual(SS.parseInput(sayi, ' 12 '), { ok: true, value: 12 });
  assert.equal(SS.parseInput(sayi, '1.5').ok, false);
  assert.equal(SS.parseInput(sayi, '100').ok, false);
  assert.equal(SS.parseInput({ tur: 'metin', enAz: 7, enFazla: 7 }, '#fff').ok, false);
  assert.deepEqual(SS.parseInput({ tur: 'kanal-listesi', enFazla: 2 }, [TEXT, TEXT]), { ok: true, value: [TEXT] });
  assert.ok(SS.sameValue([TEXT], [TEXT]) && !SS.sameValue([TEXT], []) && SS.sameValue(null, undefined));
  assert.deepEqual(
    SS.groupModules(normalizeSchema(schemaFile())).map((g) => g.kategori),
    ['Karşılama', 'Diğer'],
  );
});
