'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEnv: nodeParseEnv } = require('node:util');
const { parseEnv, parseEnvDocument, updateEnvText, serializeValue, envKeys } = require('../src/main/envFile');

const SAMPLES = [
  'A=1',
  'export B=2',
  'C= spaced value  # comment',
  'D="q#x" trailing',
  "E='single'",
  'F="multi\nline"',
  'G="unterminated',
  'H=a"b',
  'I=`bt`',
  'J="esc\\nnl"',
  'K',
  '=nokey',
  '  L = trimmed ',
  'M=#onlycomment',
  'N=""',
  'O=x=y',
  "P='a\nb'",
  ' # comment',
  'Q="a""b"',
  'R="open\nmore\nend" tail',
  'S= "lead"',
  'A=1\nA=2',
  'A="x\nB=2\nC=3',
  '﻿BOM=1\r\nNEXT=2\r\n',
  'T=Müzik Bot ü ş ğ',
];

test('parser matches Node util.parseEnv on edge cases', () => {
  for (const sample of SAMPLES) {
    // Node keeps a UTF-8 BOM as part of the first key; we drop it (like lavalink/dotenv.ps1).
    const expected = { ...nodeParseEnv(sample.replace(/^﻿/, '')) };
    assert.deepEqual(parseEnv(sample), expected, `sample: ${JSON.stringify(sample)}`);
  }
});

test('parser matches Node util.parseEnv on the project .env.example', () => {
  const example = path.join(__dirname, '..', '..', '.env.example');
  if (!fs.existsSync(example)) return;
  const text = fs.readFileSync(example, 'utf8');
  assert.deepEqual(parseEnv(text), { ...nodeParseEnv(text) });
});

test('document keeps line positions for multi-line values', () => {
  const doc = parseEnvDocument('# c\nA="x\ny"  # note\nB=2');
  assert.deepEqual(
    doc.entries.map(({ key, start, end, tail }) => ({ key, start, end, tail })),
    [
      { key: 'A', start: 1, end: 2, tail: '  # note' },
      { key: 'B', start: 3, end: 3, tail: '' },
    ],
  );
});

test('serializeValue quotes only when needed and round-trips', () => {
  const values = ['plain', 'ab#cd', ' lead', 'trail ', '"q"', "it's", 'a\\nb', 'x"y\'z', '', 'Müzik'];
  for (const value of values) {
    const line = `K=${serializeValue('K', value)}`;
    assert.equal(nodeParseEnv(line).K, value, `value ${JSON.stringify(value)} -> ${line}`);
  }
  assert.equal(serializeValue('K', 'plain'), 'plain');
  assert.equal(serializeValue('K', 'ab#cd'), '"ab#cd"');
  assert.throws(() => serializeValue('K', 'a\nb'), /birden fazla satır/);
  assert.throws(() => serializeValue('K', '"\'`#'), /aynı anda/);
});

test('updateEnvText keeps comments, order, unknown keys and inline comments', () => {
  const original = [
    '# Header comment',
    '',
    '# --- Discord ---',
    'DISCORD_TOKEN=old',
    'UNKNOWN_KEY=keep me',
    'LAVALINK_PORT=2333 # default port',
    'export EXPORTED=1',
    'MULTI="line one',
    'line two"',
    '',
    '# footer',
    '',
  ].join('\r\n');

  const updated = updateEnvText(original, {
    DISCORD_TOKEN: 'new#value',
    LAVALINK_PORT: '2444',
    EXPORTED: '2',
    MULTI: 'single',
    NEW_KEY: 'added',
  });

  assert.equal(
    updated,
    [
      '# Header comment',
      '',
      '# --- Discord ---',
      'DISCORD_TOKEN="new#value"',
      'UNKNOWN_KEY=keep me',
      'LAVALINK_PORT=2444 # default port',
      'export EXPORTED=2',
      'MULTI=single',
      '',
      '# footer',
      'NEW_KEY=added',
      '',
    ].join('\r\n'),
  );
  assert.deepEqual(nodeParseEnv(updated), {
    DISCORD_TOKEN: 'new#value',
    UNKNOWN_KEY: 'keep me',
    LAVALINK_PORT: '2444',
    EXPORTED: '2',
    MULTI: 'single',
    NEW_KEY: 'added',
  });
});

test('updateEnvText rewrites every duplicate and keeps a BOM', () => {
  const updated = updateEnvText('﻿A=1\nA=2\n', { A: '3' });
  assert.equal(updated, '﻿A=3\nA=3\n');
});

test('updateEnvText drops a tail that would change an unquoted value', () => {
  // "a"junk is ignored after the closing quote, but would become part of an unquoted value.
  const updated = updateEnvText('A="a"junk\n', { A: 'b' });
  assert.equal(nodeParseEnv(updated).A, 'b');
});

test('updateEnvText with no changes returns identical text', () => {
  const text = '# c\r\nA=1\r\n\r\nB="x # y"  # z\r\n';
  assert.equal(updateEnvText(text, {}), text);
  assert.equal(updateEnvText(text, { A: '1', B: 'x # y' }), text);
});

test('appending to an empty file and to a file without trailing newline', () => {
  assert.equal(updateEnvText('', { A: '1' }), 'A=1\n');
  assert.equal(updateEnvText('X=1', { A: '1' }), 'X=1\nA=1');
});

test('form round trip on a temporary copy of the real .env.example keeps everything else', () => {
  const example = path.join(__dirname, '..', '..', '.env.example');
  if (!fs.existsSync(example)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-env-'));
  const file = path.join(dir, '.env');
  try {
    fs.copyFileSync(example, file);
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, updateEnvText(before, { LAVALINK_PORT: '2444', DISCORD_TOKEN: 'fake.token.value' }));
    const after = fs.readFileSync(file, 'utf8');

    const strip = (text) => text.split(/\r?\n/).filter((l) => !/^(LAVALINK_PORT|DISCORD_TOKEN)=/.test(l));
    assert.deepEqual(strip(after), strip(before), 'only the two edited lines may differ');
    assert.deepEqual(envKeys(after), envKeys(before), 'key order is unchanged');
    assert.equal(nodeParseEnv(after).LAVALINK_PORT, '2444');
    assert.equal(nodeParseEnv(after).DISCORD_TOKEN, 'fake.token.value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keyComments returns the comment block above each key, without section rulers', () => {
  const { keyComments } = require('../src/main/envFile');
  const text = [
    '# Header',
    '',
    '# --- Bot sahibi (isteğe bağlı) ---',
    '# /servers komutunu yalnızca bot sahibi kullanabilir.',
    '# Birden çok kimliği virgülle ayırın:',
    '# BOT_OWNER_IDS=123,456',
    'BOT_OWNER_IDS=',
    'NO_COMMENT=1',
  ].join('\n');
  assert.deepEqual(keyComments(text), {
    BOT_OWNER_IDS: '/servers komutunu yalnızca bot sahibi kullanabilir. Birden çok kimliği virgülle ayırın:',
  });
});
