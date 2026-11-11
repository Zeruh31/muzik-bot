'use strict';

// Installs the optional voice command component (Araçlar > "Sesli komut bileşenini kur"): a Python venv made
// with uv, the pinned packages of <project>/stt/requirements(-gpu).txt and the speech models
// (<project>/stt/model_indir.py, pinned commits, SHA-256 checked). It goes to the user's data, never into the
// project: %LOCALAPPDATA%\MuzikBot\sesli-komut (SESLI_KOMUT_DIZINI overrides it, the bot reads the same).
// The same folder layout and kurulum.json format are read by src/ozellikler/sesli-komut/kurulum.js (the bot).
// Every path is built here in the main process; the window only chooses "gpu" or "cpu".

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MANIFEST_NAME = 'kurulum.json';
const MANIFEST_VERSION = 1;
const MODEL_NAMES = Object.freeze(['turbo', 'small']);
const PROFILES = Object.freeze(['gpu', 'cpu']);
/** Approximate download + disk use, shown before installing. */
const SIZES = Object.freeze({ gpu: '≈ 4 GB', cpu: '≈ 1 GB' });
/** model.bin sizes, for the progress bar while a model downloads. */
const MODEL_BYTES = Object.freeze({ turbo: 1_617_884_929, small: 483_546_902 });
const PYTHON_VERSION = '3.14';

function componentDir(env = process.env, platform = process.platform, home = require('node:os').homedir()) {
  if (env.SESLI_KOMUT_DIZINI) return env.SESLI_KOMUT_DIZINI;
  if (platform === 'win32')
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'MuzikBot', 'sesli-komut');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'MuzikBot', 'sesli-komut');
}

const pythonPath = (dir, platform = process.platform) =>
  platform === 'win32' ? path.join(dir, 'venv', 'Scripts', 'python.exe') : path.join(dir, 'venv', 'bin', 'python');

/** uv.exe on PATH or in the folders its own installer uses. */
function findUv(env = process.env, exists = fs.existsSync) {
  const dirs = String(env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const home = env.USERPROFILE || env.HOME || '';
  if (home) dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'));
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  const name = process.platform === 'win32' ? 'uv.exe' : 'uv';
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** What install() creates in the component folder; remove() deletes these and nothing else. */
const OWN_ENTRIES = Object.freeze(['venv', 'models', MANIFEST_NAME]);

/**
 * Why a folder must never be the component folder (a drive root, the user's profile or another top
 * folder), or null. SESLI_KOMUT_DIZINI could point anywhere.
 */
function unsafeDirReason(dir, env = process.env) {
  if (!dir || !path.isAbsolute(dir)) return 'klasör yolu tam değil';
  const resolved = path.resolve(dir);
  // path.resolve drops trailing separators (except a root's); Windows paths are case-insensitive.
  const norm = (p) => path.resolve(p).toLowerCase();
  if (norm(resolved) === norm(path.parse(resolved).root)) return 'bir sürücü kökü';
  const roots = [env.USERPROFILE, env.HOME, env.LOCALAPPDATA, env.APPDATA, env.ProgramFiles, env.SystemRoot].filter(
    Boolean,
  );
  if (roots.some((r) => norm(r) === norm(resolved))) return 'kullanıcı profili ya da bir sistem klasörü';
  return null;
}

function readManifest(dir, fsImpl = fs) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeManifest(dir, manifest, fsImpl = fs) {
  fsImpl.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MANIFEST_NAME);
  const temp = `${file}.${process.pid}.yaziliyor`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(temp, file);
}

/**
 * 'kurulu-degil' | 'yarim' (an install was interrupted) | 'hazir', with the profile and the models present.
 * Same rule as the bot: "hazir" in kurulum.json, the venv's Python and at least one model.
 */
function componentStatus({ dir = componentDir(), fsImpl = fs, platform = process.platform } = {}) {
  const manifest = readManifest(dir, fsImpl);
  const modeller = MODEL_NAMES.filter((name) => fsImpl.existsSync(path.join(dir, 'models', name, 'model.bin')));
  const python = fsImpl.existsSync(pythonPath(dir, platform));
  const ready = manifest?.surum === MANIFEST_VERSION && manifest.durum === 'hazir' && python && modeller.length > 0;
  return {
    durum: ready ? 'hazir' : manifest || python ? 'yarim' : 'kurulu-degil',
    profil: PROFILES.includes(manifest?.profil) ? manifest.profil : null,
    modeller,
    dizin: dir,
  };
}

/**
 * The steps of an install, in order. Pure: tested without running anything.
 * @returns {{ ad: string, aciklama: string, command: string, args: string[], model?: string }[]}
 */
function planInstall({ profile, projectDir, dir, uvPath, platform = process.platform }) {
  if (!PROFILES.includes(profile)) throw new Error('Geçersiz profil');
  const python = pythonPath(dir, platform);
  const requirements = path.join(projectDir, 'stt', profile === 'gpu' ? 'requirements-gpu.txt' : 'requirements.txt');
  const models = profile === 'gpu' ? ['turbo', 'small'] : ['small'];
  return [
    {
      ad: 'venv',
      aciklama: `Python ${PYTHON_VERSION} ortamı hazırlanıyor (uv)`,
      command: uvPath,
      args: ['venv', '--allow-existing', '--python', PYTHON_VERSION, path.join(dir, 'venv')],
    },
    {
      ad: 'paketler',
      aciklama:
        profile === 'gpu'
          ? 'Paketler indiriliyor: faster-whisper ve NVIDIA CUDA kütüphaneleri (≈ 2 GB)'
          : 'Paketler indiriliyor: faster-whisper (≈ 300 MB)',
      command: uvPath,
      // Hash-locked (stt/requirements*.txt, made by "uv pip compile --generate-hashes") and wheels only:
      // nothing is built from source, a changed file on the index is refused.
      args: ['pip', 'install', '--python', python, '--require-hashes', '--only-binary', ':all:', '-r', requirements],
    },
    ...models.map((model) => ({
      ad: `model-${model}`,
      aciklama: `Model indiriliyor: ${model} (${Math.round(MODEL_BYTES[model] / 1e6)} MB)`,
      command: python,
      args: [
        '-I',
        '-X',
        'utf8',
        path.join(projectDir, 'stt', 'model_indir.py'),
        '--out',
        path.join(dir, 'models'),
        '--models',
        model,
      ],
      model,
    })),
  ];
}

function folderBytes(dir, fsImpl = fs) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fsImpl.statSync(p).size;
        } catch {
          // file vanished
        }
      }
    }
  };
  walk(dir);
  return total;
}

