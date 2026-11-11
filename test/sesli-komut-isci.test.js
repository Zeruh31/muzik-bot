// Sesli komut işçisi: çerçeve protokolü, Node tarafı istemci (sahte işçi süreciyle, gerçek borular) ve yaşam
// döngüsü (çökünce sınırlı yeniden başlatma, sağlık sorusu, temiz kapanış). Python ya da model gerekmez.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkerSupervisor, SttWorker, workerEnv } from '../src/ozellikler/sesli-komut/isci.js';
import { audioFrame, FrameDecoder, jsonFrame, MAX_FRAME } from '../src/ozellikler/sesli-komut/protokol.js';

const FAKE = fileURLToPath(new URL('./yardimci/sahte-stt-isci.js', import.meta.url));
const G = '111111111111111111';
const U = '222222222222222222';
const KEY = `${G}:${U}`;
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** Runs the fake worker with node instead of the venv's Python (same arguments after the script). */
const fakeSpawn = (_python, args, options) => spawn(process.execPath, [FAKE, ...args.slice(4)], options);
const newWorker = (model = 'auto', extra = {}) =>
  new SttWorker({ python: 'python', script: 'stt_worker.py', dir: 'x', model, spawnImpl: fakeSpawn, ...extra });
const nextMessage = (worker, type) =>
  new Promise((resolve) => {
    const on = (message) => {
      if (message.t !== type) return;
      worker.off('message', on);
      resolve(message);
    };
    worker.on('message', on);
  });

describe('sesli komut: çerçeve protokolü', () => {
  it('JSON ve ses çerçeveleri parça parça gelse de aynen çözülür', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const bytes = Buffer.concat([
      jsonFrame({ t: 'ping', id: 1, s: 'ğüşiöç' }),
      audioFrame(KEY, pcm),
      jsonFrame({ t: 'idle', k: KEY }),
    ]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < bytes.length; i += 3) frames.push(...decoder.push(bytes.subarray(i, i + 3)));
    assert.equal(frames.length, 3);
    assert.deepEqual(frames[0].json, { t: 'ping', id: 1, s: 'ğüşiöç' });
    assert.equal(frames[1].key, KEY);
    assert.deepEqual([...frames[1].pcm], [...pcm]);
    assert.deepEqual(frames[2].json, { t: 'idle', k: KEY });
  });

  it('bozuk uzunluk ve geçersiz anahtar reddedilir', () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt32LE(MAX_FRAME + 1, 0);
    assert.throws(() => new FrameDecoder().push(bad), /Bozuk çerçeve/);
    assert.throws(() => audioFrame('../etc', new Int16Array(2)), /Geçersiz ses anahtarı/);
    assert.throws(() => audioFrame(`${G}:${U}:x`, new Int16Array(2)), /Geçersiz ses anahtarı/);
  });

  it('işçiye gizli ortam değişkeni gitmez', () => {
    const env = workerEnv({ PATH: 'p', DISCORD_TOKEN: 'gizli', LAVALINK_PASSWORD: 'x', SystemRoot: 'C:\\Windows' });
    assert.deepEqual(env, { PATH: 'p', SystemRoot: 'C:\\Windows' });
  });
});

describe('sesli komut: işçi istemcisi (sahte işçi süreci)', () => {
  it('hazır olur, sesi cümleye çevirir, ikinci geçişe ve sağlık sorusuna cevap verir, temiz kapanır', async () => {
    const worker = newWorker();
    const ready = await worker.start();
    assert.equal(ready.device, 'cuda');
    assert.equal(worker.state, 'hazir');
    worker.send({ t: 'config', hotwords: 'aç geç' });
    worker.send({ t: 'guild', g: G, wake: 'müzik bot' });
    const pcm = new Int16Array(320).fill(5000);
    for (let i = 0; i < 10; i++) assert.equal(worker.audio(KEY, pcm), true);
    const utt = nextMessage(worker, 'utt');
    worker.send({ t: 'idle', k: KEY });
    const message = await utt;
    assert.equal(message.text, 'müzik bot geç');
    assert.equal(message.dur, 0.2);
    const verified = await worker.verify(message.id);
    assert.equal(verified.text, 'müzik bot geç');
    assert.equal((await worker.verify(message.id)).gone, true, 'held only once');
    const health = await worker.ping();
    assert.equal(health.hotwords, 'aç geç');
    await worker.stop();
    assert.equal(worker.state, 'durdu');
    assert.equal(worker.audio(KEY, pcm), false, 'nothing is sent after it stopped');
  });

  it('"end" ile kişinin biriken sesi işlenmeden atılır', async () => {
    const worker = newWorker();
    await worker.start();
    worker.send({ t: 'guild', g: G, wake: 'müzik bot' });
    worker.audio(KEY, new Int16Array(320).fill(5000));
    worker.send({ t: 'end', k: KEY });
    worker.send({ t: 'idle', k: KEY });
    const health = await worker.ping();
    assert.equal(health.streams, 0);
    await worker.stop();
  });

  it('başlayamayan işçi: fatal mesajı ve hazır olmama süresi', async () => {
    await assert.rejects(
      newWorker('fatal').start(),
      (error) => error.fatal === true && /model yok/.test(error.message),
    );
    const slow = newWorker('slow', { readyTimeoutMs: 300 });
    await assert.rejects(slow.start(), /hazır olmadı/);
  });
});

