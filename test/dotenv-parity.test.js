// The bot reads .env with Node's built-in parser; Lavalink's start scripts read the same
// file with lavalink/dotenv.ps1. These tests feed identical .env text to both and require
// identical results, so e.g. LAVALINK_PASSWORD can never differ between bot and Lavalink.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const DOTENV_PS1 = fileURLToPath(new URL('../lavalink/dotenv.ps1', import.meta.url));
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;

const SAMPLE = [
  '# yorum satırı',
  'SIFRE="abc" # yorum',
  "TEK='tek tırnak' # yorum",
  'TERS=`ters tırnak` # yorum',
  'ICERIDE="iç#karma"',
  'DUZ=duz # yorum',
  'BITISIK=duz#bitisik',
  'BOS=',
  '  BOSLUKLU  =   değer  ',
  'SATIR="çok\\nsatır"',
  "KACISSIZ='tek\\nkalır'",
  'KARISIK="tırnak içinde \'tek\'"',
  'export DISARI=dışarı',
  'RENK=#5865F2',
  'SONRASI="a"b',
  'IKI="x" "y"',
  'ESIT=a=b=c',
  'TERS_EGIK="tırnak \\" kaçış"',
  'COK="birinci',
  'ikinci satır"',
  'SON=son',
].join('\n');

/** Parses with lavalink/dotenv.ps1 in a real PowerShell 7 process. */
function parseWithPowerShell(content) {
  const dir = mkdtempSync(join(tmpdir(), 'muzikbot-env-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, content, 'utf8');
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `. '${DOTENV_PS1.replaceAll("'", "''")}'`,
      `$values = ConvertFrom-DotEnv ([System.IO.File]::ReadAllText('${file.replaceAll("'", "''")}', [System.Text.Encoding]::UTF8))`,
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '[Console]::Out.Write(($values | ConvertTo-Json -Compress))',
    ].join('; ');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('.env parity: bot (Node) vs Lavalink scripts (PowerShell)', { skip: !hasPwsh && 'pwsh yok' }, () => {
  it('parses every sample line identically', () => {
    const node = parseEnv(SAMPLE);
    const pwsh = parseWithPowerShell(SAMPLE);
    assert.deepEqual(pwsh, node);
  });

  it('the reported case: SIFRE="abc" # yorum is abc on both sides', () => {
    assert.equal(parseEnv('SIFRE="abc" # yorum').SIFRE, 'abc');
    assert.equal(parseWithPowerShell('SIFRE="abc" # yorum').SIFRE, 'abc');
  });

  it('handles Windows line endings and a UTF-8 BOM the same way', () => {
    const crlf = `﻿A="x" # y\r\nB=ş#ğ\r\nC='ç'\r\n`;
    assert.deepEqual(parseWithPowerShell(crlf), parseEnv(crlf.replace(/^﻿/, '')));
  });

  it('matches for the shipped .env.example', async () => {
    const { readFileSync } = await import('node:fs');
    const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    assert.deepEqual(parseWithPowerShell(example), parseEnv(example));
  });
});
