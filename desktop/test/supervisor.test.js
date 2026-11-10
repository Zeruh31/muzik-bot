'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Supervisor } = require('../src/main/supervisor');
const { LogStore } = require('../src/main/logStore');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeProject(envText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-sup-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'lavalink'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), '');
  fs.writeFileSync(path.join(dir, 'lavalink', 'Lavalink.jar'), '');
  fs.writeFileSync(path.join(dir, '.env'), envText);
  return dir;
}

function setup({
  envText,
  portInUse = false,
  listeners = [],
  name = 'node.exe',
  pidFile,
  commandLine = null,
  processes = [],
} = {}) {
  const projectDir = makeProject(
    envText ??
      'DISCORD_TOKEN=fake.token.valuexx\nDISCORD_CLIENT_ID=123456789012345678\nLAVALINK_PASSWORD=testpass123\nLAVALINK_PORT=2444\nPANEL_ENABLED=true\nYOUTUBE_OAUTH_REFRESH_TOKEN=\n',
  );
  const spawned = [];
  const order = [];
  const killed = [];
  let pid = 500;
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = pid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.command = command;
    child.args = args;
    child.options = options;
    child.exit = (code) => {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('exit', code, null));
    };
    spawned.push(child);
    return child;
  };
  const deps = {
    spawn,
    sendCtrlC: async (p) => {
      order.push(`stop ${spawned.find((c) => c.pid === p).command}`);
      spawned.find((c) => c.pid === p).exit(0);
      return true;
    },
    killTree: async (p) => {
      killed.push(p);
      spawned.find((c) => c.pid === p)?.exit(1);
    },
    isAlive: () => false,
    isPortInUse: async () => portInUse,
    findListeningPids: async () => listeners,
    processName: async () => name,
    processCommandLine: async () => (typeof commandLine === 'function' ? commandLine(projectDir) : commandLine),
    listProcesses: async () => (typeof processes === 'function' ? processes(projectDir) : processes),
    resolveJava: async () => ({ path: 'C:\\java\\bin\\java.exe', major: 21 }),
    resolveNode: async () => ({ path: 'C:\\node\\node.exe', major: 24 }),
  };
  const logs = new LogStore({});
  const supervisor = new Supervisor({
    getProjectDir: () => projectDir,
    logs,
    autoRestart: () => true,
    deps,
    pidFile,
    baseEnv: { PATH: 'C:\\x', ELECTRON_RUN_AS_NODE: '1' },
  });
  const cleanup = () => fs.rmSync(projectDir, { recursive: true, force: true });
  return { supervisor, spawned, order, killed, logs, projectDir, cleanup };
}

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout');
    await wait(5);
  }
}

