// Syntax-checks every project .js file with `node --check`.
//   npm run check

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROJECT_ROOT } from '../src/config.js';

const FOLDERS = ['src', 'scripts', 'test'];

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = FOLDERS.flatMap((folder) => {
  try {
    return collect(join(PROJECT_ROOT, folder));
  } catch {
    return [];
  }
});

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    console.error(`HATA ${relative(PROJECT_ROOT, file)}\n${result.stderr}`);
  }
}

console.log(`node --check: ${files.length - failed}/${files.length} dosya geçti.`);
process.exitCode = failed ? 1 : 0;
