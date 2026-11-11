// Sesli komut bileşeninin (Python, faster-whisper ve modeller) yeri ve kurulu olup olmadığı. Bileşeni masaüstü
// uygulaması kurar (Araçlar > "Sesli komut bileşenini kur"); proje klasörüne değil kullanıcı verisine yazılır:
//   Windows  %LOCALAPPDATA%\MuzikBot\sesli-komut\   (venv\, models\turbo\, models\small\, kurulum.json)
//   diğer    ~/.local/share/MuzikBot/sesli-komut/
// SESLI_KOMUT_DIZINI ortam değişkeni bu yeri değiştirir (geliştirme ve testler için; masaüstü uygulaması da okur).
// desktop/src/main/sttInstaller.js aynı yerleri ve kurulum.json biçimini kullanır (test/contract.test.js).

import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../config.js';

export const MANIFEST_NAME = 'kurulum.json';
export const MANIFEST_VERSION = 1;
export const MODEL_NAMES = Object.freeze(['turbo', 'small']);
/** The worker script (in the repository; the venv only holds libraries). */
export const WORKER_SCRIPT = join(PROJECT_ROOT, 'stt', 'stt_worker.py');

/** Where the component lives. */
export function componentDir({ env = process.env, platform = process.platform } = {}) {
  if (env.SESLI_KOMUT_DIZINI) return env.SESLI_KOMUT_DIZINI;
  if (platform === 'win32')
    return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'MuzikBot', 'sesli-komut');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'MuzikBot', 'sesli-komut');
}

/** The venv's Python. */
export const pythonPath = (dir, platform = process.platform) =>
  platform === 'win32' ? join(dir, 'venv', 'Scripts', 'python.exe') : join(dir, 'venv', 'bin', 'python');

/**
 * Whether the component is installed and which models it has.
 * @returns {{ kurulu: boolean, dizin: string, profil: 'gpu'|'cpu'|null, modeller: string[] }}
 */
export function componentStatus({ dir = componentDir(), fs = nodeFs, platform = process.platform } = {}) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(join(dir, MANIFEST_NAME), 'utf8'));
  } catch {
    // not installed (or a broken manifest: treated the same)
  }
  const modeller = MODEL_NAMES.filter((name) => fs.existsSync(join(dir, 'models', name, 'model.bin')));
  const ok =
    manifest?.surum === MANIFEST_VERSION &&
    manifest?.durum === 'hazir' &&
    fs.existsSync(pythonPath(dir, platform)) &&
    modeller.length > 0;
  return {
    kurulu: ok,
    dizin: dir,
    profil: ok && ['gpu', 'cpu'].includes(manifest.profil) ? manifest.profil : null,
    modeller,
  };
}
