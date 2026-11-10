'use strict';

// Child-process guard. Runs as a separate hidden Node.js process (node.exe) next to the app. The app tells it which PIDs it started:
//   "+1234"  watch this process     "-1234"  forget it     "quit"  exit without killing
// When the app disappears without saying "quit" (crash, Task Manager kill), its end of
// stdin closes, or the parent PID vanishes: the guard then force-kills every watched
// process tree so no orphaned java.exe or node.exe stays behind.
//
// Usage: node watchdog.js <parentPid>

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const parentPid = Number(process.argv[2]);
const watched = new Set();
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
let finished = false;

function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function killAllAndExit() {
  if (finished) return;
  finished = true;
  for (const pid of watched) {
    spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
  }
  process.exit(0);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'quit') {
      finished = true;
      process.exit(0);
    }
    const match = /^([+-])(\d+)$/.exec(line);
    if (!match) continue;
    if (match[1] === '+') watched.add(Number(match[2]));
    else watched.delete(Number(match[2]));
  }
});
process.stdin.on('end', killAllAndExit);
process.stdin.on('close', killAllAndExit);
process.stdin.on('error', killAllAndExit);

if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    if (!parentAlive()) killAllAndExit();
  }, 1500);
}
