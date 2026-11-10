'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

/** Path of watchdog.js; inside a packaged app it lives in app.asar.unpacked. */
function watchdogScriptPath() {
  return path.join(__dirname, 'watchdog.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/**
 * Starts the child-process guard (see watchdog.js) with a plain Node.js (node.exe), and
 * returns a small client. The packaged app has the RunAsNode fuse turned off, so its own
 * exe cannot run scripts; the bot needs Node.js anyway.
 * @param {{ execPath?: string|null, onLog?: (msg: string) => void }} [options]
 */
function startWatchdog({ execPath = process.execPath, onLog = () => {} } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ELECTRON_|NODE_OPTIONS$)/i.test(key)) delete env[key];
  let child = null;
  if (!execPath) {
    onLog('Süreç koruyucu başlatılamadı: Node.js bulunamadı. Uygulama çökerse bot ve Lavalink açık kalabilir.');
  } else {
    try {
      child = spawn(execPath, [watchdogScriptPath(), String(process.pid)], {
        env,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', (error) => onLog(`Süreç koruyucu başlatılamadı: ${error.message}`));
      child.stdin.on('error', () => {});
    } catch (error) {
      onLog(`Süreç koruyucu başlatılamadı: ${error.message}`);
    }
  }

  const send = (line) => {
    if (child?.stdin?.writable) child.stdin.write(`${line}\n`);
  };
  return {
    pid: child?.pid ?? null,
    add: (pid) => send(`+${pid}`),
    remove: (pid) => send(`-${pid}`),
    /** Normal exit: everything was stopped cleanly, the guard can go. */
    quit: () => {
      send('quit');
      child?.stdin?.end();
    },
  };
}

module.exports = { startWatchdog, watchdogScriptPath };
