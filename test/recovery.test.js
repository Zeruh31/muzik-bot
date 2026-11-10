// Scenario: Lavalink (the audio SOURCE) drops while the bot keeps playing. The voice connection
// is the bot's own, so only the stream of the current track is cut. These tests drive the
// events the engine and the REST monitor emit and check what startNodeRecovery does.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { startNodeRecovery } from '../src/music/recovery.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const GUILD = '222222222222222222';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await tick(5);
  }
}

function track(title) {
  return { encoded: `enc-${title}`, info: { title, duration: 200_000, isSeekable: true, isStream: false } };
}

function setup({ twentyFourSeven = false, connected = false, restartFails = false, waitTimeoutMs = 300 } = {}) {
  const engine = new EventEmitter();
  engine.players = new Map();
  const lavalink = new EventEmitter();
  lavalink.connected = connected;

  const data = new Map();
  const calls = [];
  const player = {
    guildId: GUILD,
    queue: { current: track('çalan'), tracks: [track('sıradaki')] },
    position: 60_000,
    paused: false,
    playing: true,
    destroyed: false,
    getData: (k) => data.get(k),
    setData: (k, v) => data.set(k, v),
    async suspend() {
      calls.push(['suspend']);
      this.playing = false;
    },
    async restartCurrent(position, options) {
      calls.push(['restart', position, options]);
      if (restartFails) throw new Error('video gone');
      this.playing = !options?.paused;
    },
    async skip() {
      calls.push(['skip']);
    },
    async stopPlaying() {
      calls.push(['stopPlaying']);
      this.queue.current = null;
    },
    async destroy(reason) {
      calls.push(['destroy', reason]);
      this.destroyed = true;
      engine.players.delete(GUILD);
      engine.emit('playerDestroy', this, reason);
    },
  };
  engine.players.set(GUILD, player);

  const notices = [];
  const stopHooks = [];
  const music = { onStopRequest: (fn) => stopHooks.push(fn) };
  const recovery = startNodeRecovery({
    lavalink,
    engine,
    music,
    config: { music: { twentyFourSeven } },
    logger: silent,
    notify: async (guildId, text) => notices.push([guildId, text]),
    waitTimeoutMs,
  });
  const lose = () => engine.emit('sourceLost', player, { position: 61_000, paused: false });
  const drop = () => {
    lavalink.connected = false;
    lavalink.emit('disconnect', lavalink, { reason: 'ECONNREFUSED' });
  };
  const back = () => {
    lavalink.connected = true;
    lavalink.emit('connect', lavalink);
  };
  const stop = () => stopHooks.map((fn) => fn(GUILD)).some(Boolean);
  return { engine, lavalink, player, calls, notices, recovery, data, lose, drop, back, stop };
}