test('start: Lavalink first, bot after "ready"; invalid token shown in Turkish; stop: bot then Lavalink', async () => {
  const { supervisor, spawned, order, logs, cleanup } = setup();
  try {
    const started = supervisor.startAll();
    await until(() => spawned.length === 1);
    const java = spawned[0];
    assert.equal(java.command, 'C:\\java\\bin\\java.exe');
    assert.deepEqual(java.args.slice(0, 1), ['-Xmx512M']);
    assert.equal(java.options.env.LAVALINK_PORT, '2444');
    assert.equal(java.options.env.LAVALINK_PASSWORD, 'testpass123');
    assert.equal(java.options.env.SPOTIFY_ENABLED, 'false');
    assert.equal(java.options.env.ELECTRON_RUN_AS_NODE, undefined, 'Electron switches are not passed on');
    assert.equal(java.options.windowsHide, true);
    assert.equal(supervisor.status().lavalink.state, 'starting');
    assert.equal(supervisor.status().youtube.phase, 'waiting');

    java.stdout.write(
      '2026-11-10T09:05:33.000+03:00  INFO 1 --- [Lavalink] [main] d.l.y.h.YoutubeOauth2Handler : OAUTH INTEGRATION: To give youtube-source access to your account, go to https://www.google.com/device and enter code ABC-DEF-GHI\n',
    );
    java.stdout.write(
      '2026-11-10T09:05:32.803+03:00  INFO 1 --- [Lavalink] [main] l.s.Launcher : Lavalink is ready to accept connections.\n',
    );
    await started;
    assert.equal(supervisor.status().youtube.code, 'ABC-DEF-GHI');
    assert.equal(spawned.length, 2, 'bot started after Lavalink was ready');
    const bot = spawned[1];
    assert.equal(bot.command, 'C:\\node\\node.exe');
    assert.match(bot.args[0], /src[\\/]index\.js$/);
    assert.equal(supervisor.status().bot.state, 'starting');

    bot.stdout.write("[10.11.2026 09:31:59] INFO  [bot] Discord'a bağlanılıyor...\n");
    bot.stderr.write(
      '\nHATA: Discord token\'ı geçersiz. Developer Portal > Bot > "Reset Token" ile yeni token alıp .env içindeki DISCORD_TOKEN\'a yapıştırın.\n\n',
    );
    await wait(5);
    bot.exit(1);
    await until(() => supervisor.status().bot.state === 'error');
    const status = supervisor.status();
    assert.match(status.bot.error, /^Discord token'ı geçersiz/);
    assert.equal(status.lavalink.state, 'ready');
    await wait(30);
    assert.equal(spawned.length, 2, 'a bad token is not retried');

    // The token value from .env never reaches the log.
    assert.ok(!logs.query({}).some((e) => e.text.includes('testpass123') || e.text.includes('fake.token.valuexx')));

    // Start again so both run, then stop: bot first.
    const again = supervisor.startAll();
    await until(() => spawned.length === 3);
    spawned[2].stdout.write("[10.11.2026 09:31:59] INFO  [bot] Discord'a giriş yapıldı: Müzik#1234 (3 sunucu)\n");
    spawned[2].stdout.write(
      '[10.11.2026 09:31:59] INFO  [bot:panel] Web paneli açık: http://127.0.0.1:3010 (dinlenen adres http://127.0.0.1:3010)\n',
    );
    spawned[2].stdout.write('[10.11.2026 09:31:59] INFO  [bot:lavalink] Lavalink bağlandı (main).\n');
    await again;
    await until(() => supervisor.status().bot.state === 'ready');
    const online = supervisor.status();
    assert.equal(online.bot.name, 'Müzik#1234');
    assert.equal(online.bot.guilds, 3);
    assert.equal(online.bot.lavalinkConnected, true);
    assert.deepEqual([online.panel.state, online.panel.url], ['open', 'http://127.0.0.1:3010']);

    await supervisor.stopAll();
    assert.deepEqual(order, ['stop C:\\node\\node.exe', 'stop C:\\java\\bin\\java.exe']);
    assert.equal(supervisor.status().lavalink.state, 'stopped');
    assert.equal(supervisor.status().bot.state, 'stopped');
    assert.equal(supervisor.status().panel.state, 'closed');
  } finally {
    cleanup();
  }
});

test('port taken by another program: clear Turkish message, nothing spawned', async () => {
  const { supervisor, spawned, cleanup } = setup({ portInUse: true, listeners: [31212], name: 'java.exe' });
  try {
    await supervisor.startAll();
    const status = supervisor.status();
    assert.equal(status.lavalink.state, 'error');
    assert.match(status.lavalink.error, /2444 portu kullanımda \(java\.exe, PID 31212\)/);
    assert.match(status.lavalink.error, /başka bir Lavalink/);
    assert.equal(spawned.length, 0);
    assert.equal(status.bot.state, 'stopped');
  } finally {
    cleanup();
  }
});

test('port taken by the Lavalink this app started earlier: adopted', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-pid-')), 'surecler.json');
  fs.writeFileSync(pidFile, JSON.stringify({ lavalink: { pid: 31212, port: 2444 } }));
  const { supervisor, spawned, cleanup } = setup({
    portInUse: true,
    listeners: [31212],
    name: 'java.exe',
    pidFile,
    commandLine: (dir) => `"C:\\jdk\\bin\\java.exe" -Xmx512M -jar "${path.join(dir, 'lavalink', 'Lavalink.jar')}"`,
  });
  try {
    const started = supervisor.startAll();
    await until(() => spawned.length === 1);
    await started;
    const status = supervisor.status();
    assert.equal(status.lavalink.state, 'ready');
    assert.equal(status.lavalink.adopted, true);
    assert.equal(status.lavalink.pid, 31212);
    assert.equal(spawned[0].command, 'C:\\node\\node.exe', 'only the bot was spawned');
    spawned[0].exit(0);
  } finally {
    cleanup();
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
  }
});

test('missing password stops before spawning', async () => {
  const { supervisor, spawned, cleanup } = setup({ envText: 'LAVALINK_PASSWORD=\n' });
  try {
    await supervisor.startAll();
    assert.match(supervisor.status().lavalink.error, /LAVALINK_PASSWORD boş/);
    assert.equal(spawned.length, 0);
  } finally {
    cleanup();
  }
});

