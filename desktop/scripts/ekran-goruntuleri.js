'use strict';

// Takes the README screenshots (docs/ekran-*.png) with made-up data only:
//  - a throwaway project folder (default C:\MuzikBot-demo, shown in the sidebar) whose .env has
//    fake values and the default ports (Lavalink 2333, panel 3000)
//  - nothing is started: no Lavalink, no bot, so a real bot on those ports is never disturbed
//  - servers and statistics come from a fake data/durum.json, the YouTube dialog from a
//    made-up code; no real Discord, Google or user data ends up in the images
//
// Usage: node scripts/ekran-goruntuleri.js [outputFolder] [demoProjectFolder]

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const winproc = require('../src/main/winproc');

const DESKTOP = path.join(__dirname, '..');
const PROJECT = path.join(DESKTOP, '..');
const OUT = path.resolve(process.argv[2] || path.join(PROJECT, 'docs'));
const WORK = path.resolve(process.argv[3] || 'C:\\MuzikBot-demo');
const ELECTRON = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron.exe');
const CDP_PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeStatus(tick) {
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
    running: true,
    pid: process.pid, // a live process, as a running bot would be
    bot: {
      username: 'Müzik Bot#0001',
      id: '900000000000000001',
      avatarUrl: null,
      startedAt: new Date(now - 5 * 3600_000).toISOString(),
      uptimeMs: 5 * 3600_000 + tick * 15_000,
      pingMs: [62, 75, 58, 91, 70, 66][tick % 6],
      guildCount: 6,
      memberCount: 1342,
      memory: { rss: (118 + tick * 4) * 1048576, heapUsed: 60 * 1048576, heapTotal: 90 * 1048576 },
      versions: { node: 'v24.16.0', discordJs: '14.28.1' },
    },
    lavalink: {
      connected: true,
      version: '4.2.2',
      players: 3,
      playingPlayers: [1, 2, 2, 1, 2, 2][tick % 6],
      uptimeMs: 4 * 3600_000,
      cpuLoad: 0.031,
      memoryUsed: 210 * 1048576,
    },
    sayaclar: {
      toplam: {
        songsPlayed: 1287,
        commandsUsed: 2140,
        commands: { play: 980, skip: 402, queue: 233, pause: 150, volume: 96, nowplaying: 88, stop: 71, lyrics: 40 },
        topSongs: [
          { title: 'Barış Manço - Gülpembe', uri: null, count: 42 },
          { title: 'Sezen Aksu - Firuze', uri: null, count: 37 },
          { title: 'MFÖ - Ele Güne Karşı', uri: null, count: 29 },
          { title: 'Tarkan - Kuzu Kuzu', uri: null, count: 21 },
        ],
        songsByGuild: {},
      },
      oturum: { songsPlayed: 23, commandsUsed: 41, commands: { play: 20 }, topSongs: [], songsByGuild: {} },
    },
    sunucular: [
      server(1, 'Müzik Kulübü', {
        voice: { channelName: 'Sohbet & Müzik', listeners: 4 },
        playing: {
          title: 'Barış Manço - Gülpembe',
          author: 'Barış Manço',
          uri: null,
          positionMs: 74_000,
          durationMs: 262_000,
          isStream: false,
          paused: false,
        },
        queueLength: 7,
        repeatMode: 'queue',
        volume: 80,
      }),
      server(2, 'Kitap Kurtları'),
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
      server(4, 'Ankara Yazılımcılar'),
      server(5, 'Çay Ocağı'),
      server(6, 'Gece Kuşları'),
    ],
  };
}

function makeDemoProject() {
  if (fs.existsSync(WORK) && fs.readdirSync(WORK).length) throw new Error(`Klasör boş olmalı: ${WORK}`);
  const proj = path.join(WORK, 'proje');
  fs.mkdirSync(path.join(proj, 'lavalink'), { recursive: true });
  for (const item of ['src', 'scripts', 'package.json', '.env.example']) {
    fs.cpSync(path.join(PROJECT, item), path.join(proj, item), { recursive: true });
  }
  fs.copyFileSync(path.join(PROJECT, 'lavalink', 'application.yml'), path.join(proj, 'lavalink', 'application.yml'));
  const env = fs
    .readFileSync(path.join(PROJECT, '.env.example'), 'utf8')
    .replace(/^DISCORD_TOKEN=.*$/m, 'DISCORD_TOKEN=ornek.token.degeri.gizli')
    .replace(/^DISCORD_CLIENT_ID=.*$/m, 'DISCORD_CLIENT_ID=123456789012345678')
    .replace(/^LAVALINK_PASSWORD=.*$/m, 'LAVALINK_PASSWORD=ornek-sifre-12345')
    .replace(/^LAVALINK_PORT=.*$/m, 'LAVALINK_PORT=2333')
    .replace(/^PANEL_PORT=.*$/m, 'PANEL_PORT=3000')
    .replace(/^PANEL_PUBLIC_URL=.*$/m, 'PANEL_PUBLIC_URL=http://127.0.0.1:3000');
  fs.writeFileSync(path.join(proj, '.env'), env);
  fs.mkdirSync(path.join(proj, 'data'));
  return proj;
}

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
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
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

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const proj = makeDemoProject();
  const statusFile = path.join(proj, 'data', 'durum.json');
  fs.writeFileSync(statusFile, JSON.stringify(fakeStatus(0)));

  const env = { ...process.env, MUZIKBOT_PROJECT_DIR: proj, MUZIKBOT_DESKTOP_USERDATA: path.join(WORK, 'veri') };
  const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${CDP_PORT}`], { cwd: DESKTOP, env, stdio: 'ignore' });
  try {
    const cdp = await connectCdp();
    const evaluate = async (expression) =>
      (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result
        ?.value;
    const shot = async (name) => {
      await sleep(700);
      const msg = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `ekran-${name}.png`);
      fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
      console.log(file);
    };
    await evaluate(
      'new Promise((r) => { const t = () => (window.muzik && status ? r(true) : setTimeout(t, 100)); t(); })',
    );

    // A few status updates so the charts have points.
    for (let tick = 1; tick < 6; tick += 1) {
      await sleep(1200);
      fs.writeFileSync(statusFile, JSON.stringify(fakeStatus(tick)));
    }
    await sleep(1500);

    await shot('ana');
    await evaluate("document.querySelector('[data-view=servers]').click()");
    await evaluate(
      "(() => { const o = document.getElementById('server-sort'); o.value = 'members'; o.dispatchEvent(new Event('change')); })()",
    );
    await evaluate(
      "[...document.querySelectorAll('#server-grid .server-card')].find((c) => c.textContent.includes('Müzik Kulübü')).click()",
    );
    await shot('sunucular');
    await evaluate("document.querySelector('[data-view=stats]').click()");
    await shot('istatistik');
    await evaluate("document.querySelector('[data-view=settings]').click()");
    await shot('ayarlar');

    // YouTube sign-in dialog with a made-up code (no Lavalink, no request to Google).
    await evaluate("document.querySelector('[data-view=home]').click()");
    await evaluate(
      "status.youtube = { ...status.youtube, phase: 'code', code: 'ABCD-EFGH', url: 'https://www.google.com/device' }; openYoutubeModal(true);",
    );
    await shot('youtube');
    cdp.ws.close();
  } finally {
    winproc.killTreeSync(app.pid);
    await sleep(1000);
    fs.rmSync(WORK, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
