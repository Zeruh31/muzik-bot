'use strict';

// End-to-end check of the desktop app against a THROWAWAY copy of the project:
//  - a temporary project folder (copied src/scripts, hard-linked Lavalink.jar, node_modules
//    junction) with a fake .env: fake Discord token, Lavalink on port 2444, panel on 3010
//  - its own user-data folder, so the real app settings and single-instance lock are untouched
//  - drives the real window through the Chrome DevTools protocol (clicks the buttons)
// Proves: Start -> Lavalink ready -> bot shows the invalid-token error in Turkish -> Stop,
// no java/node children left, no console window opened, children die when the app crashes.
// Never touches the real .env, port 2333 or a running bot.
//
// Usage: node scripts/e2e.js [outputFolder]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const winproc = require('../src/main/winproc');

const DESKTOP = path.join(__dirname, '..');
const PROJECT = path.join(DESKTOP, '..');
const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'muzikbot-e2e-cikti'));
// E2E_EXE=<packaged "Müzik Bot.exe"> tests the built app instead of development mode.
const ELECTRON = process.env.E2E_EXE
  ? path.resolve(process.env.E2E_EXE)
  : path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const APP_EXE = path.basename(ELECTRON);
const CDP_PORT = 9339;
const LAVALINK_PORT = 2444;
const PANEL_PORT = 3010;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { steps: [], checks: [], screenshots: [] };
// What to clean up if the run fails half-way.
const cleanup = { work: null, appPid: null, monitor: null, stopFile: null };
function step(text) {
  const line = `[${new Date().toLocaleTimeString('tr-TR')}] ${text}`;
  report.steps.push(line);
  console.log(line);
}
function check(name, ok, detail = '') {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${name}${detail ? ` - ${detail}` : ''}`);
}

// ---- processes -------------------------------------------------------------------------

async function processList() {
  const names = ['java.exe', 'node.exe', 'electron.exe', 'powershell.exe', APP_EXE]
    .map((n) => `Name='${n}'`)
    .join(' or ');
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "${names}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
  const result = await winproc.runPowerShell(script, { encoding: 'utf8', timeoutMs: 30_000 });
  const parsed = JSON.parse(result.stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    name: p.Name,
    cmd: String(p.CommandLine ?? '').slice(0, 220),
  }));
}

/** java/node children of the app, without the watchdog (a node.exe that must stay). */
const isWorker = (p) => ['java.exe', 'node.exe'].includes(p.name) && !/watchdog\.js/.test(p.cmd);

function descendants(list, rootPid) {
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const p of list) {
      if (p.ppid === pid && !out.includes(p)) {
        out.push(p);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

// ---- DevTools protocol -------------------------------------------------------------------

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
        let id = 0;
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
            id += 1;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
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

async function screenshot(cdp, name) {
  await sleep(400);
  const msg = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `desktop-ekran-${name}.png`);
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  report.screenshots.push(file);
  step(`Ekran görüntüsü: ${file}`);
}

const status = (cdp) => evaluate(cdp, 'window.muzik.status()');

async function waitStatus(cdp, predicate, ms, label) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await status(cdp);
    if (predicate(last)) return last;
    await sleep(500);
  }
  throw new Error(`Zaman aşımı: ${label} (son durum: lavalink=${last?.lavalink.state} bot=${last?.bot.state})`);
}

// ---- temporary project ----------------------------------------------------------------------

function makeTempProject(work) {
  const proj = path.join(work, 'proje');
  fs.mkdirSync(path.join(proj, 'lavalink'), { recursive: true });
  for (const item of ['src', 'scripts', 'package.json', '.env.example']) {
    fs.cpSync(path.join(PROJECT, item), path.join(proj, item), { recursive: true });
  }
  fs.copyFileSync(path.join(PROJECT, 'lavalink', 'application.yml'), path.join(proj, 'lavalink', 'application.yml'));
  fs.cpSync(path.join(PROJECT, 'lavalink', 'plugins'), path.join(proj, 'lavalink', 'plugins'), { recursive: true });
  try {
    fs.linkSync(path.join(PROJECT, 'lavalink', 'Lavalink.jar'), path.join(proj, 'lavalink', 'Lavalink.jar'));
  } catch {
    fs.copyFileSync(path.join(PROJECT, 'lavalink', 'Lavalink.jar'), path.join(proj, 'lavalink', 'Lavalink.jar'));
  }
  fs.symlinkSync(path.join(PROJECT, 'node_modules'), path.join(proj, 'node_modules'), 'junction');
  const env = fs
    .readFileSync(path.join(PROJECT, '.env.example'), 'utf8')
    .replace(/^DISCORD_TOKEN=.*$/m, 'DISCORD_TOKEN=sahte.discord.tokeni.e2e')
    .replace(/^DISCORD_CLIENT_ID=.*$/m, 'DISCORD_CLIENT_ID=123456789012345678')
    .replace(/^LAVALINK_PASSWORD=.*$/m, 'LAVALINK_PASSWORD=e2e-sifre-12345')
    .replace(/^LAVALINK_PORT=.*$/m, `LAVALINK_PORT=${LAVALINK_PORT}`)
    .replace(/^DISCORD_CLIENT_SECRET=.*$/m, 'DISCORD_CLIENT_SECRET=sahte-gizli-anahtar')
    .replace(/^PANEL_PORT=.*$/m, `PANEL_PORT=${PANEL_PORT}`)
    .replace(/^PANEL_PUBLIC_URL=.*$/m, `PANEL_PUBLIC_URL=http://127.0.0.1:${PANEL_PORT}`);
  fs.writeFileSync(path.join(proj, '.env'), env);
  return proj;
}

