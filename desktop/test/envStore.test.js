'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { planEnvSave, writeFileAtomic, hashText } = require('../src/main/envStore');
const {
  botEntryMatch,
  runsLavalinkJar,
  findProjectProcesses,
  describeConflict,
} = require('../src/main/projectProcesses');
const { parseProcessJson } = require('../src/main/winproc');

const FILE = '# Discord\r\nDISCORD_TOKEN=abc\r\nDEFAULT_VOLUME=80\r\nCUSTOM_KEY=1\r\n';

test('only known keys can be saved', () => {
  const plan = planEnvSave({
    currentText: FILE,
    exampleText: 'NEW_EXAMPLE_KEY=\n',
    changes: {
      NODE_OPTIONS: '--require evil.js',
      JAVA_TOOL_OPTIONS: '-javaagent:x',
      CUSTOM_KEY: '2',
      NEW_EXAMPLE_KEY: 'v',
      DEFAULT_VOLUME: '90',
    },
  });
  assert.equal(plan.ok, false);
  assert.deepEqual(Object.keys(plan.errors).sort(), ['JAVA_TOOL_OPTIONS', 'NODE_OPTIONS']);
  assert.match(plan.errors.NODE_OPTIONS, /Bilinmeyen ayar/);

  const ok = planEnvSave({
    currentText: FILE,
    exampleText: 'NEW_EXAMPLE_KEY=\n',
    changes: { CUSTOM_KEY: '2', NEW_EXAMPLE_KEY: 'v', DEFAULT_VOLUME: '90' },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(parseEnv(ok.nextText), {
    DISCORD_TOKEN: 'abc',
    DEFAULT_VOLUME: '90',
    CUSTOM_KEY: '2',
    NEW_EXAMPLE_KEY: 'v',
  });
});

test('validation errors come back per key', () => {
  const plan = planEnvSave({ currentText: FILE, changes: { DEFAULT_VOLUME: '999' } });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.DEFAULT_VOLUME, /1 ile 150/);
});

test('outside changes are merged; the same key changed on both sides is a conflict', () => {
  // The form was opened on FILE; meanwhile youtube-token.js added the token.
  const outside = `${FILE}YOUTUBE_OAUTH_REFRESH_TOKEN=1//secret\r\n`;
  const merged = planEnvSave({
    currentText: outside,
    changes: { DEFAULT_VOLUME: '95' },
    base: { DEFAULT_VOLUME: '80' },
  });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(parseEnv(merged.nextText).YOUTUBE_OAUTH_REFRESH_TOKEN, '1//secret', 'outside change kept');
  assert.equal(parseEnv(merged.nextText).DEFAULT_VOLUME, '95');

  const editedOutside = FILE.replace('DEFAULT_VOLUME=80', 'DEFAULT_VOLUME=70');
  const conflict = planEnvSave({
    currentText: editedOutside,
    changes: { DEFAULT_VOLUME: '95' },
    base: { DEFAULT_VOLUME: '80' },
  });
  assert.deepEqual(conflict.conflicts, ['DEFAULT_VOLUME']);
  assert.notEqual(hashText(FILE), hashText(editedOutside));
});

test('atomic write: temp file + rename, no temp left behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-atomic-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'OLD=1\n');
    assert.equal(writeFileAtomic(file, 'NEW=2\n'), 'renamed');
    assert.equal(fs.readFileSync(file, 'utf8'), 'NEW=2\n');
    assert.deepEqual(fs.readdirSync(dir), ['.env']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic write retries a locked file, then falls back to writing in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-atomic-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'OLD=1\n');
    let renames = 0;
    const busyOnce = {
      ...fs,
      writeFileSync: fs.writeFileSync,
      rmSync: fs.rmSync,
      renameSync: (from, to) => {
        renames += 1;
        if (renames === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        fs.renameSync(from, to);
      },
    };
    assert.equal(writeFileAtomic(file, 'A=1\n', { fsImpl: busyOnce, delayMs: 1 }), 'renamed');
    assert.equal(renames, 2);

    const alwaysLocked = {
      ...busyOnce,
      renameSync: () => {
        throw Object.assign(new Error('perm'), { code: 'EPERM' });
      },
    };
    assert.equal(writeFileAtomic(file, 'B=2\n', { fsImpl: alwaysLocked, retries: 2, delayMs: 1 }), 'in-place');
    assert.equal(fs.readFileSync(file, 'utf8'), 'B=2\n');
    assert.deepEqual(fs.readdirSync(dir), ['.env'], 'temp file cleaned up');

    const otherError = {
      ...busyOnce,
      renameSync: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOSPC' });
      },
    };
    assert.throws(() => writeFileAtomic(file, 'C=3\n', { fsImpl: otherError }), /nope/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'B=2\n', 'original intact when writing failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recognising this project's bot and Lavalink in a process list", () => {
  const dir = 'D:\\Botlar\\Müzik Bot';
  assert.equal(botEntryMatch(`"C:\\Program Files\\nodejs\\node.exe" "${dir}\\src\\index.js"`, dir), 'exact');
  assert.equal(botEntryMatch('"C:\\Program Files\\nodejs\\node.exe" D:/botlar/müzik bot/src/index.js', dir), 'exact');
  assert.equal(botEntryMatch('node src/index.js', dir), 'relative');
  assert.equal(botEntryMatch('node .\\src\\index.js', dir), 'relative');
  assert.equal(botEntryMatch('node C:\\other\\src\\index.js', dir), null);
  assert.equal(botEntryMatch('node scripts/kontrol.js', dir), null);
  assert.ok(runsLavalinkJar(`java -Xmx512M -jar "${dir}\\lavalink\\Lavalink.jar"`, dir));
  assert.ok(!runsLavalinkJar('java -jar C:\\other\\lavalink\\Lavalink.jar', dir));

  const list = parseProcessJson(
    JSON.stringify([
      { ProcessId: 1, ParentProcessId: 0, Name: 'node.exe', CommandLine: `node "${dir}\\src\\index.js"` },
      { ProcessId: 2, ParentProcessId: 0, Name: 'java.exe', CommandLine: `java -jar "${dir}\\lavalink\\Lavalink.jar"` },
      { ProcessId: 3, ParentProcessId: 0, Name: 'node.exe', CommandLine: `node "${dir}\\src\\index.js"` },
      { ProcessId: 4, ParentProcessId: 0, Name: 'node.exe', CommandLine: null },
    ]),
  );
  const found = findProjectProcesses(list, dir, [3]);
  assert.deepEqual(
    found.map((p) => [p.pid, p.kind]),
    [
      [1, 'bot'],
      [2, 'lavalink'],
    ],
  );
  assert.equal(
    describeConflict(found),
    'Bot zaten başka bir pencerede açık (PID 1). Lavalink zaten başka bir pencerede açık (PID 2).',
  );
  assert.match(describeConflict([{ pid: 9, kind: 'bot', match: 'relative' }]), /göreli/);
  assert.deepEqual(
    parseProcessJson(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: 'java.exe', CommandLine: 'x' })),
    [{ pid: 5, ppid: 1, name: 'java.exe', cmd: 'x' }],
  );
  assert.deepEqual(parseProcessJson(''), []);
});
