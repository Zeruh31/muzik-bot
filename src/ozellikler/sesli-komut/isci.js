// Konuşma tanıma işçisi (stt/stt_worker.py) ile konuşan taraf ve işçinin yaşam döngüsü.
//   - İşçi yalnız sesli komutu açık bir sunucuda bot ses kanalındayken çalışır; son böyle kanal kapanınca öldürülür
//     (GPU belleği tamamen boşalır). Ara boşlukta modeli bellekten atma yok (ısınma gecikmesi).
//   - Çökerse sınırlı yeniden başlatma: 2 sn, 10 sn, 30 sn; 10 dakikada 3 çöküşten (ya da "model yok" gibi
//     kalıcı bir hatadan) sonra "hata" durumuna geçer ve dinlenen kanal varken 5 dakikada bir yeniden dener.
//   - 30 sn'de bir sağlık sorusu; 15 sn içinde cevap gelmezse işçi öldürülüp yeniden başlatılır.
//   - İşçiye gizli bilgi gitmez: ortam değişkenleri süzülür (.env değerleri, token yok); işçi ağa çıkmaz.
// Normalde bu dosyaya dokunmana gerek yok.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { audioFrame, FrameDecoder, jsonFrame } from './protokol.js';

/** Environment variables the worker may see (no tokens or other .env values). */
const SAFE_ENV = [
  'SystemRoot', // process.env is case-insensitive on Windows: one spelling each
  'windir',
  'PATH',
  'TEMP',
  'TMP',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
  'HOME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // nvidia-smi (free GPU memory) finds NVML under Program Files; without these it fails
  'ProgramFiles',
  'ProgramW6432',
  'SystemDrive',
  'CUDA_PATH',
  'CUDA_VISIBLE_DEVICES',
  'LANG',
];
/** Audio is dropped (not queued) while this much is waiting for the worker's stdin. */
const MAX_PENDING_STDIN = 1 << 20;

export function workerEnv(env = process.env) {
  const out = {};
  for (const name of SAFE_ENV) if (env[name] !== undefined) out[name] = env[name];
  return out;
}

/** One worker process. Emits 'message' (JSON from the worker other than replies) and 'exit' (code, signal). */
export class SttWorker extends EventEmitter {
  #python;
  #args;
  #spawn;
  #readyTimeoutMs;
  #env;
  #child = null;
  #decoder = new FrameDecoder();
  #replies = new Map(); // "verified:<id>" / "health:<id>" -> resolve
  #nextPing = 1;
  #stderrTail = [];
  state = 'yeni';
  info = null;
  droppedFrames = 0;

