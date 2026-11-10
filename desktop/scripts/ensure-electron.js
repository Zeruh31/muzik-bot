'use strict';

// npm 11 can skip dependency install scripts, which leaves the electron package without
// its binary. Run electron's own downloader when the binary is missing.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const binary = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

if (fs.existsSync(electronDir) && !fs.existsSync(binary)) {
  console.log('Electron indiriliyor...');
  const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}
