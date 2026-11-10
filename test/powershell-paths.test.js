// The project lives in "...\Müzik Bot": a space and a non-ASCII letter in every path.
// `npm run hepsi` once failed because Start-Process -ArgumentList @(...) does not quote its
// items, so the new window received "...\Müzik" as the script path. These tests run real
// PowerShell 7 processes from a temporary "a b ü" folder to make sure that cannot return.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELPER = join(ROOT, 'lavalink', 'process-args.ps1');
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;
const isWindows = process.platform === 'win32';

const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

/** Runs a PowerShell 7 snippet with the helper dot-sourced; returns stdout. */
function pwsh(script) {
  const result = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; . ${psQuote(HELPER)}; ${script}`],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

describe(
  'paths with spaces and ü for PowerShell launches',
  { skip: (!hasPwsh || !isWindows) && 'Windows + pwsh gerekli' },
  () => {
    let dir;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'a b ü '));
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it('quotes arguments so a Windows program receives them unchanged', () => {
      const echo = join(dir, 'argv echo.js');
      const out = join(dir, 'argv.json');
      writeFileSync(echo, `require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));`);
      const values = [
        join(dir, 'hedef betik.ps1'),
        'düz',
        'tırnak " içinde',
        'C:\\klasör sonu\\',
        'a\\\\"b',
        '',
        '-NoExit',
      ];
      const list = values.map(psQuote).join(', ');
      pwsh(
        `Start-Process -FilePath node -Wait -NoNewWindow -ArgumentList (Join-CommandLine @(${psQuote(echo)}, ${psQuote(out)}, ${list}))`,
      );
      assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), values);
    });

    it('the "npm run hepsi" window command line really runs a script in an "a b ü" folder', async () => {
      const marker = join(dir, 'çalıştı.txt');
      const script = join(dir, 'hedef betik.ps1');
      // BOM so Windows PowerShell would also read the ü correctly; exits the -NoExit shell itself.
      writeFileSync(
        script,
        `\uFEFFSet-Content -LiteralPath ${psQuote(marker)} -Value $PSCommandPath -Encoding utf8\n[Environment]::Exit(0)\n`,
      );
      const pid = pwsh(
        `$p = Start-Process -FilePath (Get-Process -Id $PID).Path -WorkingDirectory ${psQuote(dir)} ` +
          `-ArgumentList (Get-LavalinkWindowCommandLine ${psQuote(script)}) -WindowStyle Hidden -PassThru; $p.Id`,
      );
      const deadline = Date.now() + 30_000;
      while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      spawnSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' }); // in case it did not exit
      assert.ok(existsSync(marker), 'the script in the spaced path did not run');
      assert.equal(
        readFileSync(marker, 'utf8')
          .replace(/^\uFEFF/, '')
          .trim(),
        script,
      );
    });

    it('no project .ps1 passes an unquoted array to Start-Process -ArgumentList', () => {
      const files = ['lavalink', 'scripts'].flatMap((folder) =>
        readdirSync(join(ROOT, folder))
          .filter((name) => name.endsWith('.ps1'))
          .map((name) => join(ROOT, folder, name)),
      );
      for (const file of files) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (/^\s*#/.test(line) || !/Start-Process/i.test(line)) continue;
          assert.doesNotMatch(line, /-ArgumentList\s+@\(/i, `${file}: ${line.trim()}`);
        }
      }
      assert.match(readFileSync(join(ROOT, 'scripts', 'hepsini-baslat.ps1'), 'utf8'), /Get-LavalinkWindowCommandLine/);
    });
  },
);
