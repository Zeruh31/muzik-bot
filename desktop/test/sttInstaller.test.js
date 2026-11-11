'use strict';

// The voice command installer: the steps and paths (built in the main process), the status rules shared with
// the bot (kurulum.json), no secrets for the steps, install / failure / cancel / remove with a fake spawn.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const {
  componentDir,
  componentStatus,
  createSttInstaller,
  findUv,
  planInstall,
  pythonPath,
  stepEnv,
  unsafeDirReason,
  MANIFEST_NAME,
} = require('../src/main/sttInstaller');
const { normalizeStatus } = require('../src/main/botStatus');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stt-kur-'));

test('the component lives outside the project, under the user data (or SESLI_KOMUT_DIZINI)', () => {
  assert.equal(componentDir({ LOCALAPPDATA: 'C:\\L' }, 'win32'), path.join('C:\\L', 'MuzikBot', 'sesli-komut'));
  assert.equal(componentDir({ SESLI_KOMUT_DIZINI: 'D:\\x', LOCALAPPDATA: 'C:\\L' }, 'win32'), 'D:\\x');
});

test('install plan: uv venv, pinned requirements of the project, then the models of the profile', () => {
  const gpu = planInstall({ profile: 'gpu', projectDir: 'P', dir: 'D', uvPath: 'uv.exe', platform: 'win32' });
  assert.deepEqual(
    gpu.map((s) => s.ad),
    ['venv', 'paketler', 'model-turbo', 'model-small'],
  );
  assert.deepEqual(gpu[0].args, ['venv', '--allow-existing', '--python', '3.14', path.join('D', 'venv')]);
  assert.deepEqual(gpu[1].args, [
    'pip',
    'install',
    '--python',
    pythonPath('D', 'win32'),
    '--require-hashes',
    '--only-binary',
    ':all:',
    '-r',
    path.join('P', 'stt', 'requirements-gpu.txt'),
  ]);
  assert.equal(gpu[2].command, pythonPath('D', 'win32'));
  assert.ok(gpu[2].args.includes(path.join('P', 'stt', 'model_indir.py')));
  assert.deepEqual(gpu[2].args.slice(-2), ['--models', 'turbo']);
  const cpu = planInstall({ profile: 'cpu', projectDir: 'P', dir: 'D', uvPath: 'uv.exe', platform: 'win32' });
  assert.deepEqual(
    cpu.map((s) => s.ad),
    ['venv', 'paketler', 'model-small'],
  );
  assert.ok(cpu[1].args.at(-1).endsWith('requirements.txt'));
  assert.throws(() => planInstall({ profile: '../x', projectDir: 'P', dir: 'D', uvPath: 'uv' }), /Geçersiz profil/);
});

test('the steps get no secrets of the app environment', () => {
  const env = stepEnv({ PATH: 'p', DISCORD_TOKEN: 't', LAVALINK_PASSWORD: 'x', YOUTUBE_OAUTH_REFRESH_TOKEN: 'y' });
  assert.equal(env.PATH, 'p');
  for (const key of ['DISCORD_TOKEN', 'LAVALINK_PASSWORD', 'YOUTUBE_OAUTH_REFRESH_TOKEN'])
    assert.equal(env[key], undefined);
  assert.equal(env.HF_HUB_DISABLE_TELEMETRY, '1');
});

test('uv is found on PATH or in its own install folder', () => {
  const home = 'C:\\Users\\u';
  const exists = (p) => p === path.join(home, '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
  assert.equal(
    findUv({ PATH: 'C:\\x', USERPROFILE: home }, exists),
    path.join(home, '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv'),
  );
  assert.equal(
    findUv({ PATH: 'C:\\x' }, () => false),
    null,
  );
});

test('status: not installed, interrupted, ready (same rule as the bot)', () => {
  const dir = temp();
  assert.equal(componentStatus({ dir, platform: 'win32' }).durum, 'kurulu-degil');
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ surum: 1, durum: 'kuruluyor', profil: 'gpu' }));
  assert.equal(componentStatus({ dir, platform: 'win32' }).durum, 'yarim');
  fs.mkdirSync(path.join(dir, 'venv', 'Scripts'), { recursive: true });
  fs.writeFileSync(pythonPath(dir, 'win32'), '');
  fs.mkdirSync(path.join(dir, 'models', 'turbo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'turbo', 'model.bin'), '');
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ surum: 1, durum: 'hazir', profil: 'gpu' }));
  assert.deepEqual(componentStatus({ dir, platform: 'win32' }), {
    durum: 'hazir',
    profil: 'gpu',
    modeller: ['turbo'],
    dizin: dir,
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A spawn double: each step "runs" by doing what the real one would leave behind, then closes. */
function fakeSpawn({ failAt = null, hangAt = null } = {}) {
  const calls = [];
  const children = [];
  const spawnImpl = (command, args) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.kill = () => child.emit('close', 1);
    calls.push({ command, args });
    children.push(child);
    const name = args[0] === 'venv' ? 'venv' : args[0] === 'pip' ? 'paketler' : `model-${args.at(-1)}`;
    setImmediate(() => {
      if (name === hangAt) return; // waits for cancel()
      if (name === failAt) {
        child.stderr.write('ERROR: no matching distribution\n');
        child.emit('close', 1);
        return;
      }
      if (name === 'venv') {
        const venv = args.at(-1);
        fs.mkdirSync(path.join(venv, 'Scripts'), { recursive: true });
        fs.writeFileSync(path.join(venv, 'Scripts', 'python.exe'), '');
      }
      if (name.startsWith('model-')) {
        const out = path.join(args[args.indexOf('--out') + 1], args.at(-1));
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'model.bin'), 'x');
      }
      child.emit('close', 0);
    });
    return child;
  };
  return { calls, children, spawnImpl };
}

