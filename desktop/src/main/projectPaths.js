'use strict';

// Finding the bot's project folder (the one with src/index.js and lavalink/).

const fs = require('node:fs');
const path = require('node:path');

/**
 * Checks that `dir` looks like the bot project.
 * @returns {{ ok: boolean, problems: string[] }}
 */
function validateProjectDir(dir, exists = fs.existsSync) {
  if (!dir || typeof dir !== 'string') return { ok: false, problems: ['Klasör seçilmedi.'] };
  const problems = [];
  if (!exists(path.join(dir, 'src', 'index.js'))) problems.push('src\\index.js yok');
  if (!exists(path.join(dir, 'lavalink', 'application.yml'))) problems.push('lavalink\\application.yml yok');
  if (!exists(path.join(dir, 'package.json'))) problems.push('package.json yok');
  return { ok: problems.length === 0, problems };
}

/** The folder itself and up to `levels` parents. */
function withParents(dir, levels) {
  const out = [];
  let current = dir;
  for (let i = 0; i <= levels && current; i += 1) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

/**
 * Candidate folders in priority order:
 *  1. MUZIKBOT_PROJECT_DIR (tests, advanced users)
 *  2. the folder the user chose (Settings or the welcome screen)
 *  3. one level above the app folder (desktop/.. while developing)
 *  4. folders around the portable exe (e.g. desktop/dist/x.exe -> ../..)
 *  5. folders around the exe itself
 * Nothing machine-specific is baked into the build; a copy that finds none of these shows
 * the welcome screen, asks for the folder once and remembers it.
 */
function projectDirCandidates({ override, saved, appPath, portableDir, exeDir }) {
  const list = [];
  if (override) list.push(override);
  if (saved) list.push(saved);
  if (appPath) list.push(path.dirname(appPath));
  if (portableDir) list.push(...withParents(portableDir, 3));
  if (exeDir) list.push(...withParents(exeDir, 3));
  return [...new Set(list.filter(Boolean).map((p) => path.resolve(p)))];
}

/** First valid candidate, or null. */
function resolveProjectDir(inputs, validate = validateProjectDir) {
  for (const candidate of projectDirCandidates(inputs)) {
    if (validate(candidate).ok) return candidate;
  }
  return null;
}

module.exports = { validateProjectDir, projectDirCandidates, resolveProjectDir };
