// ffmpeg'i bulur ve ses akışını Discord'un istediği biçime (48 kHz, 2 kanal, 16 bit PCM)
// çeviren komut satırını kurar. Bas güçlendirme de burada bir ffmpeg filtresidir.
// Normalde dokunmana gerek yok.

import { spawnSync } from 'node:child_process';

/**
 * ffmpeg audio filters per /bassboost level. `bass` lifts the low shelf; `alimiter` keeps the
 * boosted signal from clipping when it is converted to 16-bit samples.
 */
export const BASSBOOST_FILTERS = Object.freeze({
  none: null,
  low: 'bass=g=5:f=110:w=0.6,alimiter=limit=0.95:level=false',
  medium: 'bass=g=10:f=110:w=0.6,alimiter=limit=0.95:level=false',
  high: 'bass=g=15:f=110:w=0.6,alimiter=limit=0.95:level=false',
});

/** The audio filter chain for a level, or null when nothing has to be applied. */
export function audioFilter({ bassboost = 'none' } = {}) {
  return BASSBOOST_FILTERS[bassboost] ?? null;
}

/**
 * Protocols ffmpeg may open (-protocol_whitelist). A piped input may open nothing else, so a
 * crafted file (an HLS or concat list inside) cannot make ffmpeg fetch anything. A network input
 * (SoundCloud's HLS address) may only use HTTPS: no plain http, no file, no other scheme.
 */
export const PIPE_PROTOCOLS = 'pipe';
export const HTTPS_PROTOCOLS = 'https,tls,tcp,crypto';
/** A network read that stalls this long fails (microseconds, ffmpeg's rw_timeout). */
const NETWORK_TIMEOUT_US = 15_000_000;

/**
 * Command line arguments that turn the source (any container ffmpeg knows: WebM/Opus, MP4/AAC,
 * MP3, HLS, ...) into raw PCM on stdout. The input is stdin (`pipe:0`, default) or an https URL
 * given as a separate argv entry (never through a shell). `seekMs` skips into the track: with a
 * pipe input ffmpeg decodes and discards until that point, which is fast for audio; an HLS input
 * jumps to the right segment. `maxDurationMs` stops the output there.
 */
export function buildFfmpegArgs({ seekMs = 0, bassboost = 'none', input = 'pipe:0', maxDurationMs = null } = {}) {
  const network = input !== 'pipe:0';
  if (network && !/^https:\/\//i.test(input)) throw new TypeError('ffmpeg ağ girdisi yalnız https olabilir');
  const args = ['-hide_banner', '-loglevel', 'error'];
  args.push('-protocol_whitelist', network ? HTTPS_PROTOCOLS : PIPE_PROTOCOLS);
  if (network) args.push('-rw_timeout', String(NETWORK_TIMEOUT_US));
  if (Number.isFinite(seekMs) && seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3));
  args.push('-i', input, '-vn', '-sn', '-dn');
  if (Number.isFinite(maxDurationMs) && maxDurationMs > 0) args.push('-t', (maxDurationMs / 1000).toFixed(3));
  const filter = audioFilter({ bassboost });
  if (filter) args.push('-af', filter);
  args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
  return args;
}

let cached;

/**
 * Path of the ffmpeg executable: `ffmpeg` on PATH when it runs, otherwise the binary from the
 * optional `ffmpeg-static` package. Resolved once; null when neither exists.
 */
export async function findFfmpeg({ probe = probeSystemFfmpeg, loadStatic = loadStaticFfmpeg } = {}) {
  if (cached !== undefined) return cached;
  cached = probe() ? 'ffmpeg' : await loadStatic();
  return cached;
}

/** For tests: forget the cached result. */
export function resetFfmpegCache() {
  cached = undefined;
}

function probeSystemFfmpeg() {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return result.status === 0 && /^ffmpeg version/.test(result.stdout ?? '');
  } catch {
    return false;
  }
}

async function loadStaticFfmpeg() {
  try {
    const mod = await import('ffmpeg-static');
    const path = mod.default ?? mod;
    return typeof path === 'string' && path ? path : null;
  } catch {
    return null;
  }
}