function installer(options = {}) {
  const dir = path.join(temp(), 'sesli-komut');
  const projectDir = temp();
  fs.mkdirSync(path.join(projectDir, 'stt'));
  fs.writeFileSync(path.join(projectDir, 'stt', 'stt_worker.py'), '');
  const progress = [];
  const killed = [];
  const fake = fakeSpawn(options);
  const inst = createSttInstaller({
    getProjectDir: () => projectDir,
    onProgress: (e) => progress.push(e),
    // The real one ends the whole process tree; the step then closes.
    killTree: (pid) => {
      killed.push(pid);
      fake.children.at(-1).emit('close', 1);
    },
    env: { PATH: '', DISCORD_TOKEN: 'secret' },
    spawnImpl: fake.spawnImpl,
    dir,
    findUvImpl: () => 'uv.exe',
  });
  return { inst, dir, projectDir, progress, killed, fake };
}

test('install: every step in order, then kurulum.json "hazir"', { skip: process.platform !== 'win32' }, async () => {
  const t = installer();
  const result = await t.inst.install('gpu');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(
    t.fake.calls.map((c) => (c.args[0] === 'venv' || c.args[0] === 'pip' ? c.args[0] : c.args.at(-1))),
    ['venv', 'pip', 'turbo', 'small'],
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(t.dir, MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.durum, 'hazir');
  assert.deepEqual(manifest.modeller, ['turbo', 'small']);
  assert.equal(t.inst.status().durum, 'hazir');
  assert.equal(t.progress.at(-1).asama, 'bitti');
  assert.equal(t.inst.busy, false);
});

test('install: a failing step stops it and leaves it "yarım"; the window cannot pass another profile', async () => {
  const t = installer({ failAt: 'paketler' });
  const result = await t.inst.install('cpu');
  assert.equal(result.ok, false);
  assert.match(result.output, /no matching distribution/);
  assert.equal(t.fake.calls.length, 2);
  assert.equal(t.inst.status().durum, 'yarim');
  assert.equal((await t.inst.install('../../evil')).ok, false);
});

test('cancel kills the running step tree; remove deletes the folder', async () => {
  const t = installer({ hangAt: 'paketler' });
  const running = t.inst.install('cpu');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(t.inst.busy, true);
  assert.equal((await t.inst.install('cpu')).ok, false, 'one install at a time');
  assert.equal(t.inst.remove().ok, false, 'not while installing');
  assert.equal(t.inst.cancel(), true);
  assert.deepEqual(t.killed, [4242]);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(t.inst.status().durum, 'yarim', 'the next install continues');
  assert.equal(t.inst.remove().ok, true);
  assert.equal(fs.existsSync(t.dir), false);
  assert.equal(t.inst.status().durum, 'kurulu-degil');
});

test('install refuses without the worker script in the project', async () => {
  const t = installer();
  fs.rmSync(path.join(t.projectDir, 'stt', 'stt_worker.py'));
  const result = await t.inst.install('cpu');
  assert.equal(result.ok, false);
  assert.match(result.message, /stt_worker\.py/);
});

test('the bot status file carries the voice command state (older bots: none)', () => {
  const base = { schemaVersion: 1, updatedAt: new Date().toISOString(), running: true, pid: 1 };
  assert.equal(normalizeStatus(base).voice, null);
  assert.deepEqual(
    normalizeStatus({
      ...base,
      sesliKomut: { kurulu: true, isci: 'hazir', cihaz: 'cuda', model: 'turbo', dinlenenSunucu: 1 },
    }).voice,
    { installed: true, worker: 'hazir', device: 'cuda', model: 'turbo', guilds: 1 },
  );
  assert.equal(normalizeStatus({ ...base, sesliKomut: { isci: 'bilinmez', cihaz: 'x' } }).voice.worker, 'kapali');
});

test('remove deletes only what the installer made, and only where its manifest is', () => {
  const dir = path.join(temp(), 'bilesen');
  fs.mkdirSync(path.join(dir, 'venv'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'kullanicinin-dosyasi.txt'), 'kalsın');
  const inst = createSttInstaller({ getProjectDir: () => null, dir, env: {} });
  const refused = inst.remove();
  assert.equal(refused.ok, false);
  assert.match(refused.message, /kurulum\.json yok/);
  assert.ok(fs.existsSync(path.join(dir, 'venv')), 'nothing deleted without the manifest');
  fs.mkdirSync(path.join(dir, 'models', 'small'), { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), '{"surum":1,"durum":"hazir"}');
  assert.equal(inst.remove().ok, true);
  assert.deepEqual(fs.readdirSync(dir), ['kullanicinin-dosyasi.txt'], 'foreign files stay, the folder too');
});

test('a drive root, the user profile or a system folder is never the component folder', () => {
  const r = String.raw;
  const env = { USERPROFILE: r`C:\Users\u`, LOCALAPPDATA: r`C:\Users\u\AppData\Local`, SystemRoot: r`C:\Windows` };
  for (const dir of [
    r`D:\ `.trim(),
    'D:',
    r`C:\Users\u`,
    r`C:\Users\U\ `.trim(),
    r`C:\Users\u\AppData\Local`,
    r`C:\Windows`,
    r`göreli\yol`,
  ])
    assert.ok(unsafeDirReason(dir, env), dir);
  assert.equal(unsafeDirReason(r`C:\Users\u\AppData\Local\MuzikBot\sesli-komut`, env), null);
  assert.equal(unsafeDirReason(r`D:\bot\stt`, env), null);
  const inst = createSttInstaller({ getProjectDir: () => null, dir: r`D:\ `.trim(), env });
  assert.match(inst.remove().message, /sürücü kökü/);
});