  constructor({
    python,
    script,
    dir,
    model = 'auto',
    device = 'auto',
    cpuBeam = 1,
    spawnImpl = spawn,
    readyTimeoutMs = 120_000,
    env = process.env,
  }) {
    super();
    this.#python = python;
    this.#args = [
      '-I',
      '-X',
      'utf8',
      script,
      '--root',
      dir,
      '--model',
      model,
      '--device',
      device,
      '--cpu-beam',
      String(cpuBeam),
    ];
    this.#spawn = spawnImpl;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#env = workerEnv(env);
  }

  /** The last lines the worker wrote to stderr (for the log when it fails). */
  get stderrTail() {
    return this.#stderrTail.join('\n');
  }

  /** Starts the process; resolves with its "ready" message, rejects when it fails to come up. */
  start() {
    if (this.#child) throw new Error('İşçi zaten başlatıldı');
    this.state = 'basliyor';
    const child = this.#spawn(this.#python, this.#args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.#env,
    });
    this.#child = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        settle(reject, new Error(`İşçi ${Math.round(this.#readyTimeoutMs / 1000)} sn içinde hazır olmadı`));
        this.kill();
      }, this.#readyTimeoutMs);
      timer.unref?.();
      child.stdout.on('data', (chunk) => {
        let frames;
        try {
          frames = this.#decoder.push(chunk);
        } catch (error) {
          settle(reject, error);
          this.kill();
          return;
        }
        for (const frame of frames) {
          const message = frame.json;
          if (!message || typeof message !== 'object') continue;
          if (message.t === 'ready') {
            this.state = 'hazir';
            this.info = message;
            settle(resolve, message);
          } else if (message.t === 'fatal') {
            this.state = 'hata';
            const error = new Error(String(message.msg ?? 'işçi başlatılamadı'));
            error.fatal = true;
            settle(reject, error);
          } else if (message.t === 'verified' || message.t === 'retried' || message.t === 'health') {
            const key = `${message.t}:${message.id}`;
            const reply = this.#replies.get(key);
            this.#replies.delete(key);
            reply?.(message);
          } else {
            this.emit('message', message);
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.#stderrTail.push(line.slice(0, 300));
          if (this.#stderrTail.length > 20) this.#stderrTail.shift();
        }
      });
      child.stdin.on('error', () => {}); // EPIPE after the worker died; 'exit' tells the rest
      child.once('error', (error) => settle(reject, error));
      child.once('exit', (code, signal) => {
        this.state = 'durdu';
        for (const reply of this.#replies.values()) reply(null);
        this.#replies.clear();
        settle(reject, new Error(`İşçi kapandı (çıkış kodu ${code ?? signal})`));
        this.emit('exit', code, signal);
      });
    });
  }

  #write(buffer) {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    stdin.write(buffer);
    return true;
  }

  send(message) {
    return this.#write(jsonFrame(message));
  }

  /** Sends audio of one speaker; dropped while the worker is behind (it is speech, late is useless). */
  audio(key, pcm) {
    if (this.state !== 'hazir') return false;
    if ((this.#child?.stdin?.writableLength ?? 0) > MAX_PENDING_STDIN) {
      this.droppedFrames++;
      return false;
    }
    return this.#write(audioFrame(key, pcm));
  }

  #ask(kind, id, message, timeoutMs) {
    return new Promise((resolve) => {
      const key = `${kind}:${id}`;
      const timer = setTimeout(() => {
        this.#replies.delete(key);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.#replies.set(key, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      if (!this.send(message)) {
        clearTimeout(timer);
        this.#replies.delete(key);
        resolve(null);
      }
    });
  }

  /** Second pass on an utterance the worker still holds; null when it is gone or the worker is too slow. */
  verify(id, timeoutMs = 8000) {
    return this.#ask('verified', id, { t: 'verify', id }, timeoutMs);
  }

  /**
   * A pass without any prompt on an utterance the worker still holds (the wake-phrase prompt can make Whisper
   * leave the wake phrase out). Null when it is gone or the worker is too slow.
   */
  retry(id, { hotwords = true, timeoutMs = 8000 } = {}) {
    return this.#ask('retried', id, { t: 'retry', id, hotwords }, timeoutMs);
  }

  ping(timeoutMs = 15_000) {
    const id = this.#nextPing++;
    return this.#ask('health', id, { t: 'ping', id }, timeoutMs);
  }

  kill() {
    try {
      this.#child?.kill();
    } catch {
      // already gone
    }
  }

  /** Asks the worker to exit, kills it after `graceMs`. Resolves when the process is gone. */
  stop({ graceMs = 3000 } = {}) {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null || this.state === 'durdu')
      return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.kill(), graceMs);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.send({ t: 'shutdown' });
      try {
        child.stdin.end();
      } catch {
        this.kill();
      }
    });
  }
}

/**
 * Keeps one worker running while it is wanted.
 * @param {object} deps
 * @param {() => SttWorker} deps.createWorker
 * @param {(message: object) => void} deps.onMessage utterances and skips from the worker
 * @param {(worker: SttWorker) => void} [deps.onReady] after every (re)start: send the configuration again
 * @param {() => void} [deps.onChange] the state changed (status file)
 */
