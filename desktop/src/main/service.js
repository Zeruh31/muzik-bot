'use strict';

const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const { isActive, nextState } = require('./stateMachine');
const { RestartPolicy } = require('./backoff');

/** A user-facing launch problem (Turkish message, no auto-restart). */
class LaunchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LaunchError';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves true when `promise` settles within `ms`, false otherwise. */
async function settlesWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one hidden child process (Lavalink or the bot) and tracks its state.
 *
 * Events:
 *  - 'state' (snapshot): every state change
 *  - 'line'  ({ stream, raw, parsed }): every output line
 *  - 'forced' ({ pid, afterMs }): the polite stop was ignored, the tree is force-killed
 *  - 'lingering' ({ pid, afterMs }): shutdown hooks ran but the process did not exit; ended
 */
class ManagedProcess extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.name            'lavalink' | 'bot'
   * @param {string} options.label           Turkish name used in messages
   * @param {() => Promise<{command: string, args: string[], cwd: string, env: object}>} options.launch
   * @param {(line: string) => object} options.parseLine
   * @param {(line: string, parsed: object) => boolean} options.isReady
   * @param {(line: string, parsed: object) => string|null} [options.fatalMessage]  a line that explains a fatal error
   * @param {() => Promise<boolean>} [options.readyProbe]  polled while starting (e.g. port check)
   * @param {number} [options.startTimeoutMs]  0 = wait forever
   * @param {number} [options.stopTimeoutMs]   graceful stop wait before force kill
   * @param {(pid: number) => Promise<unknown>} options.gracefulStop
   * @param {(pid: number) => Promise<unknown>} options.killTree
   * @param {(pid: number) => boolean} [options.isAlive]  used for adopted processes
   * @param {Function} options.spawn  child_process.spawn compatible
   * @param {{ add(pid: number): void, remove(pid: number): void }} [options.watchdog]
   * @param {RestartPolicy} [options.policy]
   * @param {() => boolean} [options.autoRestart]
   */
  constructor(options) {
    super();
    this.name = options.name;
    this.label = options.label;
    this.launch = options.launch;
    this.parseLine = options.parseLine;
    this.isReady = options.isReady;
    this.fatalMessage = options.fatalMessage ?? (() => null);
    // A line meaning "my shutdown hooks are running". If the process is still there
    // shutdownGraceMs later, it is ended instead of waiting the whole stopTimeoutMs.
    this.shutdownStarted = options.shutdownStarted ?? (() => false);
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5000;
    this.lingerTimer = null;
    this.readyProbe = options.readyProbe ?? null;
    this.probeIntervalMs = options.probeIntervalMs ?? 1000;
    this.startTimeoutMs = options.startTimeoutMs ?? 0;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    this.killWaitMs = options.killWaitMs ?? 5000;
    this.gracefulStop = options.gracefulStop;
    this.killTree = options.killTree;
    this.isAlive = options.isAlive ?? (() => false);
    this.spawn = options.spawn;
    this.watchdog = options.watchdog ?? { add() {}, remove() {} };
    this.policy = options.policy ?? new RestartPolicy();
    this.autoRestart = options.autoRestart ?? (() => false);

    this.state = 'stopped';
    this.detail = '';
    this.error = null;
    this.pid = null;
    this.adopted = false;
    this.child = null;
    this.fatal = null;
    this.timers = new Set();
    this.exitWaiters = [];
    this.exitSeen = true;
  }

  snapshot() {
    return {
      state: this.state,
      detail: this.detail,
      error: this.error,
      pid: this.pid,
      adopted: this.adopted,
      attempts: this.policy.attempts,
      maxAttempts: this.policy.maxAttempts,
    };
  }

  #apply(event, { detail = '', error = null } = {}) {
    const next = nextState(this.state, event);
    if (!next) return false;
    this.state = next;
    this.detail = detail;
    this.error = error;
    this.emit('state', this.snapshot());
    return true;
  }

  #timer(fn, ms, repeat = false) {
    const handle = repeat
      ? setInterval(fn, ms)
      : setTimeout(() => {
          this.timers.delete(handle);
          fn();
        }, ms);
    this.timers.add(handle);
    return handle;
  }

  #clearTimers() {
    this.lingerTimer = null;
    for (const handle of this.timers) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    this.timers.clear();
  }

  /**
   * Starts the process. `manual` (default) resets the crash counter; automatic restarts
   * pass false so the back-off keeps counting.
   */
  async start({ manual = true } = {}) {
    if (isActive(this.state)) return;
    if (manual) this.policy.reset();
    this.#clearTimers();
    this.fatal = null;
    this.adopted = false;
    if (!this.#apply('start')) return;

    let launch;
    try {
      launch = await this.launch();
    } catch (error) {
      this.#launchFailed(error);
      return;
    }
    if (this.state === 'stopping') {
      this.#apply('exit');
      return;
    }
    if (this.state !== 'starting') return;

    let child;
    try {
      child = this.spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#launchFailed(error);
      return;
    }
    this.child = child;
    this.exitSeen = false;
    this.pid = child.pid ?? null;
    if (this.pid) this.watchdog.add(this.pid);
    this.emit('state', this.snapshot());

    for (const [stream, source] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ]) {
      if (!source) continue;
      source.setEncoding?.('utf8');
      readline.createInterface({ input: source, crlfDelay: Infinity }).on('line', (raw) => this.#line(stream, raw));
    }
    child.once('error', (error) => {
      // ENOENT and friends: there will be no 'exit' when the process never started.
      if (!this.pid) {
        this.fatal ??= `${this.label} başlatılamadı: ${error.message}`;
        this.#exited(null, null);
      }
    });
    child.once('exit', (code, signal) => this.#exited(code, signal));

    if (this.startTimeoutMs > 0) {
      this.#timer(() => {
        if (this.state !== 'starting') return;
        this.fatal ??= `${this.label} ${Math.round(this.startTimeoutMs / 1000)} saniye içinde hazır olmadı.`;
        if (this.pid) this.killTree(this.pid).catch(() => {});
      }, this.startTimeoutMs);
    }
    if (this.readyProbe) {
      const probe = this.#timer(
        async () => {
          if (this.state !== 'starting') {
            clearInterval(probe);
            return;
          }
          if (await this.readyProbe().catch(() => false)) this.#markReady();
        },
        this.probeIntervalMs,
        true,
      );
    }
  }

  #launchFailed(error) {
    const message =
      error instanceof LaunchError ? error.message : `${this.label} başlatılamadı: ${error?.message ?? error}`;
    if (this.state === 'stopping') this.#apply('exit');
    else this.#apply('fail', { error: message });
  }

  #line(stream, raw) {
    const parsed = this.parseLine(raw);
    this.emit('line', { stream, raw, parsed });
    const fatal = this.fatalMessage(raw, parsed);
    if (fatal && !this.fatal) this.fatal = fatal;
    if (this.state === 'starting' && this.isReady(raw, parsed)) this.#markReady();
    if (this.state === 'stopping' && !this.lingerTimer && this.pid && this.shutdownStarted(raw)) {
      const pid = this.pid;
      this.lingerTimer = this.#timer(() => {
        if (this.pid !== pid || this.state !== 'stopping') return;
        this.emit('lingering', { pid, afterMs: this.shutdownGraceMs });
        this.killTree(pid).catch(() => {});
      }, this.shutdownGraceMs);
    }
  }

  #markReady() {
    if (this.state !== 'starting') return;
    this.policy.markUp();
    this.#apply('ready');
  }

  /**
   * Takes over a process this app started earlier (e.g. Lavalink after the app restarted).
   * Its output cannot be read, but it can be stopped and its exit is noticed.
   */
  adopt(pid, { detail = '' } = {}) {
    if (isActive(this.state)) return;
    this.#clearTimers();
    this.fatal = null;
    this.#apply('start');
    this.pid = pid;
    this.adopted = true;
    this.exitSeen = false;
    this.watchdog.add(pid);
    this.policy.markUp();
    this.#apply('ready', { detail });
    this.#timer(
      () => {
        if (this.pid === pid && !this.isAlive(pid)) this.#exited(null, null);
      },
      2000,
      true,
    );
  }

  #exited(code, signal) {
    if (this.exitSeen) return;
    this.exitSeen = true;
    this.#clearTimers();
    if (this.pid) this.watchdog.remove(this.pid);
    this.child = null;
    this.pid = null;
    this.adopted = false;
    const waiters = this.exitWaiters;
    this.exitWaiters = [];

    if (this.state === 'stopping') {
      this.#apply('exit');
    } else if (this.state === 'starting' || this.state === 'ready') {
      const reason = signal ? `sinyal ${signal}` : `çıkış kodu ${code ?? '?'}`;
      const message = this.fatal ?? `${this.label} beklenmedik şekilde kapandı (${reason}).`;
      this.#apply('exit', { error: message });
      this.#maybeRestart(message);
    }
    for (const resolve of waiters) resolve();
  }

  #maybeRestart(message) {
    // A fatal, explained error (bad token, missing file, port in use) will not fix itself.
    if (this.fatal || !this.autoRestart()) return;
    const wait = this.policy.nextDelay();
    if (wait === null) {
      this.error = `${message} ${this.policy.maxAttempts} denemeden sonra otomatik yeniden başlatma durduruldu.`;
      this.emit('state', this.snapshot());
      return;
    }
    const seconds = Math.round(wait / 1000);
    this.#apply('retry', {
      error: message,
      detail: `${seconds} sn sonra yeniden denenecek (deneme ${this.policy.attempts}/${this.policy.maxAttempts}).`,
    });
    this.#timer(() => {
      if (this.state === 'restarting') this.start({ manual: false });
    }, wait);
  }

  #waitExit() {
    if (this.exitSeen) return Promise.resolve();
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /** Stops the process: polite stop first, force-kill the whole tree if it does not exit. */
  async stop() {
    if (this.state === 'stopping') return this.#waitExit();
    if (!isActive(this.state)) {
      this.#clearTimers();
      this.#apply('stop');
      return undefined;
    }
    this.#apply('stop');
    const pid = this.pid;
    if (!pid) return undefined; // still launching; start() finishes the transition
    const exited = this.#waitExit();
    await Promise.race([this.gracefulStop(pid).catch(() => {}), exited]);
    if (!(await settlesWithin(exited, this.stopTimeoutMs))) {
      this.emit('forced', { pid, afterMs: this.stopTimeoutMs });
      await this.killTree(pid).catch(() => {});
      if (!(await settlesWithin(exited, this.killWaitMs)) && this.adopted) this.#exited(null, null);
    }
    return exited;
  }

  /** Waits until the process is ready; rejects with the error message if it fails or stops. */
  waitReady() {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.state === 'ready') return finish(resolve);
        if (this.state === 'error' || this.state === 'restarting' || this.state === 'stopped') {
          return finish(() => reject(new Error(this.error ?? `${this.label} durduruldu.`)));
        }
        return undefined;
      };
      const finish = (fn) => {
        this.off('state', check);
        fn();
      };
      this.on('state', check);
      check();
    });
  }

  /** Synchronous last-resort cleanup (app is crashing). */
  killNow(killSync) {
    if (this.pid) killSync(this.pid);
  }
}

module.exports = { ManagedProcess, LaunchError, delay, settlesWithin };