test('a reused PID running something else is not adopted', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-pid-')), 'surecler.json');
  fs.writeFileSync(pidFile, JSON.stringify({ lavalink: { pid: 31212, port: 2444 } }));
  const { supervisor, spawned, cleanup } = setup({
    portInUse: true,
    listeners: [31212],
    name: 'java.exe',
    pidFile,
    commandLine: '"C:\\jdk\\bin\\java.exe" -jar C:\\other\\server.jar',
  });
  try {
    await supervisor.startAll();
    const status = supervisor.status();
    assert.equal(status.lavalink.state, 'error');
    assert.match(status.lavalink.error, /2444 portu kullanımda/);
    assert.equal(spawned.length, 0);
  } finally {
    cleanup();
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
  }
});

test('Durdur while Lavalink is starting cancels the start; the bot is never started', async () => {
  const { supervisor, spawned, cleanup } = setup();
  try {
    const started = supervisor.startAll();
    await until(() => spawned.length === 1);
    assert.equal(supervisor.status().busy, 'starting');
    await supervisor.stopAll();
    await started;
    await until(() => supervisor.status().lavalink.state === 'stopped');
    const status = supervisor.status();
    assert.equal(status.busy, null);
    assert.equal(status.bot.state, 'stopped');
    assert.equal(status.lastError, null, 'a cancelled start is not an error');
    assert.equal(spawned.length, 1, 'bot not spawned');
  } finally {
    cleanup();
  }
});

test('Durdur before Lavalink was even spawned also cancels', async () => {
  const { supervisor, spawned, cleanup } = setup();
  try {
    const started = supervisor.startAll();
    await supervisor.stopAll();
    await started;
    await wait(20);
    assert.equal(supervisor.status().lavalink.state, 'stopped');
    assert.equal(spawned.length, 0);
  } finally {
    cleanup();
  }
});

const otherCopies = (dir) => [
  {
    pid: 7001,
    ppid: 1,
    name: 'node.exe',
    cmd: `"C:\\Program Files\\nodejs\\node.exe" "${path.join(dir, 'src', 'index.js')}"`,
  },
  { pid: 7002, ppid: 1, name: 'java.exe', cmd: `java -Xmx512M -jar "${path.join(dir, 'lavalink', 'Lavalink.jar')}"` },
  { pid: 7003, ppid: 1, name: 'node.exe', cmd: 'node C:\\elsewhere\\src\\index2.js' },
];

test('bot already open in another window: start asks, nothing is spawned or killed', async () => {
  const { supervisor, spawned, killed, cleanup } = setup({ processes: otherCopies });
  try {
    const status = await supervisor.startAll();
    assert.deepEqual(
      status.conflict.processes.map((p) => [p.pid, p.kind]),
      [
        [7001, 'bot'],
        [7002, 'lavalink'],
      ],
    );
    assert.match(status.conflict.message, /Bot zaten başka bir pencerede açık \(PID 7001\)/);
    assert.equal(spawned.length, 0);
    assert.deepEqual(killed, []);
    assert.equal(status.busy, null);

    assert.equal(supervisor.clearConflict() ?? supervisor.status().conflict, null);
  } finally {
    cleanup();
  }
});

test('"Kapat ve buradan başlat" kills the other copies, then starts here', async () => {
  let gone = false;
  const { supervisor, spawned, killed, cleanup } = setup({ processes: (dir) => (gone ? [] : otherCopies(dir)) });
  try {
    const started = supervisor.startAll({ takeOver: true });
    await until(() => spawned.length === 1);
    gone = true;
    assert.deepEqual(killed, [7001, 7002]);
    spawned[0].stdout.write(
      '2026-11-10T09:05:32.803+03:00  INFO 1 --- [Lavalink] [main] l.s.Launcher : Lavalink is ready to accept connections.\n',
    );
    await started;
    assert.equal(spawned.length, 2);
    assert.equal(supervisor.status().conflict, null);
  } finally {
    for (const child of spawned) child.exit(0);
    cleanup();
  }
});

test('autostart with another copy open: warns, does not ask, does not start', async () => {
  const { supervisor, spawned, killed, cleanup } = setup({ processes: otherCopies });
  try {
    const status = await supervisor.startAll({ auto: true });
    assert.equal(spawned.length, 0);
    assert.deepEqual(killed, []);
    assert.match(status.lastError, /Otomatik başlatma yapılmadı/);
    assert.equal(status.conflict.auto, true);
  } finally {
    cleanup();
  }
});

test('the app reports other copies when it opens', async () => {
  const { supervisor, cleanup } = setup({ processes: otherCopies });
  try {
    const conflict = await supervisor.checkConflicts();
    assert.equal(conflict.startup, true);
    assert.equal(conflict.processes.length, 2);
  } finally {
    cleanup();
  }
});
