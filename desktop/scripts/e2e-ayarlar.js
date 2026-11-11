'use strict';

// End-to-end check of the Servers tab's "Ayarlar" part, without Discord, Lavalink or a real bot:
//  - a throwaway project folder whose data/ holds a made-up durum.json, sunucu-yapisi/<id>.json and
//    ayarlar-gorunum.json; ayar-semasi.json is exported from the bot's real modules
//  - a fake bot in this script claims data/istekler/<uuid>.json (renames it to .isleniyor), answers in
//    data/yanitlar/ (like
//    src/ozellikler/_masaustu/istekler.js) and rewrites ayarlar-gorunum.json
//  - drives the real window through the Chrome DevTools protocol
// Proves: a channel setting is saved and shown, a refusal from the bot is shown in Turkish, a change made
// "in Discord" (the view file) redraws the screen, Discord-only settings show their hint, and with the bot
// off nothing can be saved. Only made-up names appear in the screenshot.
//
// Usage: node scripts/e2e-ayarlar.js [screenshot.png]

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const winproc = require('../src/main/winproc');

const DESKTOP = path.join(__dirname, '..');
const PROJECT = path.join(DESKTOP, '..');
const SHOT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'desktop-ekran-sunucu-ayarlari.png'));
const ELECTRON = process.env.E2E_EXE
  ? path.resolve(process.env.E2E_EXE)
  : path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9343;
const REQUEST_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