function removeTempProject(work) {
  try {
    fs.rmdirSync(path.join(work, 'proje', 'node_modules')); // the junction only, never its target
  } catch {
    // already gone
  }
  fs.rmSync(work, { recursive: true, force: true });
}

/** A made-up data/durum.json (the fake-token bot never logs in, so it writes none itself). */
function fakeStatus({ running = true, tick = 0 } = {}) {
  const now = Date.now();
  const server = (i, name, extra = {}) => ({
    id: String(100000000000000000n + BigInt(i)),
    name,
    iconUrl: null,
    memberCount: 10 + i * 37,
    joinedAt: new Date(Date.UTC(2025, i % 12, 1 + i)).toISOString(),
    djRole: i % 3 === 0,
    voice: null,
    playing: null,
    queueLength: 0,
    repeatMode: 'off',
    volume: null,
    songsPlayed: i * 4,
    ...extra,
  });
  return {
    schemaVersion: 1,
    updatedAt: new Date(now).toISOString(),
    running,
    pid: process.pid, // a live process, as a running bot would be
    bot: {
      username: 'Müzik Bot#0001',
      id: '900000000000000001',
      avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
      startedAt: new Date(now - 5 * 3600_000).toISOString(),
      uptimeMs: 5 * 3600_000 + tick * 15_000,
      pingMs: [62, 75, 58, 91, 70][tick % 5],
      guildCount: 6,
      memberCount: 1342,
      memory: { rss: (118 + tick * 3) * 1048576, heapUsed: 60 * 1048576, heapTotal: 90 * 1048576 },
      versions: { node: 'v24.16.0', discordJs: '14.28.1' },
    },
    lavalink: {
      connected: true,
      version: '4.2.2',
      players: 3,
      playingPlayers: 1 + (tick % 2),
      uptimeMs: 4 * 3600_000,
      cpuLoad: 0.031,
      memoryUsed: 210 * 1048576,
    },
    sayaclar: {
      toplam: {
        songsPlayed: 1287,
        commandsUsed: 2140,
        commands: {
          play: 980,
          skip: 402,
          queue: 233,
          pause: 150,
          volume: 96,
          nowplaying: 88,
          stop: 71,
          lyrics: 40,
          shuffle: 22,
        },
        topSongs: [
          { title: 'Barış Manço - Gülpembe', uri: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', count: 42 },
          { title: 'Sezen Aksu - Firuze', uri: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', count: 37 },
          { title: 'MFÖ - Ele Güne Karşı', uri: 'https://www.youtube.com/watch?v=ccccccccccc', count: 29 },
          { title: 'Tarkan - Kuzu Kuzu', uri: null, count: 21 },
        ],
        songsByGuild: {},
      },
      oturum: { songsPlayed: 23, commandsUsed: 41, commands: { play: 20 }, topSongs: [], songsByGuild: {} },
    },
    sunucular: [
      server(1, 'Müzik Kulübü', {
        iconUrl: 'https://cdn.discordapp.com/embed/avatars/1.png',
        voice: { channelName: 'Sohbet & Müzik', listeners: 4 },
        playing: {
          title: 'Barış Manço - Gülpembe',
          author: 'Barış Manço',
          uri: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
          positionMs: 74_000,
          durationMs: 262_000,
          isStream: false,
          paused: false,
        },
        queueLength: 7,
        repeatMode: 'queue',
        volume: 80,
      }),
      server(2, '<img src=x onerror=alert(1)> Deneme'),
      server(3, 'İstanbul Oyuncuları', {
        voice: { channelName: 'Lobi', listeners: 2 },
        playing: {
          title: 'Sezen Aksu - Firuze',
          author: 'Sezen Aksu',
          uri: null,
          positionMs: 30_000,
          durationMs: 250_000,
          isStream: false,
          paused: true,
        },
        queueLength: 2,
        volume: 60,
      }),
      server(4, 'ankara dev ekibi'),
      server(5, 'Çay Ocağı', { iconUrl: 'https://cdn.discordapp.com/embed/avatars/3.png' }),
      server(6, 'Gece Kuşları'),
    ],
  };
}

async function listenerPid(port) {
  return (await winproc.findListeningPids(port))[0] ?? null;
}

// ---- main ---------------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // E2E_WORK_DIR=<empty or missing folder> puts the throwaway project there (e.g. a neutral path
  // for documentation screenshots, which show the project folder); default: a new temp folder.
  const work = process.env.E2E_WORK_DIR
    ? path.resolve(process.env.E2E_WORK_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-e2e-'));
  if (process.env.E2E_WORK_DIR) {
    if (fs.existsSync(work) && fs.readdirSync(work).length) throw new Error(`E2E_WORK_DIR boş olmalı: ${work}`);
    fs.mkdirSync(work, { recursive: true });
  }
  cleanup.work = work;
  const proj = makeTempProject(work);
  const userData = path.join(work, 'veri');
  step(`Geçici proje: ${proj}`);

  const userLavalink = await listenerPid(2333);
  const userPanel = await listenerPid(3000);
  step(
    `Kullanıcının süreçleri (dokunulmayacak): 2333 -> PID ${userLavalink ?? 'yok'}, 3000 -> PID ${userPanel ?? 'yok'}`,
  );
  check(
    '2444 ve 3010 portları test öncesi boş',
    !(await winproc.isPortInUse(LAVALINK_PORT)) && !(await winproc.isPortInUse(PANEL_PORT)),
  );

  // Console-window monitor
  const windowsOut = path.join(work, 'pencereler.json');
  const stopFile = path.join(work, 'pencere-izleme.dur');
  const monitor = spawn(
    path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'e2e-windows.ps1'),
      '-OutFile',
      windowsOut,
      '-StopFile',
      stopFile,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  cleanup.monitor = monitor;
  cleanup.stopFile = stopFile;
  await sleep(2500);

  const env = { ...process.env, MUZIKBOT_PROJECT_DIR: proj, MUZIKBOT_DESKTOP_USERDATA: userData };
  const appArgs = process.env.E2E_EXE
    ? [`--remote-debugging-port=${CDP_PORT}`]
    : ['.', `--remote-debugging-port=${CDP_PORT}`];
  let app = spawn(ELECTRON, appArgs, { cwd: DESKTOP, env, stdio: 'ignore' });
  step(`Çalıştırılan: ${ELECTRON}`);
  cleanup.appPid = app.pid;
  step(`Uygulama açıldı (${process.env.E2E_EXE ? 'paketlenmiş exe' : 'geliştirme modu'}), PID ${app.pid}`);
  let cdp = await connectCdp();
  await evaluate(
    cdp,
    'new Promise((r) => { const t = () => (window.muzik && document.readyState === "complete" ? r(true) : setTimeout(t, 100)); t(); })',
  );
  await sleep(800);
  await screenshot(cdp, '1-acilis');

  // ---- Start -------------------------------------------------------------------------------
  step('Başlat düğmesine basılıyor');
  await evaluate(cdp, "document.querySelector('#power').click()");
  let sawCode = false;
  const startDeadline = Date.now() + 240_000;
  let s;
  while (Date.now() < startDeadline) {
    s = await status(cdp);
    if (!sawCode && s.youtube.phase === 'code') {
      sawCode = true;
      step(`YouTube giriş kodu yakalandı: ${s.youtube.code}`);
      await screenshot(cdp, '2-youtube-kodu');
      await evaluate(cdp, "document.querySelector('#yt-close').click()");
    }
    if (s.lavalink.state === 'ready' && ['error', 'ready'].includes(s.bot.state) && !s.busy) break;
    if (s.lavalink.state === 'error') break;
    await sleep(500);
  }
  check('Lavalink hazır', s.lavalink.state === 'ready', `durum=${s.lavalink.state} ${s.lavalink.error ?? ''}`);
  check(
    'Bot hata durumunda ve hata Türkçe',
    s.bot.state === 'error' && /geçersiz|bağlanılamadı/.test(s.bot.error ?? ''),
    s.bot.error ?? s.bot.state,
  );
  check('YouTube giriş kodu yakalandı', sawCode, s.youtube.code ?? '');
  const heroError = await evaluate(cdp, "document.querySelector('#hero-error').textContent");
  check('Hata ana ekranda gösteriliyor', /Bot: Discord/.test(heroError ?? ''), heroError);
  await screenshot(cdp, '3-token-hatasi');

  const running = await processList();
  const children = descendants(running, app.pid).filter(isWorker);
  report.processesWhileRunning = children;
  const javaChild = children.find((p) => p.name === 'java.exe');
  check('java.exe uygulamanın çocuğu olarak çalışıyor', Boolean(javaChild), javaChild ? `PID ${javaChild.pid}` : '');

  // Logs view
  await evaluate(cdp, "document.querySelector('[data-view=logs]').click()");
  await screenshot(cdp, '4-kayitlar');
  const logText = await evaluate(cdp, "document.querySelector('#log-list').textContent");
  check(
    'Kayıtlarda token ve şifre görünmüyor',
    !/sahte\.discord\.tokeni|e2e-sifre-12345|sahte-gizli-anahtar/.test(logText ?? ''),
  );

  // Settings: save through the form into the TEMPORARY .env
  await evaluate(cdp, "document.querySelector('[data-view=settings]').click()");
  await sleep(800);
  const envFile = path.join(proj, '.env');
  const before = fs.readFileSync(envFile, 'utf8');
  await evaluate(
    cdp,
    "(() => { const i = document.getElementById('f-DEFAULT_VOLUME'); i.value = '95'; i.dispatchEvent(new Event('input', { bubbles: true })); const j = document.getElementById('f-LAVALINK_JAVA_MEMORY'); j.value = '600M'; j.dispatchEvent(new Event('input', { bubbles: true })); })()",
  );
  await evaluate(cdp, "document.querySelector('#env-save').click()");
  await sleep(1200);
  const after = fs.readFileSync(envFile, 'utf8');
  const strip = (t) => t.split(/\r?\n/).filter((l) => !/^(DEFAULT_VOLUME|LAVALINK_JAVA_MEMORY)=/.test(l));
  check(
    'Ayar formu yorumları ve sırayı koruyarak yazdı',
    JSON.stringify(strip(before)) === JSON.stringify(strip(after)) &&
      /^DEFAULT_VOLUME=95$/m.test(after) &&
      /^LAVALINK_JAVA_MEMORY=600M$/m.test(after),
  );
  const banner = await evaluate(cdp, "document.querySelector('#banners').textContent");
  check('"Yeniden başlatılması gerekiyor" uyarısı çıktı', /yeniden başlatılmalı/.test(banner ?? ''), banner);
  await screenshot(cdp, '5-ayarlar');

  // Tools: setup check
  await evaluate(cdp, "document.querySelector('[data-view=tools]').click()");
  await evaluate(cdp, "document.querySelector('#tool-check').click()");
  await evaluate(
    cdp,
    "new Promise((r) => { const t = () => (document.querySelector('#tool-check-result .check-list') ? r(true) : setTimeout(t, 200)); t(); })",
  );
  const checkItems = await evaluate(cdp, "document.querySelectorAll('#tool-check-result .check-list li').length");
  check('Kurulum kontrolü listelendi', checkItems > 3, `${checkItems} madde`);
  await screenshot(cdp, '6-araclar');

  // ---- Stop ---------------------------------------------------------------------------------
  await evaluate(cdp, "document.querySelector('[data-view=home]').click()");
  step('Durdur düğmesine basılıyor');
  await evaluate(cdp, "document.querySelector('#power').click()");
  s = await waitStatus(
    cdp,
    (x) => x.lavalink.state === 'stopped' && x.bot.state === 'stopped' && !x.busy,
    60_000,
    'durdurma',
  );
  await screenshot(cdp, '7-durduruldu');
  const appLogs = await evaluate(cdp, 'window.muzik.logs()');
  const forced = appLogs.filter((e) => e.source === 'app' && /zorla kapatılıyor/.test(e.text));
  check(
    'Lavalink düzgünce (Ctrl+C ile) kapandı, zorla öldürülmedi',
    forced.length === 0,
    forced.map((e) => e.text).join(' | '),
  );
  await sleep(1000);
  const afterStop = await processList();
  const leftovers = descendants(afterStop, app.pid).filter(isWorker);
  const stillThere = children.filter((c) => afterStop.some((p) => p.pid === c.pid));
  report.processesAfterStop = descendants(afterStop, app.pid);
  check(
    'Durdurduktan sonra java/node çocuk süreci kalmadı',
    leftovers.length === 0 && stillThere.length === 0,
    JSON.stringify(leftovers),
  );
  check('2444 portu kapandı', !(await winproc.isPortInUse(LAVALINK_PORT)));

  // ---- Servers and statistics from a fake data/durum.json ------------------------------------------
  step('Sahte data/durum.json yazılıyor (Sunucular ve İstatistikler sekmeleri)');
  const statusFile = path.join(proj, 'data', 'durum.json');
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  for (let tick = 0; tick < 5; tick += 1) {
    fs.writeFileSync(statusFile, JSON.stringify(fakeStatus({ tick })));
    await sleep(1200);
  }
  await evaluate(cdp, "document.querySelector('[data-view=servers]').click()");
  await sleep(600);
  const servers = await evaluate(
    cdp,
    "({ cards: document.querySelectorAll('#server-grid .server-card').length, injected: document.querySelectorAll('#server-grid img[onerror], #server-grid img[src=\"x\"]').length, text: document.querySelector('#server-grid').textContent, stale: document.querySelector('#servers-stale').classList.contains('hidden') })",
  );
  check('Sunucular sekmesi 6 sunucuyu gösteriyor', servers.cards === 6, `${servers.cards} kart`);
  check(
    'Sunucu adı metin olarak gösteriliyor (HTML çalışmadı)',
    servers.injected === 0 && servers.text.includes('<img src=x onerror=alert(1)> Deneme'),
  );
  check('Canlı veride "Bot kapalı" notu yok', servers.stale === true);
  await evaluate(
    cdp,
    "(() => { const s = document.getElementById('server-search'); s.value = 'istanbul'; s.dispatchEvent(new Event('input')); })()",
  );
  const searched = await evaluate(cdp, "document.querySelectorAll('#server-grid .server-card').length");
  check('Sunucu araması çalışıyor (Türkçe İ)', searched === 1, `${searched} sonuç`);
  await evaluate(
    cdp,
    "(() => { const s = document.getElementById('server-search'); s.value = ''; s.dispatchEvent(new Event('input')); const o = document.getElementById('server-sort'); o.value = 'members'; o.dispatchEvent(new Event('change')); })()",
  );
  await evaluate(
    cdp,
    "[...document.querySelectorAll('#server-grid .server-card')].find((c) => c.textContent.includes('Müzik Kulübü')).click()",
  );
  const detail = await evaluate(cdp, "document.querySelector('#server-detail').textContent");
  check(
    'Sunucu ayrıntısı: çalan şarkı, kuyruk, dinleyici, DJ',
    /Gülpembe/.test(detail) && /7 şarkı/.test(detail) && /4 dinleyici/.test(detail) && /DJ rolü/.test(detail),
    detail.slice(0, 160),
  );
  await sleep(1200);
  const shotServers = path.join(OUT, 'desktop-ekran-sunucular.png');
  await screenshot(cdp, 'sunucular');

  await evaluate(cdp, "document.querySelector('[data-view=stats]').click()");
  await sleep(600);
  const stats = await evaluate(
    cdp,
    "({ tiles: document.querySelectorAll('#stat-tiles .tile').length, charts: document.querySelectorAll('.charts svg polyline').length, commands: document.querySelectorAll('#top-commands li').length, songs: document.querySelectorAll('#top-songs li').length })",
  );
  check(
    'İstatistikler: kutucuklar, 3 grafik, listeler',
    stats.tiles >= 9 && stats.charts === 3 && stats.commands === 9 && stats.songs === 4,
    JSON.stringify(stats),
  );
  await screenshot(cdp, 'istatistik');
  const homeBot = await evaluate(cdp, "document.querySelector('#card-bot').textContent");
  check(
    'Ana ekranda "Kapalı/Hata" ile "şu an N sunucuda çalıyor" birlikte görünmüyor',
    !/sunucuda çalıyor/.test(homeBot),
    homeBot.replace(/\s+/g, ' ').trim(),
  );

  // A bot killed without writing "running": false: its PID is gone, so the data is "last known" at once.
  const dead = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  fs.writeFileSync(statusFile, JSON.stringify({ ...fakeStatus({ tick: 6 }), pid: dead.pid }));
  await sleep(1500);
  const beforeKill = await evaluate(cdp, "document.querySelector('#stats-stale').classList.contains('hidden')");
  dead.kill();
  await sleep(500);
  fs.writeFileSync(
    statusFile,
    JSON.stringify({ ...fakeStatus({ tick: 6 }), pid: dead.pid, bot: { ...fakeStatus().bot, pingMs: 99 } }),
  );
  await sleep(1500);
  const afterKillNote = await evaluate(cdp, "document.querySelector('#stats-stale').textContent");
  check(
    'Zorla öldürülen bot: veri hemen "son bilinen" sayılıyor',
    beforeKill === true && /Bot kapalı, son bilinen veriler/.test(afterKillNote),
    afterKillNote,
  );

  fs.writeFileSync(statusFile, JSON.stringify(fakeStatus({ running: false, tick: 5 })));
  await sleep(1500);
  const staleNote = await evaluate(cdp, "document.querySelector('#stats-stale').textContent");
  check('Bot kapalıyken "son bilinen veriler" notu', /Bot kapalı, son bilinen veriler/.test(staleNote), staleNote);
  fs.rmSync(statusFile);
  report.statusScreenshots = [shotServers, path.join(OUT, 'desktop-ekran-istatistik.png')];
  await evaluate(cdp, "document.querySelector('[data-view=home]').click()");

  // ---- Durdur while Lavalink is still starting -------------------------------------------------
  step('Başlat, Lavalink açılırken hemen Durdur');
  await evaluate(cdp, "document.querySelector('#power').click()");
  await waitStatus(cdp, (x) => x.busy === 'starting', 10_000, 'başlatma sürüyor');
  const powerWhileStarting = await evaluate(
    cdp,
    "({ disabled: document.querySelector('#power').disabled, label: document.querySelector('#power-label').textContent })",
  );
  check(
    'Açılırken Durdur düğmesi kullanılabilir',
    !powerWhileStarting.disabled && powerWhileStarting.label === 'Durdur',
    JSON.stringify(powerWhileStarting),
  );
  await evaluate(cdp, "document.querySelector('#power').click()");
  s = await waitStatus(
    cdp,
    (x) => x.lavalink.state === 'stopped' && x.bot.state === 'stopped' && !x.busy,
    60_000,
    'açılırken durdurma',
  );
  await sleep(800);
  const afterCancel = descendants(await processList(), app.pid).filter(isWorker);
  check(
    'Açılırken Durdur: başlatma iptal edildi, çocuk süreç yok, hata yok',
    afterCancel.length === 0 && !s.lastError,
    JSON.stringify(afterCancel),
  );

  // ---- Crash test ---------------------------------------------------------------------------
  step('Çökme testi: yeniden başlatılıyor, sonra uygulama zorla öldürülecek');
  await evaluate(cdp, "document.querySelector('#power').click()");
  s = await waitStatus(cdp, (x) => x.lavalink.state === 'ready', 240_000, 'Lavalink hazır (çökme testi)');
  const crashList = await processList();
  const crashChildren = descendants(crashList, app.pid).filter(isWorker);
  const watchdogProc = descendants(crashList, app.pid).find((p) => /watchdog\.js/.test(p.cmd));
  check('Süreç koruyucu (watchdog) çalışıyor', Boolean(watchdogProc), watchdogProc ? `PID ${watchdogProc.pid}` : '');
  cdp.ws.close();
  await winproc.run(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(app.pid), '/F']);
  step(
    `Uygulamanın ana süreci (PID ${app.pid}) zorla öldürüldü; çocuk süreçler: ${crashChildren.map((c) => `${c.name}:${c.pid}`).join(', ')}`,
  );
  let orphans = crashChildren;
  for (let i = 0; i < 30 && orphans.length; i += 1) {
    await sleep(500);
    const now = await processList();
    orphans = crashChildren.filter((c) => now.some((p) => p.pid === c.pid && p.name === c.name));
  }
  check('Uygulama çökünce java/node yetim kalmadı', orphans.length === 0, JSON.stringify(orphans));

  // Make sure nothing of this run survives, whatever happened above.
  const final = await processList();
  const ours = final.filter(
    // The console-window monitor is this script's own helper; it is stopped further down.
    (p) =>
      p.pid !== monitor.pid && (p.cmd.includes(work) || (p.name === APP_EXE && p.cmd.includes(path.dirname(ELECTRON)))),
  );
  for (const p of ours) winproc.killTreeSync(p.pid);
  check('Test sonunda bu teste ait süreç yok', ours.length === 0, JSON.stringify(ours));
  report.finalProcesses = final
    .filter((p) => ['java.exe', 'node.exe'].includes(p.name))
    .map((p) => ({ ...p, cmd: p.cmd.slice(0, 120) }));
  step(`Son süreç listesi (java/node): ${report.finalProcesses.map((p) => `${p.name}:${p.pid}`).join(', ')}`);

  // User's processes untouched
  check(
    'Kullanıcının 2333 Lavalink süreci hâlâ çalışıyor',
    !userLavalink || winproc.isAlive(userLavalink),
    `PID ${userLavalink}`,
  );
  check('Kullanıcının botu (3000) hâlâ çalışıyor', !userPanel || winproc.isAlive(userPanel), `PID ${userPanel}`);

  // Console windows
  fs.writeFileSync(stopFile, '');
  for (let i = 0; i < 40 && !fs.existsSync(windowsOut); i += 1) await sleep(250);
  const windows = JSON.parse(fs.readFileSync(windowsOut, 'utf8').replace(/^﻿/, ''));
  report.windowMonitor = windows;
  check(
    'Hiç konsol penceresi açılmadı',
    (windows.consoleWindows ?? []).length === 0,
    `${windows.samples} örnek, bulunan: ${JSON.stringify(windows.consoleWindows)}`,
  );
  monitor.kill();

  // Keep the app's own logs as evidence, then clean up.
  const logDir = path.join(userData, 'kayitlar');
  if (fs.existsSync(logDir)) fs.cpSync(logDir, path.join(OUT, 'e2e-kayitlar'), { recursive: true });
  removeTempProject(work);
  app = null;

  const failed = report.checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(OUT, 'e2e-rapor.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n${report.checks.length - failed.length}/${report.checks.length} kontrol geçti. Rapor: ${path.join(OUT, 'e2e-rapor.json')}`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
  // Kill only what this run started: the app tree and processes running from the temp folder.
  if (cleanup.stopFile) fs.writeFileSync(cleanup.stopFile, '');
  cleanup.monitor?.kill();
  if (cleanup.appPid) winproc.killTreeSync(cleanup.appPid);
  if (cleanup.work) {
    for (const p of await processList().catch(() => [])) if (p.cmd.includes(cleanup.work)) winproc.killTreeSync(p.pid);
    await sleep(1000);
    removeTempProject(cleanup.work);
  }
  fs.writeFileSync(
    path.join(OUT, 'e2e-rapor.json'),
    JSON.stringify({ ...report, error: String(error?.stack ?? error) }, null, 2),
  );
});