/** A worker double for the supervisor: start() resolves or rejects as the test says. */
function stubWorker(plan) {
  const worker = Object.assign(new EventEmitter(), {
    state: 'yeni',
    stderrTail: '',
    stopped: false,
    killed: false,
    sent: [],
    async start() {
      if (plan.fail) {
        const error = new Error(plan.fail);
        error.fatal = plan.fatal;
        throw error;
      }
      worker.state = 'hazir';
      return { model: 'turbo', device: 'cuda', loadSec: 0, warmSec: 0 };
    },
    send: (m) => worker.sent.push(m),
    ping: async () => (plan.noPong ? null : { t: 'health' }),
    kill() {
      worker.killed = true;
      worker.state = 'durdu';
      worker.emit('exit', 1);
    },
    async stop() {
      worker.stopped = true;
      worker.state = 'durdu';
    },
  });
  return worker;
}

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timeouts.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn, ms) => {
      const id = ++seq;
      intervals.set(id, { fn, every: ms, at: now + ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timeouts.entries(), ...intervals.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (timeouts.has(id)) timeouts.delete(id);
        else t.at += t.every;
        await t.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('sesli komut: işçinin yaşam döngüsü', () => {
  function setup(plans) {
    const timers = fakeTimers();
    const made = [];
    const readies = [];
    const sup = createWorkerSupervisor({
      createWorker: () => {
        const w = stubWorker(plans[made.length] ?? plans.at(-1));
        made.push(w);
        return w;
      },
      onMessage: () => {},
      onReady: (w) => readies.push(w),
      logger: silent,
      timers,
      now: timers.now,
    });
    return { sup, made, readies, timers };
  }

  it('istenince başlar, bırakılınca durdurulur; tekrar istemek yeni süreç açar', async () => {
    const { sup, made, readies } = setup([{}]);
    sup.want();
    sup.want(); // idempotent
    await flush();
    assert.equal(made.length, 1);
    assert.equal(sup.state().durum, 'hazir');
    assert.equal(sup.worker, made[0]);
    assert.equal(readies.length, 1);
    await sup.release();
    assert.equal(made[0].stopped, true);
    assert.equal(sup.state().durum, 'kapali');
    assert.equal(sup.worker, null);
    sup.want();
    await flush();
    assert.equal(made.length, 2);
  });

  it('çökünce 2, 10, 30 sn sonra yeniden başlar; 10 dakikada 4. çöküşte vazgeçer', async () => {
    const { sup, made, timers } = setup([{}]);
    sup.want();
    await flush();
    for (const [i, wait] of [2000, 10_000, 30_000].entries()) {
      made.at(-1).emit('exit', 1);
      assert.equal(sup.state().durum, 'basliyor');
      await timers.advance(wait - 1);
      assert.equal(made.length, i + 1, 'not before the delay');
      await timers.advance(1);
      await flush();
      assert.equal(made.length, i + 2);
      assert.equal(sup.state().durum, 'hazir');
    }
    made.at(-1).emit('exit', 1);
    await timers.advance(60_000);
    assert.equal(made.length, 4);
    assert.equal(sup.state().durum, 'hata');
    sup.want(); // still "hata": no new attempt until it is released
    assert.equal(made.length, 4);
    await sup.release();
    sup.want();
    await flush();
    assert.equal(made.length, 5, 'a new session tries again');
  });

  it('"hata" durumunda, dinlenen kanal varken 5 dakikada bir yeniden dener', async () => {
    const { sup, made, timers } = setup([{ fail: 'model yok: turbo', fatal: true }, {}]);
    sup.want();
    await flush();
    assert.equal(sup.state().durum, 'hata');
    await timers.advance(5 * 60_000 - 1);
    assert.equal(made.length, 1);
    await timers.advance(1);
    await flush();
    assert.equal(made.length, 2);
    assert.equal(sup.state().durum, 'hazir');
  });

  it('"model yok" gibi kalıcı hatada hemen yeniden denemez', async () => {
    const { sup, made, timers } = setup([{ fail: 'model yok: turbo', fatal: true }]);
    sup.want();
    await flush();
    await timers.advance(120_000);
    assert.equal(made.length, 1, 'not before the long wait');
    assert.equal(sup.state().durum, 'hata');
    assert.match(sup.state().hata, /model yok/);
  });

  it('sağlık sorusuna cevap vermeyen işçi öldürülüp yeniden başlatılır', async () => {
    const { sup, made, timers } = setup([{ noPong: true }, {}]);
    sup.want();
    await flush();
    await timers.advance(30_000);
    assert.equal(made[0].killed, true);
    await timers.advance(2000);
    await flush();
    assert.equal(made.length, 2);
    assert.equal(sup.state().durum, 'hazir');
  });

  it('bırakılan işçinin geç gelen çıkışı yeni işçiyi etkilemez', async () => {
    const { sup, made, timers } = setup([{}]);
    sup.want();
    await flush();
    const old = made[0];
    await sup.release();
    sup.want();
    await flush();
    old.emit('exit', 1);
    await timers.advance(60_000);
    assert.equal(made.length, 2);
    assert.equal(sup.state().durum, 'hazir');
  });

  it('gerçek süreç: çöken sahte işçi yeniden başlatılır', async () => {
    let n = 0;
    const sup = createWorkerSupervisor({
      createWorker: () => newWorker(n++ === 0 ? 'crash' : 'auto'),
      onMessage: () => {},
      logger: silent,
      restartDelaysMs: [50, 50, 50],
    });
    sup.want();
    for (let i = 0; i < 100 && !(n === 2 && sup.state().durum === 'hazir'); i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(n, 2);
    assert.equal(sup.state().durum, 'hazir');
    await sup.release();
  });
});