export function createWorkerSupervisor({
  createWorker,
  onMessage,
  onReady = () => {},
  onChange = () => {},
  logger,
  timers = globalThis,
  now = Date.now,
  restartDelaysMs = [2000, 10_000, 30_000],
  restartWindowMs = 10 * 60_000,
  pingEveryMs = 30_000,
  pingTimeoutMs = 15_000,
  errorRetryMs = 5 * 60_000,
}) {
  let wanted = false;
  let worker = null;
  let state = { durum: 'kapali', cihaz: null, model: null, hata: null };
  let crashes = [];
  let restartTimer = null;
  let pingTimer = null;
  let generation = 0;

  const setState = (next) => {
    state = { ...state, ...next };
    onChange(state);
  };
  const clearTimers = () => {
    if (restartTimer) timers.clearTimeout(restartTimer);
    if (pingTimer) timers.clearInterval(pingTimer);
    restartTimer = null;
    pingTimer = null;
  };

  function failed(gen, error) {
    if (gen !== generation) return;
    clearTimers();
    worker = null;
    if (!wanted) return;
    const at = now();
    crashes = crashes.filter((t) => at - t < restartWindowMs);
    crashes.push(at);
    const delay = error?.fatal ? null : restartDelaysMs[crashes.length - 1];
    if (delay === undefined || delay === null) {
      setState({ durum: 'hata', hata: String(error?.message ?? error).slice(0, 200) });
      logger?.error(
        `Sesli komut işçisi durdu: ${error?.message ?? error}. ${Math.round(errorRetryMs / 60_000)} dakika sonra yeniden denenecek.`,
      );
      restartTimer = timers.setTimeout(() => {
        restartTimer = null;
        if (wanted) launch();
      }, errorRetryMs);
      restartTimer?.unref?.();
      return;
    }
    setState({ durum: 'basliyor', hata: String(error?.message ?? error).slice(0, 200) });
    logger?.warn(`Sesli komut işçisi kapandı (${error?.message ?? error}); ${delay / 1000} sn sonra yeniden başlıyor.`);
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      if (wanted) launch();
    }, delay);
    restartTimer?.unref?.();
  }

  function launch() {
    const gen = ++generation;
    const next = createWorker();
    worker = next;
    setState({ durum: 'basliyor', cihaz: null, model: null });
    next.on('message', (message) => {
      if (gen === generation) onMessage(message);
    });
    next.once('exit', () => {
      if (gen === generation && state.durum === 'hazir')
        failed(gen, new Error(`çıkış: ${next.stderrTail.split('\n').at(-1) || '?'}`));
    });
    next.start().then(
      (info) => {
        if (gen !== generation) return;
        setState({ durum: 'hazir', cihaz: info.device ?? null, model: info.model ?? null, hata: null });
        logger?.info(
          `Sesli komut işçisi hazır: ${info.model} / ${info.device} (yükleme ${info.loadSec} sn, ısınma ${info.warmSec} sn)`,
        );
        onReady(next);
        pingTimer = timers.setInterval(async () => {
          const reply = await next.ping(pingTimeoutMs);
          if (gen !== generation || reply) return;
          logger?.warn('Sesli komut işçisi sağlık sorusuna cevap vermedi; yeniden başlatılıyor.');
          next.kill();
        }, pingEveryMs);
        pingTimer?.unref?.();
      },
      (error) => {
        if (next.stderrTail) logger?.debug(`Sesli komut işçisi çıktısı:\n${next.stderrTail}`);
        failed(gen, error);
      },
    );
  }

  return {
    /** Starts the worker unless it runs (or is waiting to restart). */
    want() {
      if (wanted && (worker || restartTimer)) return;
      wanted = true;
      if (!worker && !restartTimer) launch();
    },
    /** Stops it: no voice channel needs it any more. */
    async release() {
      wanted = false;
      generation++;
      clearTimers();
      crashes = [];
      const old = worker;
      worker = null;
      setState({ durum: 'kapali', cihaz: null, model: null, hata: null });
      await old?.stop();
    },
    /** Stops and starts it again (another model). Does nothing when it is not wanted. */
    async restart() {
      if (!wanted) return;
      await this.release();
      this.want();
    },
    /** The worker when it is ready, else null. */
    get worker() {
      return worker?.state === 'hazir' ? worker : null;
    },
    get wanted() {
      return wanted;
    },
    state: () => ({ ...state }),
  };
}
