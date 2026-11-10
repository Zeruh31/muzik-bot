'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildLavalinkLaunch,
  buildBotLaunch,
  findExecutable,
  findJava,
  parseJavaMajor,
  parseLavalinkPort,
  childBaseEnv,
  lavalinkEnv,
} = require('../src/main/launchers');
const { validateProjectDir, projectDirCandidates, resolveProjectDir } = require('../src/main/projectPaths');

const PROJECT = 'D:\\Botlar\\Müzik Bot';
const jar = path.join(PROJECT, 'lavalink', 'Lavalink.jar');
const allExist = () => true;

test('Lavalink launch mirrors baslat.ps1', () => {
  const launch = buildLavalinkLaunch({
    projectDir: PROJECT,
    envValues: {
      LAVALINK_PASSWORD: 'pw',
      LAVALINK_PORT: ' 2444 ',
      LAVALINK_JAVA_MEMORY: '1G',
      SPOTIFY_CLIENT_ID: 'id',
      SPOTIFY_CLIENT_SECRET: 'secret',
      YOUTUBE_OAUTH_REFRESH_TOKEN: '',
      OTHER: 'x',
      JAVA_TOOL_OPTIONS: '-javaagent:evil.jar',
    },
    baseEnv: { Path: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', _JAVA_OPTIONS: '-Xdebug', SystemRoot: 'C:\\Windows' },
    javaPath: 'C:\\jdk\\bin\\java.exe',
    javaMajor: 21,
    exists: allExist,
  });
  assert.equal(launch.command, 'C:\\jdk\\bin\\java.exe');
  assert.deepEqual(launch.args, ['-Xmx1G', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-jar', jar]);
  assert.equal(launch.cwd, path.join(PROJECT, 'lavalink'));
  assert.equal(launch.port, 2444);
  assert.equal(launch.env.LAVALINK_PORT, '2444');
  assert.equal(launch.env.SPOTIFY_ENABLED, 'true');
  assert.deepEqual(Object.keys(launch.env).sort(), [
    'LAVALINK_PASSWORD',
    'LAVALINK_PORT',
    'Path',
    'SPOTIFY_CLIENT_ID',
    'SPOTIFY_CLIENT_SECRET',
    'SPOTIFY_ENABLED',
    'SystemRoot',
  ]);
  assert.equal(launch.env.OTHER, undefined, 'only the keys Lavalink needs');
  assert.equal(launch.env.JAVA_TOOL_OPTIONS, undefined, 'never from .env');
  assert.equal(launch.env._JAVA_OPTIONS, undefined, 'never from the system either');
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(launch.youtubeLoggedIn, false);
});

test('Lavalink defaults; .env is the only source of Lavalink settings', () => {
  const launch = buildLavalinkLaunch({
    projectDir: PROJECT,
    envValues: { LAVALINK_PASSWORD: 'from-file', SPOTIFY_CLIENT_ID: 'only-id' },
    baseEnv: { lavalink_password: 'from-env' },
    javaPath: 'java.exe',
    javaMajor: 17,
    exists: allExist,
  });
  assert.equal(launch.args[0], '-Xmx512M');
  assert.equal(launch.port, 2333);
  assert.equal(launch.env.SPOTIFY_ENABLED, 'false');
  assert.equal(launch.env.LAVALINK_PASSWORD, 'from-file');
  assert.equal(Object.keys(launch.env).filter((k) => k.toUpperCase() === 'LAVALINK_PASSWORD').length, 1);
});

test('Lavalink launch errors are Turkish and specific', () => {
  const base = {
    projectDir: PROJECT,
    envValues: { LAVALINK_PASSWORD: 'pw' },
    baseEnv: {},
    javaPath: 'java.exe',
    javaMajor: 21,
    exists: allExist,
  };
  assert.throws(() => buildLavalinkLaunch({ ...base, javaPath: null }), /Java bulunamadı/);
  assert.throws(() => buildLavalinkLaunch({ ...base, javaMajor: 11 }), /çok eski \(Java 11\)/);
  assert.throws(() => buildLavalinkLaunch({ ...base, exists: () => false }), /Lavalink\.jar yok/);
  assert.throws(() => buildLavalinkLaunch({ ...base, envValues: { LAVALINK_PASSWORD: ' ' } }), /LAVALINK_PASSWORD boş/);
  assert.throws(
    () => buildLavalinkLaunch({ ...base, envValues: { LAVALINK_PASSWORD: 'pw', LAVALINK_PORT: '70000' } }),
    /1 ile 65535/,
  );
  assert.throws(
    () => buildLavalinkLaunch({ ...base, envValues: { LAVALINK_PASSWORD: 'pw', LAVALINK_JAVA_MEMORY: '-XX:evil' } }),
    /512M ya da 1G/,
  );
});

test('bot launch', () => {
  const launch = buildBotLaunch({
    projectDir: PROJECT,
    baseEnv: {
      PATH: 'C:\\x',
      A: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      NODE_OPTIONS: '--require evil.js',
      DISCORD_TOKEN: 'from-system',
    },
    nodePath: 'C:\\node\\node.exe',
    nodeMajor: 24,
    exists: allExist,
  });
  assert.deepEqual(launch, {
    command: 'C:\\node\\node.exe',
    args: [path.join(PROJECT, 'src', 'index.js')],
    cwd: PROJECT,
    env: { PATH: 'C:\\x' },
  });
  assert.throws(
    () => buildBotLaunch({ projectDir: PROJECT, baseEnv: {}, nodePath: null, exists: allExist }),
    /Node\.js bulunamadı/,
  );
  assert.throws(
    () => buildBotLaunch({ projectDir: PROJECT, baseEnv: {}, nodePath: 'n', nodeMajor: 20, exists: allExist }),
    /eski \(v20\)/,
  );
  assert.throws(
    () =>
      buildBotLaunch({
        projectDir: PROJECT,
        baseEnv: {},
        nodePath: 'n',
        nodeMajor: 24,
        exists: (p) => !p.endsWith('node_modules'),
      }),
    /npm install/,
  );
});

test('java and node lookup on PATH and JAVA_HOME', () => {
  const files = new Set(['C:\\b\\node.exe', 'C:\\jdk\\bin\\java.exe']);
  const exists = (p) => files.has(p);
  assert.equal(findExecutable('node.exe', { PATH: 'C:\\a;"C:\\b"' }, exists), 'C:\\b\\node.exe');
  assert.equal(findJava({ Path: 'C:\\a', JAVA_HOME: 'C:\\jdk' }, exists), 'C:\\jdk\\bin\\java.exe');
  assert.equal(findJava({ Path: 'C:\\a' }, exists), null);
  assert.equal(parseJavaMajor('openjdk version "21.0.12.1" 2026-08-18 LTS'), 21);
  assert.equal(parseJavaMajor('java version "1.8.0_401"'), 8);
  assert.equal(parseJavaMajor('nothing'), null);
  assert.equal(parseLavalinkPort(''), 2333);
  assert.deepEqual(
    childBaseEnv({ temp: 'T', NODE_OPTIONS: 'x', _JAVA_OPTIONS: 'y', JDK_JAVA_OPTIONS: 'z', USERPROFILE: 'U' }),
    { temp: 'T', USERPROFILE: 'U' },
  );
  assert.deepEqual(
    lavalinkEnv({}, { LAVALINK_PASSWORD: 'p', NODE_OPTIONS: 'x', DISCORD_TOKEN: 't', SPOTIFY_CLIENT_ID: '' }),
    { LAVALINK_PASSWORD: 'p' },
  );
});

test('project folder validation and candidate order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-proj-'));
  try {
    assert.equal(validateProjectDir(dir).ok, false);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'lavalink'));
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), '');
    fs.writeFileSync(path.join(dir, 'lavalink', 'application.yml'), '');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    assert.deepEqual(validateProjectDir(dir), { ok: true, problems: [] });
    // Portable exe in <project>\desktop\dist: found two levels up.
    assert.equal(resolveProjectDir({ portableDir: path.join(dir, 'desktop', 'dist') }), dir);
    assert.equal(resolveProjectDir({ saved: 'C:\\nope', appPath: path.join(dir, 'desktop') }), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const order = projectDirCandidates({
    override: 'C:\\o',
    saved: 'C:\\s',
    appPath: 'C:\\p\\desktop',
    portableDir: 'D:\\port\\dist',
    exeDir: 'C:\\e',
  });
  assert.deepEqual(order.slice(0, 5), ['C:\\o', 'C:\\s', 'C:\\p', 'D:\\port\\dist', 'D:\\port']);
  assert.ok(order.indexOf('D:\\port') < order.indexOf('C:\\e'), 'portable exe folder before the exe folder');
});
