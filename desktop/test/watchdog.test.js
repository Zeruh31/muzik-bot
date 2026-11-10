'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { isAlive, killTreeSync } = require('../src/main/winproc');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(100);
  }
  return check();
}

// A stand-in for the Electron main process: starts the watchdog and a long-running child,
// registers the child, prints both PIDs and then waits to be killed.
const FAKE_APP = `
const { spawn } = require('node:child_process');
const { startWatchdog } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'main', 'watchdogClient.js'))});
const guard = startWatchdog();
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
guard.add(child.pid);
console.log(JSON.stringify({ child: child.pid, guard: guard.pid }));
setInterval(() => {}, 1000);
`;

test('watchdog kills registered children when the app is killed', { skip: process.platform !== 'win32' }, async () => {
  const app = spawn(process.execPath, ['-e', FAKE_APP], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const info = await new Promise((resolve) => app.stdout.once('data', (d) => resolve(JSON.parse(String(d)))));
  try {
    assert.ok(isAlive(info.child), 'child runs');
    assert.ok(isAlive(info.guard), 'guard runs');
    await wait(300);
    // Hard kill of the "app" only (not its tree): simulates a crash.
    process.kill(app.pid, 'SIGKILL');
    assert.ok(await waitFor(() => !isAlive(info.child), 8000), 'orphaned child was killed by the watchdog');
    assert.ok(await waitFor(() => !isAlive(info.guard), 3000), 'watchdog exited');
  } finally {
    killTreeSync(info.child);
    killTreeSync(info.guard);
  }
});

test('watchdog leaves children alone after "quit"', { skip: process.platform !== 'win32' }, async () => {
  const { startWatchdog } = require('../src/main/watchdogClient');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const guard = startWatchdog();
  try {
    guard.add(child.pid);
    guard.remove(child.pid);
    guard.add(child.pid);
    guard.quit();
    assert.ok(await waitFor(() => !isAlive(guard.pid), 3000), 'watchdog exited');
    assert.ok(isAlive(child.pid), 'child was not killed');
  } finally {
    killTreeSync(child.pid);
  }
});
