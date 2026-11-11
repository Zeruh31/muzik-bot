// The persistent scheduler (data/zamanlayici.json) with a fake clock: planning, cancelling, catching
// up on jobs that became due while the bot was off, exactly-once runs and long waits.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createScheduler,
  JOB_TIMEOUT_MS,
  MAX_RETRIES,
  MAX_TIMEOUT_MS,
  RETRY_BASE_MS,
} from '../src/ozellikler/_zamanlayici.js';

const dirs = [];
function newFile() {
  const dir = mkdtempSync(join(tmpdir(), 'muzikbot-zaman-'));
  dirs.push(dir);
  return join(dir, 'zamanlayici.json');
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A clock whose time only moves with advance(); timers fire in order. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('persistent scheduler', () => {
  it('runs a job at its time, exactly once, and removes it from the file', async () => {
    const file = newFile();
    const clock = fakeClock();
    const runs = [];
    const scheduler = createScheduler({ file, clock });
    scheduler.turKaydet('ornek.bitir', async (veri) => runs.push(veri.n));
    await scheduler.baslat({});
    scheduler.planla({ id: 'is-1', zaman: clock.now() + 5000, tur: 'ornek.bitir', veri: { n: 1 } });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).isler['is-1'].tur, 'ornek.bitir');
    await clock.advance(4999);
    assert.deepEqual(runs, []);
    await clock.advance(1);
    await flush();
    assert.deepEqual(runs, [1]);
    await clock.advance(60_000);
    assert.deepEqual(runs, [1]);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).isler, {});
  });

  it('a cancelled job never runs', async () => {
    const clock = fakeClock();
    const runs = [];
    const scheduler = createScheduler({ file: newFile(), clock });
    scheduler.turKaydet('ornek.bitir', async () => runs.push('x'));
    await scheduler.baslat({});
    const id = scheduler.planla({ zaman: clock.now() + 1000, tur: 'ornek.bitir' });
    assert.equal(scheduler.iptal(id), true);
    assert.equal(scheduler.iptal(id), false);
    await clock.advance(5000);
    assert.deepEqual(runs, []);
    assert.equal(clock.pending(), 0);
  });

  it('after a restart, jobs that became due while the bot was off run once, oldest first; later ones wait', async () => {
    const file = newFile();
    const first = fakeClock(1_000_000);
    const before = createScheduler({ file, clock: first });
    before.turKaydet('cekilis.bitir', async () => {});
    before.planla({ id: 'b', zaman: 1_002_000, tur: 'cekilis.bitir', veri: { ad: 'b' } });
    before.planla({ id: 'a', zaman: 1_001_000, tur: 'cekilis.bitir', veri: { ad: 'a' } });
    before.planla({ id: 'c', zaman: 1_100_000, tur: 'cekilis.bitir', veri: { ad: 'c' } });
    // The bot was never started (or was closed) before those times: nothing ran.

    const later = fakeClock(1_050_000);
    const runs = [];
    const after1 = createScheduler({ file, clock: later });
    after1.turKaydet('cekilis.bitir', async (veri, context) => runs.push(`${veri.ad}:${context.etiket}`));
    await after1.baslat({ etiket: 'ctx' });
    assert.deepEqual(runs, ['a:ctx', 'b:ctx']);
    assert.deepEqual(
      after1.bekleyenler().map((j) => j.id),
      ['c'],
    );

    // A second restart does not run them again.
    const again = createScheduler({ file, clock: fakeClock(1_060_000) });
    again.turKaydet('cekilis.bitir', async (veri) => runs.push(`tekrar:${veri.ad}`));
    await again.baslat({});
    assert.deepEqual(runs, ['a:ctx', 'b:ctx']);
    await later.advance(50_000);
    assert.deepEqual(runs, ['a:ctx', 'b:ctx', 'c:ctx']);
  });

  it('waits longer than setTimeout allows (about 24.8 days) are split', async () => {
    const clock = fakeClock(0);
    const runs = [];
    const scheduler = createScheduler({ file: newFile(), clock });
    scheduler.turKaydet('ornek.uzun', async () => runs.push('uzun'));
    await scheduler.baslat({});
    scheduler.planla({ zaman: MAX_TIMEOUT_MS * 2 + 10, tur: 'ornek.uzun' });
    await clock.advance(MAX_TIMEOUT_MS);
    assert.deepEqual(runs, []);
    await clock.advance(MAX_TIMEOUT_MS);
    assert.deepEqual(runs, []);
    await clock.advance(10);
    await flush();
    assert.deepEqual(runs, ['uzun']);
  });

  it('jobs of a module that is not registered stay in the file; unknown types cannot be planned', async () => {
    const file = newFile();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        isler: {
          x: { id: 'x', zaman: 1, tur: 'kapali.is', veri: {} },
          bozuk: { id: 'bozuk', zaman: 'yarın', tur: 'kapali.is' },
        },
      }),
    );
    const warnings = [];
    const scheduler = createScheduler({ file, clock: fakeClock(), logger: { warn: (t) => warnings.push(t) } });
    await scheduler.baslat({});
    assert.deepEqual(
      scheduler.bekleyenler().map((j) => j.id),
      ['x'],
    );
    assert.ok(warnings.some((w) => /kayıtlı değil/.test(w)));
    assert.throws(() => scheduler.planla({ zaman: 5, tur: 'yok.is' }), /kayıtsız/);
    // Entries it cannot read are written back untouched when the file is saved.
    scheduler.turKaydet('ornek.is', async () => {});
    scheduler.planla({ id: 'yeni', zaman: 9e12, tur: 'ornek.is' });
    const saved = JSON.parse(readFileSync(file, 'utf8')).isler;
    assert.deepEqual(Object.keys(saved).sort(), ['bozuk', 'x', 'yeni']);
    assert.equal(saved.bozuk.zaman, 'yarın');
  });

  it('a failing job does not stop the others and is tried again with growing waits (at least once)', async () => {
    const file = newFile();
    const clock = fakeClock();
    const runs = [];
    const warnings = [];
    const errors = [];
    const scheduler = createScheduler({
      file,
      clock,
      logger: { warn: (t) => warnings.push(t), error: (t) => errors.push(t) },
    });
    let failuresLeft = 2;
    scheduler.turKaydet('ornek.gecici', async () => {
      runs.push('gecici');
      if (failuresLeft-- > 0) throw new Error('Discord 503');
    });
    scheduler.turKaydet('ornek.iyi', async () => runs.push('iyi'));
    scheduler.planla({ id: 'g', zaman: clock.now() - 2, tur: 'ornek.gecici' });
    scheduler.planla({ zaman: clock.now() - 1, tur: 'ornek.iyi' });
    await scheduler.baslat({});
    assert.deepEqual(runs, ['gecici', 'iyi']);
    const [kept] = scheduler.bekleyenler();
    assert.equal(kept.id, 'g', 'not lost after a temporary error');
    assert.equal(kept.deneme, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).isler.g.durum, 'bekliyor');
    await clock.advance(RETRY_BASE_MS - 1);
    assert.equal(runs.length, 2);
    await clock.advance(1);
    await flush();
    assert.equal(runs.length, 3, 'first retry after RETRY_BASE_MS');
    await clock.advance(RETRY_BASE_MS * 2);
    await flush();
    assert.equal(runs.length, 4, 'second retry after twice as long, and it succeeds');
    assert.deepEqual(scheduler.bekleyenler(), []);
    assert.equal(errors.length, 0);
  });

  it(`after ${MAX_RETRIES} retries a job is kept as "basarisiz", logged and not run again`, async () => {
    const file = newFile();
    const clock = fakeClock();
    let runs = 0;
    const errors = [];
    const scheduler = createScheduler({ file, clock, logger: { warn() {}, error: (t) => errors.push(t) } });
    scheduler.turKaydet('ornek.bozuk', async () => {
      runs += 1;
      throw new Error('hep bozuk');
    });
    await scheduler.baslat({});
    scheduler.planla({ id: 'b', zaman: clock.now(), tur: 'ornek.bozuk' });
    for (let i = 0; i < 10; i += 1) {
      await clock.advance(RETRY_BASE_MS * 2 ** 6);
      await flush();
    }
    assert.equal(runs, MAX_RETRIES + 1);
    assert.equal(errors.length, 1);
    const saved = JSON.parse(readFileSync(file, 'utf8')).isler.b;
    assert.equal(saved.durum, 'basarisiz');
    assert.equal(saved.sonHata, 'hep bozuk');
    // A restart does not run it again either.
    const again = createScheduler({ file, clock: fakeClock() });
    again.turKaydet('ornek.bozuk', async () => (runs += 1));
    await again.baslat({});
    assert.equal(runs, MAX_RETRIES + 1);
  });

  it('a job that was running when the bot stopped runs again after the restart', async () => {
    const file = newFile();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        isler: { r: { id: 'r', zaman: 9_999_999_999, tur: 'ornek.is', veri: {}, durum: 'calisiyor', deneme: 0 } },
      }),
    );
    const runs = [];
    const scheduler = createScheduler({ file, clock: fakeClock() });
    scheduler.turKaydet('ornek.is', async () => runs.push('r'));
    await scheduler.baslat({});
    assert.deepEqual(runs, ['r']);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).isler, {});
  });

  it('a crash while a job ran counts as a try: its deneme goes up, and a job that always crashes ends up failed', async () => {
    const file = newFile();
    const crashed = (deneme) =>
      JSON.stringify({
        schemaVersion: 1,
        isler: { r: { id: 'r', zaman: 1, tur: 'ornek.is', veri: {}, durum: 'calisiyor', deneme } },
      });
    writeFileSync(file, crashed(2));
    const seen = [];
    const scheduler = createScheduler({ file, clock: fakeClock() });
    scheduler.turKaydet('ornek.is', async (veri, context, job) => {
      seen.push(job.deneme);
      throw new Error('yine olmadı');
    });
    await scheduler.baslat({});
    assert.deepEqual(seen, [3], 'the crash was counted before the run');

    writeFileSync(file, crashed(MAX_RETRIES));
    const errors = [];
    const last = createScheduler({ file, clock: fakeClock(), logger: { warn() {}, error: (t) => errors.push(t) } });
    let runs = 0;
    last.turKaydet('ornek.is', async () => (runs += 1));
    await last.baslat({});
    assert.equal(runs, 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).isler.r.durum, 'basarisiz');
    assert.match(errors[0], /yarıda kaldı/);
  });

  it(`a handler that does not finish in ${JOB_TIMEOUT_MS / 1000} s fails, and never runs twice at the same time`, async () => {
    const clock = fakeClock();
    const scheduler = createScheduler({ file: newFile(), clock, logger: { warn() {}, error() {} } });
    let running = 0;
    let maxRunning = 0;
    let starts = 0;
    let release;
    scheduler.turKaydet('ornek.yavas', async () => {
      starts += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      if (starts === 1) await new Promise((resolve) => (release = resolve)); // hangs until released
      running -= 1;
    });
    await scheduler.baslat({});
    scheduler.planla({ id: 'y', zaman: clock.now(), tur: 'ornek.yavas' });
    await clock.advance(0);
    await flush();
    assert.equal(starts, 1);
    await clock.advance(JOB_TIMEOUT_MS);
    await flush();
    const [job] = scheduler.bekleyenler();
    assert.equal(job.deneme, 1);
    assert.match(job.sonHata, /zaman aşımı/);
    // The retry is due while the first run still hangs: it waits instead of running alongside.
    await clock.advance(RETRY_BASE_MS);
    await flush();
    assert.equal(starts, 1);
    release();
    await flush();
    await clock.advance(RETRY_BASE_MS);
    await flush();
    assert.equal(starts, 2);
    assert.equal(maxRunning, 1);
    assert.deepEqual(scheduler.bekleyenler(), []);
  });

  it('a file from a newer version is read-only: nothing runs, nothing is written', async () => {
    const file = newFile();
    const text = JSON.stringify({
      schemaVersion: 2,
      isler: { x: { id: 'x', zaman: 1, tur: 'ornek.is', yeniAlan: 1 } },
    });
    writeFileSync(file, text);
    const warnings = [];
    const runs = [];
    const scheduler = createScheduler({ file, clock: fakeClock(), logger: { warn: (t) => warnings.push(t) } });
    scheduler.turKaydet('ornek.is', async () => runs.push('x'));
    await scheduler.baslat({});
    assert.equal(scheduler.saltOkunur, true);
    assert.deepEqual(runs, []);
    assert.throws(() => scheduler.planla({ zaman: 5, tur: 'ornek.is' }), /daha yeni/);
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.match(warnings[0], /daha yeni bir bot sürümüne/);
  });
});