/** Only what a step needs: no tokens or other secrets of the app's environment. */
function stepEnv(env = process.env) {
  const out = {};
  for (const name of [
    'SystemRoot',
    'windir',
    'PATH',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'HOME',
    'ProgramFiles',
    'ProgramW6432',
    'SystemDrive',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'UV_CACHE_DIR',
    'UV_PYTHON_INSTALL_DIR',
  ]) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  out.HF_HUB_DISABLE_TELEMETRY = '1';
  out.UV_NO_PROGRESS = '1';
  return out;
}

/**
 * @param {object} deps
 * @param {() => string|null} deps.getProjectDir
 * @param {(event: object) => void} deps.onProgress { asama, aciklama, yuzde, adim, adimSayisi }
 * @param {(level: string, text: string) => void} deps.log
 * @param {(pid: number) => void} [deps.killTree]
 */
function createSttInstaller({
  getProjectDir,
  onProgress = () => {},
  log = () => {},
  killTree = null,
  env = process.env,
  spawnImpl = spawn,
  fsImpl = fs,
  dir = componentDir(env),
  findUvImpl = findUv,
}) {
  let busy = null; // { child, cancelled }

  function runStep(step, onLine) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(step.command, step.args, {
          env: stepEnv(env),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: -1, tail: error.message });
        return;
      }
      busy.child = child;
      const tail = [];
      const take = (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line.trim()) continue;
          tail.push(line.slice(0, 300));
          if (tail.length > 12) tail.shift();
          onLine?.(line);
        }
      };
      child.stdout?.on('data', take);
      child.stderr?.on('data', take);
      child.once('error', (error) => resolve({ code: -1, tail: error.message }));
      child.once('close', (code) => resolve({ code: code ?? -1, tail: tail.join('\n') }));
    });
  }

  return {
    get busy() {
      return Boolean(busy);
    },
    dir,
    status: () => componentStatus({ dir, fsImpl }),
    /**
     * Installs (or repairs/continues) the component. Resolves { ok, message }; never throws.
     * @param {'gpu'|'cpu'} profile
     */
    async install(profile) {
      if (busy) return { ok: false, message: 'Kurulum zaten sürüyor.' };
      if (!PROFILES.includes(profile)) return { ok: false, message: 'Geçersiz seçim.' };
      const unsafe = unsafeDirReason(dir, env);
      if (unsafe) return { ok: false, message: `Kurulum yeri uygun değil (${dir}: ${unsafe}).` };
      const projectDir = getProjectDir();
      if (!projectDir || !fsImpl.existsSync(path.join(projectDir, 'stt', 'stt_worker.py')))
        return { ok: false, message: 'Proje klasöründe stt\\stt_worker.py yok. Botu güncelleyin.' };
      const uvPath = findUvImpl(env);
      if (!uvPath)
        return {
          ok: false,
          message:
            'uv bulunamadı. https://docs.astral.sh/uv/ adresindeki komutla kurun, sonra uygulamayı yeniden açın.',
        };
      const steps = planInstall({ profile, projectDir, dir, uvPath });
      busy = { child: null, cancelled: false };
      try {
        writeManifest(
          dir,
          { surum: MANIFEST_VERSION, durum: 'kuruluyor', profil: profile, baslangic: new Date().toISOString() },
          fsImpl,
        );
        for (const [i, step] of steps.entries()) {
          const base = { asama: step.ad, aciklama: step.aciklama, adim: i + 1, adimSayisi: steps.length };
          onProgress({ ...base, yuzde: null });
          log('info', `Sesli komut kurulumu (${i + 1}/${steps.length}): ${step.aciklama}`);
          let timer = null;
          if (step.model) {
            const folder = path.join(dir, 'models', step.model);
            timer = setInterval(() => {
              const got = folderBytes(folder, fsImpl);
              onProgress({ ...base, yuzde: Math.min(99, Math.round((got / MODEL_BYTES[step.model]) * 100)) });
            }, 1000);
          }
          const result = await runStep(step).finally(() => timer && clearInterval(timer));
          if (busy.cancelled) {
            log('warn', 'Sesli komut kurulumu iptal edildi.');
            return {
              ok: false,
              cancelled: true,
              message: 'Kurulum iptal edildi. Yeniden başlatınca kaldığı yerden devam eder.',
            };
          }
          if (result.code !== 0) {
            log('error', `Sesli komut kurulumu başarısız (${step.ad}): ${result.tail}`);
            return { ok: false, message: `Adım başarısız: ${step.aciklama}. Ayrıntı kayıtlarda.`, output: result.tail };
          }
        }
        const modeller = MODEL_NAMES.filter((m) => fsImpl.existsSync(path.join(dir, 'models', m, 'model.bin')));
        writeManifest(
          dir,
          { surum: MANIFEST_VERSION, durum: 'hazir', profil: profile, modeller, kuruldu: new Date().toISOString() },
          fsImpl,
        );
        onProgress({ asama: 'bitti', aciklama: 'Kuruldu', yuzde: 100, adim: steps.length, adimSayisi: steps.length });
        log('info', `Sesli komut bileşeni kuruldu (${profile === 'gpu' ? 'GPU' : 'CPU'}): ${dir}`);
        return {
          ok: true,
          message: "Sesli komut bileşeni kuruldu. Sunucuda açmak için Discord'da: /ayar sesli-komut acik deger:True",
        };
      } catch (error) {
        log('error', `Sesli komut kurulumu: ${error.message}`);
        return { ok: false, message: `Kurulum yapılamadı: ${error.message}` };
      } finally {
        busy = null;
      }
    },
    /** Stops the running step (its whole process tree). The next install continues where it stopped. */
    cancel() {
      if (!busy) return false;
      busy.cancelled = true;
      const pid = busy.child?.pid;
      if (pid) {
        if (killTree) killTree(pid);
        else busy.child.kill();
      }
      return true;
    },
    /** Deletes the whole component folder (venv and models). Not while installing. */
    remove() {
      if (busy) return { ok: false, message: 'Kurulum sürerken kaldırılamaz; önce İptal.' };
      const unsafe = unsafeDirReason(dir, env);
      if (unsafe) return { ok: false, message: `Kaldırılmadı: ${unsafe}` };
      // Only what this installer made, and only where it left its manifest: never "the whole folder".
      if (!readManifest(dir, fsImpl))
        return {
          ok: false,
          message: `Kaldırılmadı: ${dir} içinde ${MANIFEST_NAME} yok (bu klasörü uygulama kurmamış).`,
        };
      try {
        for (const name of OWN_ENTRIES) {
          fsImpl.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 });
        }
        try {
          fsImpl.rmdirSync(dir); // only when nothing else is left in it
        } catch {
          // other files of the user stay
        }
        log('info', `Sesli komut bileşeni kaldırıldı: ${dir}`);
        return { ok: true, message: 'Sesli komut bileşeni kaldırıldı.' };
      } catch (error) {
        return { ok: false, message: `Kaldırılamadı (dosyalar kullanımda olabilir; botu durdurun): ${error.message}` };
      }
    },
  };
}

module.exports = {
  MANIFEST_NAME,
  MANIFEST_VERSION,
  MODEL_NAMES,
  PROFILES,
  SIZES,
  componentDir,
  componentStatus,
  createSttInstaller,
  unsafeDirReason,
  findUv,
  planInstall,
  pythonPath,
  stepEnv,
};
