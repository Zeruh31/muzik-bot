'use strict';

// Recognises this project's bot and Lavalink when they run OUTSIDE the app, e.g. from
// "npm start" / "npm run lavalink" in a PowerShell window, so the app does not start a
// second copy (two bots on one token answer every command twice).

const path = require('node:path');

const normalize = (text) =>
  String(text ?? '')
    .replace(/\//g, '\\')
    .toLowerCase();

/** True when a java command line runs <projectDir>\lavalink\Lavalink.jar. */
function runsLavalinkJar(commandLine, projectDir) {
  if (!projectDir) return false;
  return normalize(commandLine).includes(normalize(path.join(projectDir, 'lavalink', 'Lavalink.jar')));
}

/**
 * How a node command line refers to this project's bot:
 *  'exact'    the full path <projectDir>\src\index.js
 *  'relative' only "src\index.js" / "src/index.js" (e.g. `npm start` run inside the folder);
 *             the folder cannot be read from the command line, so it may be another project
 *  null       not the bot
 */
function botEntryMatch(commandLine, projectDir) {
  if (!projectDir) return null;
  const cmd = normalize(commandLine);
  if (cmd.includes(normalize(path.join(projectDir, 'src', 'index.js')))) return 'exact';
  // An argument that is exactly src\index.js (optionally .\src\index.js), not some other path.
  if (/(^|[\s"])(\.\\)?src\\index\.js("|\s|$)/.test(cmd)) return 'relative';
  return null;
}

/**
 * Picks this project's bot (node.exe) and Lavalink (java.exe) processes from a process
 * list, ignoring the PIDs the app started itself.
 * @param {Array<{ pid: number, name: string, cmd: string }>} list
 * @returns {Array<{ pid: number, kind: 'bot'|'lavalink', match: 'exact'|'relative', name: string }>}
 */
function findProjectProcesses(list, projectDir, ownPids = []) {
  const own = new Set(ownPids.filter(Boolean));
  const found = [];
  for (const p of list) {
    if (own.has(p.pid)) continue;
    const name = String(p.name ?? '').toLowerCase();
    if ((name === 'java.exe' || name === 'javaw.exe') && runsLavalinkJar(p.cmd, projectDir)) {
      found.push({ pid: p.pid, kind: 'lavalink', match: 'exact', name: p.name });
    } else if (name === 'node.exe') {
      const match = botEntryMatch(p.cmd, projectDir);
      if (match) found.push({ pid: p.pid, kind: 'bot', match, name: p.name });
    }
  }
  return found;
}

/** Turkish one-line description for the UI. */
function describeConflict(processes) {
  const bot = processes.filter((p) => p.kind === 'bot');
  const lavalink = processes.filter((p) => p.kind === 'lavalink');
  const parts = [];
  if (bot.length) {
    const unsure = bot.every((p) => p.match === 'relative')
      ? ' (komut satırı göreli; başka bir klasördeki bir Node programı da olabilir)'
      : '';
    parts.push(`Bot zaten başka bir pencerede açık (PID ${bot.map((p) => p.pid).join(', ')})${unsure}.`);
  }
  if (lavalink.length)
    parts.push(`Lavalink zaten başka bir pencerede açık (PID ${lavalink.map((p) => p.pid).join(', ')}).`);
  return parts.join(' ');
}

module.exports = { runsLavalinkJar, botEntryMatch, findProjectProcesses, describeConflict };
