// Kalıcı zamanlayıcı: "şu saatte şunu yap" işleri data/zamanlayici.json dosyasında tutulur.
// Bot kapalıyken zamanı geçen işler açılışta çalıştırılır (ör. çekiliş bitişi, ücretsiz oyun kontrolü).
// Modüller kendi iş türlerini tanımlarındaki `isler` alanıyla kaydeder. Normalde bu dosyaya dokunmana gerek yok.
//
// SÖZLEŞME (iş yazanlar için): her iş EN AZ BİR KEZ çalışır. İş önce "calisiyor" diye işaretlenir,
// yalnız işleyici başarıyla bitince dosyadan silinir. Bot iş çalışırken kapanırsa, işleyici hata verirse
// ya da 60 saniyede bitmezse iş yeniden çalışır (artan beklemeyle en fazla 5 kez; sonra "basarisiz" diye
// saklanır; yarıda kalan açılışlar da deneme sayılır). Aynı iş aynı anda iki kez çalışmaz.
// Bu yüzden her işleyici İKİ KEZ ÇALIŞMAYA DAYANIKLI (idempotent) olmalı: örneğin çekiliş zaten
// sonuçlandıysa ikinci kez kazanan seçmemeli, aynı duyuruyu iki kez göndermemeli.

import { randomUUID } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { readJsonOrBackup, writeJsonAtomic } from '../util/atomicFile.js';
import { OzellikHatasi } from './_yonlendirici.js';

export const SCHEDULER_SCHEMA_VERSION = 1;
/** Node's setTimeout fires at once for anything longer (about 24.8 days); longer waits are split. */
export const MAX_TIMEOUT_MS = 2_147_483_647;
/** A failing job is tried again this many times (waits double from RETRY_BASE_MS), then kept as failed. */
export const MAX_RETRIES = 5;
export const RETRY_BASE_MS = 30_000;
/** A handler that has not finished after this long counts as failed (it is tried again later). */
export const JOB_TIMEOUT_MS = 60_000;

const JOB_ID = /^[\w.-]{1,80}$/;
const JOB_TYPE = /^[a-z][a-z0-9-]{1,19}\.[a-z][a-z0-9-]{0,31}$/;
const STATES = new Set(['bekliyor', 'calisiyor', 'basarisiz']);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The real clock. Tests pass a fake one with the same three functions. */
export const systemClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer),
});

function sanitizeJob(raw) {
  if (!isPlainObject(raw)) return null;
  const { id, zaman, tur, veri, durum = 'bekliyor', deneme = 0 } = raw;
  if (typeof id !== 'string' || !JOB_ID.test(id) || typeof tur !== 'string' || !JOB_TYPE.test(tur)) return null;
  if (!Number.isFinite(zaman) || !STATES.has(durum) || !Number.isInteger(deneme) || deneme < 0) return null;
  const job = { id, zaman, tur, veri: isPlainObject(veri) ? veri : {}, durum, deneme };
  if (typeof raw.sonHata === 'string') job.sonHata = raw.sonHata.slice(0, 300);
  return job;
}

/**
 * @param {object} deps
 * @param {string} deps.file data/zamanlayici.json
 * @param {{ now: () => number, setTimeout: Function, clearTimeout: Function }} [deps.clock]
 */
