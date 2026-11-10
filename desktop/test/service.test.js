'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ManagedProcess, LaunchError } = require('../src/main/service');
const { RestartPolicy } = require('../src/main/backoff');
const { nextState, transition, TRANSITIONS, STATES } = require('../src/main/stateMachine');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exit = (code = 0) => {
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('exit', code, null));
  };
  return child;
}

function makeService(overrides = {}) {
  const children = [];
  const killed = [];
  const graceful = [];
  const watched = new Set();
  let nextPid = 100;
  const service = new ManagedProcess({
    name: 'lavalink',
    label: 'Lavalink',
    launch: async () => ({ command: 'java', args: [], cwd: '.', env: {} }),
    parseLine: (raw) => ({ level: 'info', message: raw }),
    isReady: (raw) => raw.includes('ready to accept'),
    fatalMessage: (raw) => (raw.startsWith('HATA:') ? raw : null),
    spawn: () => {
      const child = fakeChild(nextPid++);
      children.push(child);
      return child;
    },
    gracefulStop: async (pid) => {
      graceful.push(pid);
      children.find((c) => c.pid === pid)?.exit(0);
    },
    killTree: async (pid) => {
      killed.push(pid);
      children.find((c) => c.pid === pid)?.exit(1);
    },
    watchdog: { add: (pid) => watched.add(pid), remove: (pid) => watched.delete(pid) },
    stopTimeoutMs: 200,
    killWaitMs: 200,
    ...overrides,
  });
  const states = [];
  service.on('state', (s) => states.push(s.state));
  return { service, children, killed, graceful, watched, states };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('state table: every target is a known state and invalid events are rejected', () => {
  for (const [from, events] of Object.entries(TRANSITIONS)) {
    assert.ok(STATES.includes(from));
    for (const to of Object.values(events)) assert.ok(STATES.includes(to), `${from} -> ${to}`);
  }
  assert.equal(nextState('stopped', 'start'), 'starting');
  assert.equal(nextState('starting', 'ready'), 'ready');
  assert.equal(nextState('ready', 'exit'), 'error');
  assert.equal(nextState('stopping', 'exit'), 'stopped');
  assert.equal(nextState('error', 'retry'), 'restarting');
  assert.equal(nextState('stopped', 'ready'), null);
  assert.throws(() => transition('stopped', 'exit'), /Geçersiz durum geçişi/);
});

test('start -> ready on the ready line -> graceful stop', async () => {
  const { service, children, graceful, killed, watched, states } = makeService();
  await service.start();
  assert.equal(service.state, 'starting');
  assert.ok(watched.has(100), 'pid is handed to the watchdog');
  const ready = service.waitReady();
  children[0].stdout.write('Lavalink is ready to accept connections.\n');
  await ready;
  assert.equal(service.state, 'ready');

  await service.stop();
  assert.equal(service.state, 'stopped');
  assert.deepEqual(graceful, [100]);
  assert.deepEqual(killed, []);
  assert.equal(watched.size, 0);
  assert.deepEqual(states, ['starting', 'starting', 'ready', 'stopping', 'stopped']);
});

test('stop force-kills the tree when the polite stop is ignored', async () => {
  const { service, killed } = makeService({ gracefulStop: async () => {} });
  await service.start();
  await service.stop();
  assert.deepEqual(killed, [100]);
  assert.equal(service.state, 'stopped');
});

test('a fatal line becomes the error and prevents automatic restart', async () => {
  const { service, children } = makeService({ autoRestart: () => true });
  await service.start();
  children[0].stderr.write("HATA: Discord token'ı geçersiz.\n");
  await tick();
  children[0].exit(1);
  await wait(20);
  assert.equal(service.state, 'error');
  assert.equal(service.error, "HATA: Discord token'ı geçersiz.");
  assert.equal(children.length, 1, 'no restart');
});

test('launch errors are shown without a restart', async () => {
  const { service, children } = makeService({
    autoRestart: () => true,
    launch: async () => {
      throw new LaunchError('Lavalink.jar yok.');
    },
  });
  await service.start();
  assert.equal(service.state, 'error');
  assert.equal(service.error, 'Lavalink.jar yok.');
  assert.equal(children.length, 0);
});

test('crash restarts with back-off and gives up after the limit', async () => {
  const policy = new RestartPolicy({ baseMs: 10, maxMs: 40, maxAttempts: 3 });
  const { service, children } = makeService({ autoRestart: () => true, policy });
  await service.start();
  const starts = [Date.now()];
  for (let i = 0; i < 3; i += 1) {
    children.at(-1).exit(1);
    await wait(5);
    assert.equal(service.state, 'restarting', `attempt ${i + 1}`);
    assert.match(service.detail, new RegExp(`deneme ${i + 1}/3`));
    while (children.length < i + 2) await wait(2);
    starts.push(Date.now());
  }
  assert.equal(children.length, 4);
  // Delays double: 10, 20, 40 ms (allow timer slack).
  assert.ok(starts[3] - starts[2] >= starts[2] - starts[1], 'back-off grows');

  children.at(-1).exit(1);
  await wait(60);
  assert.equal(service.state, 'error');
  assert.match(service.error, /3 denemeden sonra/);
  assert.equal(children.length, 4, 'no fifth start');
});

test('stop during back-off cancels the pending restart', async () => {
  const policy = new RestartPolicy({ baseMs: 30, maxAttempts: 3 });
  const { service, children } = makeService({ autoRestart: () => true, policy });
  await service.start();
  children[0].exit(1);
  await wait(5);
  assert.equal(service.state, 'restarting');
  await service.stop();
  assert.equal(service.state, 'stopped');
  await wait(60);
  assert.equal(children.length, 1);
});

test('readyProbe marks the process ready without a ready line', async () => {
  let open = false;
  const { service } = makeService({ readyProbe: async () => open, probeIntervalMs: 5 });
  await service.start();
  await wait(15);
  assert.equal(service.state, 'starting');
  open = true;
  await service.waitReady();
  assert.equal(service.state, 'ready');
  await service.stop();
});

test('start timeout kills the process and reports it', async () => {
  const { service, killed } = makeService({ startTimeoutMs: 20 });
  await service.start();
  await assert.rejects(service.waitReady(), /20 saniye|0 saniye|hazır olmadı/);
  assert.deepEqual(killed, [100]);
  assert.equal(service.state, 'error');
});

test('adopted process can be stopped', async () => {
  let alive = true;
  const { service, killed } = makeService({
    gracefulStop: async () => {},
    killTree: async (pid) => {
      killed.push(pid);
      alive = false;
    },
    isAlive: () => alive,
    killWaitMs: 2500,
  });
  service.adopt(4242, { detail: 'önceki oturumdan' });
  assert.equal(service.state, 'ready');
  assert.equal(service.snapshot().adopted, true);
  await service.stop();
  assert.deepEqual(killed, [4242]);
  assert.equal(service.state, 'stopped');
});

test('a process that ran its shutdown hooks but does not exit is ended after the grace period', async () => {
  const { service, children, killed } = makeService({
    gracefulStop: async (pid) => {
      // Ctrl+C handled: the JVM logs its shutdown hook, then hangs (bufferDurationMs: 0).
      children
        .find((c) => c.pid === pid)
        .stdout.write('2026 INFO 1 --- [Lavalink] [ionShutdownHook] io.undertow : stopping server\n');
    },
    shutdownStarted: (raw) => /ShutdownHook\]/.test(raw),
    shutdownGraceMs: 30,
    stopTimeoutMs: 5000,
  });
  const lingering = [];
  service.on('lingering', (e) => lingering.push(e));
  await service.start();
  const started = Date.now();
  await service.stop();
  assert.ok(Date.now() - started < 1000, 'did not wait for the 5 s stop timeout');
  assert.deepEqual(killed, [100]);
  assert.deepEqual(lingering, [{ pid: 100, afterMs: 30 }]);
  assert.equal(service.state, 'stopped');
});

test('a normal exit after the shutdown hook line kills nothing', async () => {
  const { service, children, killed } = makeService({
    gracefulStop: async (pid) => {
      const child = children.find((c) => c.pid === pid);
      child.stdout.write('[ionShutdownHook] stopping\n');
      setTimeout(() => child.exit(0), 5);
    },
    shutdownStarted: (raw) => /ShutdownHook\]/.test(raw),
    shutdownGraceMs: 200,
  });
  await service.start();
  await service.stop();
  await wait(250);
  assert.deepEqual(killed, []);
});