describe('audio source recovery', () => {
  it('a lost source flags the player, waits for Lavalink and restarts the track where it was', async () => {
    const t = setup();
    t.lose();
    await until(() => t.calls.some((c) => c[0] === 'suspend'));
    assert.equal(t.data.get('recovering'), true);
    assert.equal(t.recovery.isRecovering(GUILD), true);
    t.back();
    await until(() => t.calls.some((c) => c[0] === 'restart'));
    assert.deepEqual(t.calls.at(-1), ['restart', 61_000, { paused: false }]);
    await until(() => t.notices.length === 1);
    assert.match(t.notices[0][1], /kaldığım yerden devam/);
    assert.equal(t.data.get('recovering'), false);
    assert.equal(t.recovery.isRecovering(GUILD), false);
  });

  it('the REST monitor noticing the drop first suspends playing players at their position', async () => {
    const t = setup();
    t.drop();
    await until(() => t.calls.some((c) => c[0] === 'suspend'));
    t.lose(); // the stream breaks a moment later: no second record, the first snapshot stays
    t.back();
    await until(() => t.calls.some((c) => c[0] === 'restart'));
    assert.deepEqual(
      t.calls.filter((c) => c[0] === 'restart'),
      [['restart', 60_000, { paused: false }]],
    );
  });

  it('keeps a paused track paused after the restart', async () => {
    const t = setup();
    t.player.paused = true;
    t.engine.emit('sourceLost', t.player, { position: 5000, paused: true });
    await tick();
    t.back();
    await until(() => t.calls.some((c) => c[0] === 'restart'));
    assert.deepEqual(t.calls.at(-1), ['restart', 5000, { paused: true }]);
  });

  it('restarts at once when the source broke while Lavalink is still reachable', async () => {
    const t = setup({ connected: true });
    t.lose();
    await until(() => t.calls.some((c) => c[0] === 'restart'));
    assert.equal(t.recovery.isRecovering(GUILD), false);
  });

  it('a source lost again during the restart starts a new recovery from the newer position', async () => {
    const t = setup();
    let release;
    const gate = new Promise((r) => (release = r));
    const original = t.player.restartCurrent.bind(t.player);
    t.player.restartCurrent = async (position, options) => {
      await gate; // the restart is in progress ...
      return original(position, options);
    };
    t.lose();
    await tick();
    t.back(); // attempt starts and waits at the gate
    await tick();
    t.lavalink.connected = false; // ... and Lavalink drops again, so does the source
    t.engine.emit('sourceLost', t.player, { position: 70_000, paused: false });
    release();
    await until(() => t.calls.filter((c) => c[0] === 'suspend').length === 2);
    assert.equal(t.recovery.isRecovering(GUILD), true, 'a second recovery is pending');
    assert.ok(!t.notices.some((n) => /kaldığım yerden/.test(n[1])), 'no premature "resumed" notice');
    t.back();
    await until(() => t.calls.filter((c) => c[0] === 'restart').length === 2);
    assert.deepEqual(t.calls.filter((c) => c[0] === 'restart').at(-1), ['restart', 70_000, { paused: false }]);
    await until(() => t.notices.length === 1);
    assert.equal(t.recovery.isRecovering(GUILD), false);
  });

  it('a track that cannot be resumed is announced and skipped', async () => {
    const t = setup({ restartFails: true });
    t.lose();
    await tick();
    t.back();
    await until(() => t.calls.some((c) => c[0] === 'skip'));
    assert.match(t.notices[0][1], /sürdürülemedi/);
    assert.equal(t.data.get('recovering'), false);
  });

  it('Lavalink never comes back: the bot leaves with a Turkish notice', async () => {
    const t = setup({ waitTimeoutMs: 100 });
    t.lose();
    await until(() => t.calls.some((c) => c[0] === 'destroy'));
    assert.match(t.notices[0][1], /Kanaldan ayrıldım/);
    assert.equal(t.recovery.isRecovering(GUILD), false);
  });

  it('Lavalink never comes back in 24/7 mode: playback stops but the bot stays in the channel', async () => {
    const t = setup({ waitTimeoutMs: 100, twentyFourSeven: true });
    t.lose();
    await until(() => t.calls.some((c) => c[0] === 'stopPlaying'));
    assert.ok(!t.calls.some((c) => c[0] === 'destroy'));
    assert.match(t.notices[0][1], /kanalda kalıyorum/);
  });

  describe('users acting during a recovery', () => {
    it('/stop cancels the wait: nothing happens when Lavalink returns', async () => {
      const t = setup();
      t.lose();
      await tick();
      assert.equal(t.stop(), true, 'the stop hook reports a cancelled recovery');
      t.back();
      await tick(20);
      assert.ok(!t.calls.some((c) => c[0] === 'restart'));
      assert.deepEqual(t.notices, []);
      assert.equal(t.data.get('recovering'), false);
    });

    it('a kick (player destroyed) cancels the recovery without a notice', async () => {
      const t = setup();
      t.lose();
      await tick();
      await t.player.destroy('Ses kanalından çıkarıldı');
      t.back();
      await tick(20);
      assert.ok(!t.calls.some((c) => c[0] === 'restart'));
      assert.deepEqual(t.notices, []);
    });

    it('the stop hook returns false when nothing is being recovered', () => {
      const t = setup();
      assert.equal(t.stop(), false);
    });
  });

  it('stop() forgets pending recoveries and stops listening', async () => {
    const t = setup();
    t.lose();
    await tick();
    t.recovery.stop();
    assert.equal(t.recovery.isRecovering(GUILD), false);
    t.back();
    await tick(20);
    assert.ok(!t.calls.some((c) => c[0] === 'restart'));
  });
});