const GUILD = '100000000000000001';
const OTHER = '100000000000000002';
const id = (n) => String(500000000000000000n + BigInt(n));
const CH = {
  genel: id(1),
  duyurular: id(2),
  hosgeldin: id(3),
  kayitlar: id(4),
  sohbet: id(5),
  oyun: id(6),
  lobi: id(7),
};
const RL = { yonetim: id(20), moderator: id(21), uye: id(22), oyuncu: id(23), botRol: id(24), yeni: id(25) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${name}${detail ? ` - ${detail}` : ''}`);
}

// ---- made-up bot files ------------------------------------------------------------------------

function fakeStatus(running = true) {
  const now = Date.now();
  const server = (gid, name, memberCount) => ({
    id: gid,
    name,
    iconUrl: null,
    memberCount,
    joinedAt: new Date(Date.UTC(2025, 3, 1)).toISOString(),
    djRole: false,
    voice: null,
    playing: null,
    queueLength: 0,
    repeatMode: 'off',
    volume: null,
    songsPlayed: 12,
  });
  return {
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    running,
    pid: process.pid,
    bot: {
      username: 'Örnek Bot#0001',
      id: '900000000000000001',
      avatarUrl: null,
      startedAt: new Date(now - 3600_000).toISOString(),
      uptimeMs: 3600_000,
      pingMs: 60,
      guildCount: 2,
      memberCount: 180,
      memory: { rss: 120 * 1048576, heapUsed: 60 * 1048576, heapTotal: 90 * 1048576 },
      versions: { node: 'v24.16.0', discordJs: '14.28.1' },
    },
    lavalink: {
      connected: true,
      version: '4.2.2',
      players: 0,
      playingPlayers: 0,
      uptimeMs: 1,
      cpuLoad: 0,
      memoryUsed: 1,
    },
    sayaclar: {
      toplam: { songsPlayed: 0, commandsUsed: 0, commands: {}, topSongs: [], songsByGuild: {} },
      oturum: { songsPlayed: 0, commandsUsed: 0, commands: {}, topSongs: [], songsByGuild: {} },
    },
    sunucular: [server(GUILD, 'Örnek Sunucu', 142), server(OTHER, 'Deneme Topluluğu', 38)],
  };
}

function fakeStructure() {
  const channel = (cid, ad, tur, kategori = null, extra = {}) => ({
    id: cid,
    ad,
    tur,
    kategoriId: kategori ? id(90) : null,
    kategori,
    yazabilir: tur === 'metin',
    baglanabilir: tur === 'ses',
    ...extra,
  });
  const role = (rid, ad, renk, pozisyon, extra = {}) => ({
    id: rid,
    ad,
    renk,
    pozisyon,
    yonetilen: false,
    tehlikeli: false,
    verilebilir: true,
    neden: null,
    ...extra,
  });
  return {
    schemaVersion: 1,
    guncellendi: new Date().toISOString(),
    sunucular: [
      {
        id: GUILD,
        ad: 'Örnek Sunucu',
        botRolPozisyonu: 6,
        rolleriYonetebilir: true,
        kanallar: [
          channel(CH.genel, 'genel', 'metin'),
          channel(CH.duyurular, 'duyurular', 'metin', null, { yazabilir: false }),
          channel(CH.hosgeldin, 'hoş-geldin', 'metin'),
          channel(CH.kayitlar, 'kayıtlar', 'metin'),
          channel(id(90), 'Oyun', 'kategori'),
          channel(CH.oyun, 'oyun-sohbet', 'metin', 'Oyun'),
          channel(CH.sohbet, 'Sohbet', 'ses', 'Oyun'),
          channel(CH.lobi, '➕ Oda aç', 'ses', 'Oyun'),
        ],
        roller: [
          role(RL.yonetim, 'Yönetim', '#e74c3c', 9, {
            tehlikeli: true,
            verilebilir: false,
            neden: 'rolde yönetim izinleri var (yasaklama, atma, kanal/rol yönetimi...)',
          }),
          role(RL.botRol, 'Örnek Bot', '#5865f2', 6, {
            yonetilen: true,
            verilebilir: false,
            neden: 'rol bir bota ya da sunucu takviyesine ait',
          }),
          role(RL.moderator, 'Moderatör', '#3498db', 5),
          role(RL.oyuncu, 'Oyuncu', '#2ecc71', 3),
          role(RL.uye, 'Üye', '#95a5a6', 2),
          role(RL.yeni, 'Yeni Gelen', '#f1c40f', 1),
        ],
      },
    ],
  };
}

/** The real schema of the bot's modules (as src/ozellikler/_masaustu/gorunum.js exports it). */
function realSchema() {
  const script = `
    const { loadModules } = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT, 'src', 'ozellikler', 'index.js')).href)});
    const { buildSchemaExport } = await import(${JSON.stringify(pathToFileURL(path.join(PROJECT, 'src', 'ozellikler', '_masaustu', 'gorunum.js')).href)});
    const modules = await loadModules();
    const ozellikler = { moduller: new Map(modules.map((m) => [m.ad, m])), disabledReason: () => null };
    process.stdout.write(JSON.stringify(buildSchemaExport(ozellikler)));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: PROJECT });
  if (result.status !== 0) throw new Error(`Şema üretilemedi: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function defaultView(schema) {
  const degerler = {};
  const listeler = {};
  for (const m of schema.moduller) {
    for (const f of m.alanlar) {
      const key = `${m.ad}.${f.anahtar}`;
      if (f.tur === 'ozel' || f.tur.endsWith('-listesi')) listeler[key] = [];
      else degerler[key] = f.varsayilan ?? null;
    }
  }
  listeler['seviye.roller'] = ['Seviye 5 → @Oyuncu', 'Seviye 10 → @Moderatör'];
  listeler['ayarlar.kalici-panel'] = ['🎛️ Kalıcı panel: kurulmadı (/ayar panel)'];
  listeler['kayit.haric'] = [CH.duyurular];
  degerler['gecici-oda.kanal'] = CH.lobi;
  return {
    schemaVersion: 1,
    guncellendi: new Date().toISOString(),
    saltOkunur: false,
    sunucular: { [GUILD]: { degerler, ayarli: ['gecici-oda.kanal'], uyarilar: {}, listeler } },
  };
}

// ---- the fake bot: answers requests like src/ozellikler/_masaustu/istekler.js -----------------------

function startFakeBot(dataDir, view) {
  const requests = [];
  const dir = path.join(dataDir, 'istekler');
  const answers = path.join(dataDir, 'yanitlar');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(answers, { recursive: true });
  const writeJson = (file, data) => {
    fs.writeFileSync(`${file}.yaziliyor`, JSON.stringify(data, null, 2));
    fs.renameSync(`${file}.yaziliyor`, file);
  };
  const busy = new Set();
  const timer = setInterval(() => {
    for (const name of fs.readdirSync(dir)) {
      if (!REQUEST_NAME.test(name)) continue;
      const id = name.slice(0, -5);
      if (busy.has(id)) continue;
      // Claim first, like the bot: from now on the app can no longer take it back.
      const file = path.join(dir, `${id}.isleniyor`);
      let istek;
      try {
        fs.renameSync(path.join(dir, name), file);
        istek = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      requests.push(istek);
      const key = `${istek.modul}.${istek.alan}`;
      // One slow setting: answered after the app's 15 s wait, so the window must say "uyguluyor" meanwhile.
      if (key === 'karsilama.gulegule-kart') {
        busy.add(id);
        setTimeout(() => {
          fs.rmSync(file);
          const g = view.sunucular[GUILD];
          g.degerler[key] = istek.deger;
          if (!g.ayarli.includes(key)) g.ayarli.push(key);
          writeJson(path.join(dataDir, 'ayarlar-gorunum.json'), { ...view, guncellendi: new Date().toISOString() });
          writeJson(path.join(answers, name), { surum: 1, id, ok: true, hata: null, yeniDeger: istek.deger });
          busy.delete(id);
        }, 17_000);
        continue;
      }
      fs.rmSync(file);
      let answer;
      if (key === 'karsilama.otorol-1' && istek.deger === RL.moderator) {
        answer = {
          ok: false,
          hata: '@Moderatör rolünü ayarlayamazsınız: sizin en yüksek rolünüzden aşağıda olmalı (sunucu sahibi hariç).',
          yeniDeger: null,
        };
      } else {
        const g = view.sunucular[GUILD];
        if (Array.isArray(istek.deger)) g.listeler[key] = istek.deger;
        else g.degerler[key] = istek.deger;
        if (istek.deger === null) g.ayarli = g.ayarli.filter((k) => k !== key);
        else if (!g.ayarli.includes(key)) g.ayarli.push(key);
        writeJson(path.join(dataDir, 'ayarlar-gorunum.json'), { ...view, guncellendi: new Date().toISOString() });
        answer = { ok: true, hata: null, yeniDeger: istek.deger };
      }
      writeJson(path.join(answers, name), {
        surum: 1,
        id: name.slice(0, -5),
        ...answer,
        islendi: new Date().toISOString(),
      });
    }
  }, 100);
  return { requests, stop: () => clearInterval(timer) };
}

// ---- DevTools protocol ----------------------------------------------------------------------------

async function connectCdp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('app://muzik'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        let next = 0;
        const pending = new Map();
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        };
        const send = (method, params = {}) =>
          new Promise((resolve) => {
            next += 1;
            pending.set(next, resolve);
            ws.send(JSON.stringify({ id: next, method, params }));
          });
        return { ws, send };
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error('Uygulama penceresine bağlanılamadı.');
}

async function evaluate(cdp, expression) {
  const msg = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (msg.result?.exceptionDetails)
    throw new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return msg.result?.result?.value;
}

async function waitFor(cdp, expression, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(150);
  }
  throw new Error(`Zaman aşımı: ${label}`);
}

const row = (key) => `document.querySelector('[data-key="${key}"]')`;

// ---- main -------------------------------------------------------------------------------------------

async function main() {
  // E2E_WORK_DIR=<empty or missing folder> puts the throwaway project there: the sidebar shows the project
  // folder, so a neutral path keeps the screenshot free of real names. Default: a new temp folder.
  const work = process.env.E2E_WORK_DIR
    ? path.resolve(process.env.E2E_WORK_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-e2e-ayar-'));
  if (process.env.E2E_WORK_DIR) {
    if (fs.existsSync(work) && fs.readdirSync(work).length) throw new Error(`E2E_WORK_DIR boş olmalı: ${work}`);
    fs.mkdirSync(work, { recursive: true });
  }
  const proj = path.join(work, 'proje');
  const dataDir = path.join(proj, 'data');
  let app = null;
  let bot = null;
  let keepAlive = null;
  try {
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'lavalink'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'index.js'), '// e2e: bot started by nobody\n');
    fs.writeFileSync(path.join(proj, 'lavalink', 'application.yml'), '# e2e\n');
    fs.writeFileSync(path.join(proj, 'package.json'), '{ "name": "e2e-proje", "private": true }\n');
    const schema = realSchema();
    const view = defaultView(schema);
    fs.writeFileSync(path.join(dataDir, 'ayar-semasi.json'), JSON.stringify(schema));
    fs.mkdirSync(path.join(dataDir, 'sunucu-yapisi'));
    for (const sunucu of fakeStructure().sunucular) {
      fs.writeFileSync(
        path.join(dataDir, 'sunucu-yapisi', `${sunucu.id}.json`),
        JSON.stringify({ schemaVersion: 1, guncellendi: new Date().toISOString(), sunucu }),
      );
    }
    fs.writeFileSync(path.join(dataDir, 'ayarlar-gorunum.json'), JSON.stringify(view));
    let running = true;
    const writeStatus = () => fs.writeFileSync(path.join(dataDir, 'durum.json'), JSON.stringify(fakeStatus(running)));
    writeStatus();
    keepAlive = setInterval(writeStatus, 4000);
    bot = startFakeBot(dataDir, view);
    console.log(`Geçici proje: ${proj}`);
    check(
      'Şema botun gerçek modüllerinden üretildi',
      schema.moduller.some((m) => m.ad === 'karsilama'),
      `${schema.moduller.length} modül`,
    );

    const env = { ...process.env, MUZIKBOT_PROJECT_DIR: proj, MUZIKBOT_DESKTOP_USERDATA: path.join(work, 'veri') };
    const args = process.env.E2E_EXE
      ? [`--remote-debugging-port=${CDP_PORT}`]
      : ['.', `--remote-debugging-port=${CDP_PORT}`];
    app = spawn(ELECTRON, args, { cwd: DESKTOP, env, stdio: 'ignore' });
    const cdp = await connectCdp();
    await waitFor(cdp, 'Boolean(window.muzik) && document.readyState === "complete"', 20_000, 'pencere');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await evaluate(cdp, "document.querySelector('[data-view=servers]').click()");
    await waitFor(
      cdp,
      "document.querySelectorAll('#server-grid .server-card').length === 2",
      15_000,
      'sunucu kartları',
    );
    await evaluate(
      cdp,
      "[...document.querySelectorAll('#server-grid .server-card')].find((c) => c.textContent.includes('Örnek Sunucu')).click()",
    );
    await waitFor(cdp, "document.querySelectorAll('#server-settings .set-card').length > 3", 15_000, 'ayar kartları');
    const layout = await evaluate(
      cdp,
      "({ cats: [...document.querySelectorAll('#server-settings .settings-cat h3')].map((e) => e.textContent), cards: document.querySelectorAll('#server-settings .set-card').length, off: Boolean(document.querySelector('#settings-bot-off')) })",
    );
    check(
      'Ayarlar bölümü kategorilerle açıldı',
      ['Müzik', 'Oyun', 'Seviye', 'Karşılama', 'Kayıt', 'Odalar', 'Bildirimler'].every((c) => layout.cats.includes(c)),
      layout.cats.join(', '),
    );
    check('Bot açıkken "Bot kapalı" uyarısı yok', !layout.off);

    // Channel picker: only text channels, the one the bot cannot write to is marked.
    const options = await evaluate(
      cdp,
      `[...${row('karsilama.hosgeldin-kanal')}.querySelectorAll('select option')].map((o) => o.textContent)`,
    );
    check(
      'Kanal seçici türe göre süzülmüş, yazılamayan kanal işaretli',
      options.includes('#duyurular ⚠') && !options.some((o) => o.includes('Sohbet')),
      options.join(' | '),
    );
    const roleOptions = await evaluate(
      cdp,
      `[...${row('karsilama.otorol-1')}.querySelectorAll('select option')].map((o) => [o.textContent, o.disabled])`,
    );
    check(
      'Verilemeyen ve tehlikeli roller devre dışı, nedeniyle',
      roleOptions.some(([t, d]) => t.startsWith('@Yönetim (seçilemez: yönetim izni var') && d) &&
        roleOptions.some(([t, d]) => t.startsWith('@Örnek Bot (seçilemez') && d) &&
        roleOptions.some(([t, d]) => t === '@Üye' && !d),
    );
    const hint = await evaluate(cdp, `${row('seviye.roller')}.textContent`);
    check(
      '"Yalnız Discord\'dan" ipucu',
      /Bu ayarı Discord'da \/seviye rol ile yapın\./.test(hint) && /Seviye 5 → @Oyuncu/.test(hint),
    );

    // Save a channel setting.
    await evaluate(
      cdp,
      `(() => { const s = ${row('karsilama.hosgeldin-kanal')}.querySelector('select'); s.value = '${CH.hosgeldin}'; s.dispatchEvent(new Event('change')); })()`,
    );
    await evaluate(cdp, `${row('karsilama.hosgeldin-kanal')}.querySelector('.btn.primary').click()`);
    await waitFor(
      cdp,
      `/Kaydedildi/.test(${row('karsilama.hosgeldin-kanal')}.querySelector('.set-status').textContent)`,
      20_000,
      'kaydedildi',
    );
    const saved = bot.requests.find((r) => r.alan === 'hosgeldin-kanal');
    check(
      'İstek dosyası doğru biçimde yazıldı',
      saved &&
        saved.surum === 1 &&
        saved.guildId === GUILD &&
        saved.modul === 'karsilama' &&
        saved.deger === CH.hosgeldin &&
        Object.keys(saved).sort().join(',') === 'alan,deger,guildId,istenen,modul,surum',
      JSON.stringify(saved),
    );
    const shown = await evaluate(cdp, `${row('karsilama.hosgeldin-kanal')}.querySelector('select').value`);
    check('Kaydedilen değer ekranda', shown === CH.hosgeldin);
    check(
      'İstek ve yanıt dosyası kalmadı',
      fs.readdirSync(path.join(dataDir, 'istekler')).length === 0 &&
        fs.readdirSync(path.join(dataDir, 'yanitlar')).length === 0,
    );

    // Also a text and a switch, so the screenshot shows a real form.
    await evaluate(
      cdp,
      `(() => { const t = ${row('karsilama.hosgeldin-metni')}.querySelector('textarea'); t.value = 'Hoş geldin {kullanıcı}! Kuralları okumayı unutma.'; t.dispatchEvent(new Event('input')); })()`,
    );
    await evaluate(cdp, `${row('karsilama.hosgeldin-metni')}.querySelector('.btn.primary').click()`);
    await waitFor(
      cdp,
      `/Kaydedildi/.test(${row('karsilama.hosgeldin-metni')}.querySelector('.set-status').textContent)`,
      20_000,
      'metin kaydedildi',
    );

    // A request the bot claimed but answers late: "uyguluyor" on screen, never "geri alındı", then saved.
    await evaluate(
      cdp,
      `(() => { const i = ${row('karsilama.gulegule-kart')}.querySelector('input'); i.checked = true; i.dispatchEvent(new Event('change')); })()`,
    );
    await evaluate(cdp, `${row('karsilama.gulegule-kart')}.querySelector('.btn.primary').click()`);
    await waitFor(
      cdp,
      `/uyguluyor/.test(${row('karsilama.gulegule-kart')}.querySelector('.set-status').textContent)`,
      25_000,
      'uyguluyor',
    );
    await waitFor(
      cdp,
      `/Kaydedildi/.test(${row('karsilama.gulegule-kart')}.querySelector('.set-status').textContent)`,
      25_000,
      'geç yanıt kaydedildi',
    );
    const lateOn = await evaluate(cdp, `${row('karsilama.gulegule-kart')}.querySelector('input').checked`);
    check('Sahiplenilmiş istek: önce "uyguluyor", geri alınmadan sonra "Kaydedildi"', lateOn === true);

    // A refusal from the bot is shown as it is.
    await evaluate(
      cdp,
      `(() => { const s = ${row('karsilama.otorol-1')}.querySelector('select'); s.value = '${RL.moderator}'; s.dispatchEvent(new Event('change')); })()`,
    );
    await evaluate(cdp, `${row('karsilama.otorol-1')}.querySelector('.btn.primary').click()`);
    await waitFor(cdp, `${row('karsilama.otorol-1')}.querySelector('.set-status.bad') !== null`, 20_000, 'ret');
    const refusal = await evaluate(cdp, `${row('karsilama.otorol-1')}.querySelector('.set-status').textContent`);
    check('Botun reddi Türkçe gösterildi', /ayarlayamazsınız/.test(refusal), refusal);

    // The main process refuses a role the bot cannot give, even if the window tried.
    const direct = await evaluate(
      cdp,
      `window.muzik.saveServerSetting({ guildId: '${GUILD}', modul: 'karsilama', alan: 'otorol-1', deger: '${RL.yonetim}' })`,
    );
    check('Ana süreç verilemeyen rolü reddetti', direct.ok === false && /verilemez/.test(direct.hata), direct.hata);
    const unknown = await evaluate(
      cdp,
      `window.muzik.saveServerSetting({ guildId: '${GUILD}', modul: 'karsilama', alan: 'constructor', deger: true })`,
    );
    check('Ana süreç ayrılmış adı reddetti', unknown.ok === false, unknown.hata);

    // A change made in Discord (/ayar) arrives through ayarlar-gorunum.json and redraws the screen.
    view.sunucular[GUILD].degerler['seviye.acik'] = false;
    fs.writeFileSync(
      path.join(dataDir, 'ayarlar-gorunum.json'),
      JSON.stringify({ ...view, guncellendi: new Date().toISOString() }),
    );
    await waitFor(cdp, `${row('seviye.acik')}.querySelector('input').checked === false`, 15_000, 'Discord değişikliği');
    check("Discord'dan yapılan değişiklik ekrana geldi", true);

    // Screenshot: the Karşılama card after saving.
    await evaluate(cdp, "document.querySelector('[data-modul=karsilama]').scrollIntoView({ block: 'start' })");
    await evaluate(cdp, "document.querySelector('main.content').scrollBy(0, -70)");
    await sleep(500);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.result.data, 'base64'));
    console.log(`Ekran görüntüsü: ${SHOT}`);

    // Bot off: a warning and nothing can be saved.
    running = false;
    writeStatus();
    await waitFor(cdp, "Boolean(document.querySelector('#settings-bot-off'))", 15_000, 'bot kapalı uyarısı');
    const offState = await evaluate(
      cdp,
      `({ text: document.querySelector('#settings-bot-off').textContent, disabled: [...document.querySelectorAll('#server-settings .set-actions .btn.primary')].every((b) => b.disabled) })`,
    );
    const offSave = await evaluate(
      cdp,
      `window.muzik.saveServerSetting({ guildId: '${GUILD}', modul: 'karsilama', alan: 'hosgeldin-kart', deger: false })`,
    );
    check(
      'Bot kapalıyken uyarı var ve kaydedilemiyor',
      offState.text === 'Bot kapalı; ayarlar bot açıkken uygulanır.' && offState.disabled && offSave.botKapali === true,
      offSave.hata,
    );
    check('Bot kapalıyken istek dosyası yazılmadı', fs.readdirSync(path.join(dataDir, 'istekler')).length === 0);
    cdp.ws.close();
  } finally {
    clearInterval(keepAlive);
    bot?.stop();
    if (app?.pid) winproc.killTreeSync(app.pid);
    await sleep(1000);
    fs.rmSync(work, { recursive: true, force: true });
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