export function createScheduler({ file, clock = systemClock, logger, fs = nodeFs, timeoutMs = JOB_TIMEOUT_MS }) {
  /** "modul.tur" -> async (veri, context, job) => {} */
  const types = new Map();
  /** id -> job */
  const jobs = new Map();
  /** Entries this version cannot read; written back untouched so nothing is lost. */
  const foreign = Object.create(null);
  const timers = new Map();
  /** Ids whose handler is running right now (also one that timed out but has not settled yet). */
  const inFlight = new Set();
  let context = null;
  let running = false;

  const { data, backup, error } = readJsonOrBackup(
    file,
    { schemaVersion: SCHEDULER_SCHEMA_VERSION, isler: {} },
    { fs },
  );
  if (error) {
    logger?.warn(`Zamanlayıcı dosyası okunamadı (${error.message}); boş başlıyor. Eski dosya: ${backup ?? '-'}`);
  }
  // A file from a newer bot version is never written back in an older format: read-only, nothing runs.
  const readOnly = Number(data.schemaVersion) > SCHEDULER_SCHEMA_VERSION;
  if (readOnly) {
    logger?.warn(
      `data/zamanlayici.json daha yeni bir bot sürümüne ait (şema ${data.schemaVersion}); dosyaya dokunulmuyor ` +
        've zamanlanmış işler çalıştırılmıyor. Botu güncelleyin.',
    );
  } else {
    for (const [key, raw] of Object.entries(isPlainObject(data.isler) ? data.isler : {})) {
      const job = sanitizeJob(raw);
      if (job && job.id === key) jobs.set(job.id, job);
      else if (JOB_ID.test(key)) foreign[key] = raw;
    }
  }

  function save() {
    if (readOnly) throw new OzellikHatasi('Zamanlayıcı dosyası daha yeni bir bot sürümüne ait; değiştirilemez.');
    const isler = Object.assign(Object.create(null), foreign);
    for (const job of jobs.values()) isler[job.id] = job;
    writeJsonAtomic(file, { schemaVersion: SCHEDULER_SCHEMA_VERSION, isler }, { fs });
  }

  /** Saves; a failure is logged only (the job is then simply run again after a restart: at least once). */
  function trySave(what) {
    try {
      save();
    } catch (saveError) {
      logger?.warn(`Zamanlayıcı dosyası yazılamadı (${what}): ${saveError?.message ?? saveError}`);
    }
  }

  function disarm(id) {
    const timer = timers.get(id);
    if (timer !== undefined) clock.clearTimeout(timer);
    timers.delete(id);
  }

  function arm(job) {
    disarm(job.id);
    const wait = Math.min(Math.max(job.zaman - clock.now(), 0), MAX_TIMEOUT_MS);
    timers.set(
      job.id,
      clock.setTimeout(() => {
        timers.delete(job.id);
        if (job.zaman - clock.now() > 0)
          arm(job); // a split long wait, or the clock fired early
        else run(job);
      }, wait),
    );
  }

  /** Runs the handler; rejects when it has not finished within timeoutMs (it may still finish later). */
  function runWithTimeout(handler, job) {
    const work = Promise.resolve().then(() => handler(job.veri, context, job));
    inFlight.add(job.id);
    work.then(
      () => inFlight.delete(job.id),
      () => inFlight.delete(job.id),
    );
    let timer;
    const limit = new Promise((resolve, reject) => {
      timer = clock.setTimeout(() => reject(new Error(`zaman aşımı (${Math.round(timeoutMs / 1000)} sn)`)), timeoutMs);
    });
    return Promise.race([work, limit]).finally(() => clock.clearTimeout(timer));
  }

  async function run(job) {
    if (!running || jobs.get(job.id) !== job || job.durum === 'basarisiz') return;
    // Never two runs of one job at a time: a run that timed out may still be going.
    if (inFlight.has(job.id)) {
      job.zaman = clock.now() + RETRY_BASE_MS;
      arm(job);
      return;
    }
    const handler = types.get(job.tur);
    if (!handler) {
      logger?.warn(`Zamanlayıcı: "${job.tur}" türü kayıtlı değil (modül kapalı olabilir); iş saklanıyor.`);
      return;
    }
    job.durum = 'calisiyor';
    trySave('başladı');
    try {
      await runWithTimeout(handler, job);
    } catch (jobError) {
      if (jobs.get(job.id) !== job) return; // cancelled while it ran
      job.deneme += 1;
      job.sonHata = String(jobError?.message ?? jobError).slice(0, 300);
      if (job.deneme > MAX_RETRIES) {
        job.durum = 'basarisiz';
        logger?.error(
          `Zamanlanmış iş (${job.tur}, ${job.id}) ${MAX_RETRIES} yeniden denemeden sonra da başarısız; saklandı:`,
          jobError,
        );
        trySave('başarısız');
        return;
      }
      job.durum = 'bekliyor';
      job.zaman = clock.now() + RETRY_BASE_MS * 2 ** (job.deneme - 1);
      logger?.warn(`Zamanlanmış iş (${job.tur}) başarısız, ${job.deneme}. kez yeniden denenecek: ${job.sonHata}`);
      trySave('yeniden deneme');
      if (running) arm(job);
      return;
    }
    if (jobs.get(job.id) === job) jobs.delete(job.id);
    trySave('bitti');
  }

  return {
    /** Whether the file belongs to a newer bot version (nothing is written or run then). */
    saltOkunur: readOnly,

    /**
     * Registers what a job type does. `tur` is "<modul>.<is>", e.g. "cekilis.bitir".
     * The handler must be safe to run twice (see the contract at the top of this file).
     */
    turKaydet(tur, handler) {
      if (!JOB_TYPE.test(tur) || typeof handler !== 'function') throw new Error(`Geçersiz iş türü: ${tur}`);
      types.set(tur, handler);
    },

    /**
     * Plans a job. Throws when the file cannot be written (nothing is planned then).
     * @returns {string} the job id (a new one unless `id` was given; the same id replaces a job)
     */
    planla({ id = randomUUID(), zaman, tur, veri = {} }) {
      const job = sanitizeJob({ id, zaman, tur, veri });
      if (!job || !types.has(tur)) throw new Error(`Geçersiz ya da kayıtsız iş: ${tur}`);
      const previous = jobs.get(job.id);
      jobs.set(job.id, job);
      try {
        save();
      } catch (saveError) {
        if (previous) jobs.set(job.id, previous);
        else jobs.delete(job.id);
        throw saveError;
      }
      if (running) arm(job);
      return job.id;
    },

    /** Cancels a job (also a failed one). @returns {boolean} false when there was no such job */
    iptal(id) {
      const job = jobs.get(id);
      if (!job) return false;
      jobs.delete(id);
      try {
        save();
      } catch (saveError) {
        jobs.set(id, job);
        throw saveError;
      }
      disarm(id);
      return true;
    },

    /** Planned and failed jobs, soonest first (copies). */
    bekleyenler() {
      return [...jobs.values()].sort((a, b) => a.zaman - b.zaman).map((job) => ({ ...job }));
    },

    /**
     * Starts the timers. Jobs that became due while the bot was off, and jobs that were running when
     * it stopped, run now, oldest first. Failed jobs are kept and not run.
     * @returns {Promise<void>} resolves when those catch-up jobs have finished
     */
    async baslat(ctx) {
      context = ctx;
      running = !readOnly;
      if (!running) return;
      const now = clock.now();
      const due = [];
      let crashed = false;
      for (const job of [...jobs.values()].sort((a, b) => a.zaman - b.zaman)) {
        if (job.durum === 'basarisiz') continue;
        if (job.durum === 'calisiyor') {
          // The bot stopped while this job ran: that counts as a failed try, so a job that
          // crashes the bot every time ends up "basarisiz" instead of running forever.
          crashed = true;
          job.deneme += 1;
          job.sonHata = 'bot iş çalışırken kapandı';
          if (job.deneme > MAX_RETRIES) {
            job.durum = 'basarisiz';
            logger?.error(
              `Zamanlanmış iş (${job.tur}, ${job.id}) her seferinde yarıda kaldı; "basarisiz" olarak saklandı.`,
            );
            continue;
          }
          job.durum = 'bekliyor';
          due.push(job);
        } else if (job.zaman <= now) due.push(job);
        else arm(job);
      }
      if (crashed) trySave('açılış');
      for (const job of due) await run(job);
    },

    /** Stops every timer; planned jobs stay in the file for the next start. */
    durdur() {
      running = false;
      for (const id of [...timers.keys()]) disarm(id);
    },
  };
}
