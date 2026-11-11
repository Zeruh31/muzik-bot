// Doğrudan ses bağlantıları (https://.../sarki.mp3 gibi): bağlantının gerçekten ses olduğunu
// denetler, süresini ölçer ve çalarken sesi güvenli biçimde indirir (src/music/netGuard.js).
// Normalde dokunmana gerek yok.

import { spawn } from 'node:child_process';
import { muzik as M } from '../mesajlar.js';
import { ErrorCodes, MusicError } from './errors.js';
import { ResumableBody, UnsafeUrlError, openSafeHttp, parseContentRange } from './netGuard.js';

/** File endings that mark a link as a direct audio file. */
export const DIRECT_AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.ogg', '.m4a', '.wav', '.flac', '.opus']);
/** A direct file may not be larger than this (also enforced while playing). */
export const DIRECT_MAX_BYTES = 100 * 1024 * 1024;
/** A direct file may not be longer than this (ffmpeg stops there while playing too). */
export const DIRECT_MAX_DURATION_MS = 3 * 60 * 60 * 1000;
/** A live direct stream (internet radio) is played at most this long in one go. */
export const DIRECT_LIVE_MAX_MS = 12 * 60 * 60 * 1000;
/** How long the duration probe may take at most. */
const PROBE_TIMEOUT_MS = 60_000;
/** How much of a live stream is decoded to check that it is audio. */
const LIVE_PROBE_SECONDS = 3;

/** Content types that are lists of further links (HLS, m3u, pls), never played directly. */
const PLAYLIST_TYPES = new Set([
  'audio/x-mpegurl',
  'audio/mpegurl',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/x-scpls',
  'application/pls+xml',
]);
/** Generic types some servers send for any file; then the file ending decides. */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** True when the path of an http(s) URL ends in one of DIRECT_AUDIO_EXTENSIONS. */
export function hasAudioExtension(text) {
  try {
    const url = new URL(String(text));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const path = url.pathname.toLowerCase();
    return DIRECT_AUDIO_EXTENSIONS.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

/** Whether a Content-Type (lower case, without parameters) is a playable audio type. */
export function isAudioContentType(type, { url } = {}) {
  const value = String(type ?? '').toLowerCase();
  if (PLAYLIST_TYPES.has(value)) return false;
  if (value.startsWith('audio/') || value === 'application/ogg') return true;
  return GENERIC_TYPES.has(value) && hasAudioExtension(url);
}

/** A readable title from the file name of a URL ("Benim%20Sarkim.mp3" -> "Benim Sarkim"). */
export function titleFromUrl(text) {
  try {
    const url = new URL(String(text));
    const last = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    let name = last;
    try {
      name = decodeURIComponent(last);
    } catch {
      // keep the raw name
    }
    name = name
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[_+]+/g, ' ')
      .trim();
    return name.slice(0, 200) || url.hostname;
  } catch {
    return String(text).slice(0, 200);
  }
}

/** The Lavalink-like track object the bot uses for a direct link. */
export function directTrack({ url, title, author, durationMs, live }) {
  return {
    encoded: null,
    info: {
      identifier: url,
      title: title || titleFromUrl(url),
      author: author || new URL(url).hostname,
      duration: live ? 0 : Math.max(0, Math.round(durationMs ?? 0)),
      length: live ? 0 : Math.max(0, Math.round(durationMs ?? 0)),
      isStream: Boolean(live),
      isSeekable: !live,
      position: 0,
      uri: url,
      artworkUrl: null,
      isrc: null,
      sourceName: 'http',
    },
    pluginInfo: {},
  };
}

/** ffmpeg arguments of the probe: decode the piped body to nothing and report progress. */
export function probeArgs({ live }) {
  const limitSeconds = live ? LIVE_PROBE_SECONDS : Math.ceil(DIRECT_MAX_DURATION_MS / 1000) + 1;
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    '-protocol_whitelist',
    'pipe',
    '-i',
    'pipe:0',
    '-vn',
    '-sn',
    '-dn',
    '-t',
    String(limitSeconds),
    '-progress',
    'pipe:1',
    '-f',
    'null',
    '-',
  ];
}

/**
 * Reads `-progress` output (key=value lines) and the info log of an ffmpeg probe:
 * the decoded duration in ms and the title/artist tags of the input, when present.
 */
export function parseProbeOutput(progress, log) {
  let outTimeUs = null;
  for (const match of String(progress ?? '').matchAll(/^out_time_us=(\d+)$/gm)) outTimeUs = Number(match[1]);
  const input = String(log ?? '').split(/^Output #0/m)[0];
  const tag = (name) => input.match(new RegExp(`^\\s+${name}\\s*:\\s*(.+)$`, 'mi'))?.[1]?.trim() || null;
  return {
    durationMs: outTimeUs !== null ? Math.round(outTimeUs / 1000) : null,
    title: tag('title'),
    artist: tag('artist'),
    decodedAudio: /Stream #0:\d+.*: Audio:/.test(input),
  };
}

/**
 * Checks a direct link before it is queued: it must answer with audio (Content-Type audio/*,
 * or a generic type with an audio file ending) and ffmpeg must decode it. Files are decoded once
 * completely to learn their length (fast: no real-time playback, CPU only for decoding); a
 * response without Content-Length (or with icy-* headers) is an internet radio stream and becomes
 * a live track after a few seconds decoded fine.
 * @returns {Promise<object>} track object (see directTrack)
 */
/**
 * Looks at a link without downloading it: one GET for the first KB (`Range: bytes=0-1023`); only
 * the headers are read, then the connection is closed. Refuses what is not audio or larger than
 * DIRECT_MAX_BYTES. Returns { url (after redirects), contentType, totalLength (null: unknown),
 * live, headers }. A server that ignores Range answers 200 with the whole length; that works too.
 */
export async function precheckDirectLink(url, { open = openSafeHttp, signal } = {}) {
  let opened;
  try {
    opened = await open(url, { signal, headers: { Range: 'bytes=0-1023' } });
  } catch (error) {
    throw toDirectError(error);
  }
  opened.body.destroy();
  const headers = opened.headers ?? {};
  const totalLength =
    opened.status === 206 ? (parseContentRange(headers['content-range'])?.total ?? null) : opened.contentLength;
  const live = totalLength === null || Object.keys(headers).some((h) => h.startsWith('icy-'));
  if (!isAudioContentType(opened.contentType, { url: opened.url })) {
    throw new MusicError(ErrorCodes.LOAD_FAILED, M.sesDosyasiDegil);
  }
  if (totalLength !== null && totalLength > DIRECT_MAX_BYTES) {
    throw new MusicError(ErrorCodes.LOAD_FAILED, M.dosyaCokBuyuk(DIRECT_MAX_BYTES / 1024 / 1024));
  }
  return { url: opened.url, contentType: opened.contentType, totalLength, live, headers };
}

export async function probeDirectLink(
  url,
  { ffmpegPath, spawnImpl = spawn, open = openSafeHttp, timeoutMs = PROBE_TIMEOUT_MS } = {},
) {
  if (!ffmpegPath) throw new MusicError(ErrorCodes.LOAD_FAILED, M.ffmpegYok);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('zaman aşımı')), timeoutMs);
  timer.unref?.();
  let checked;
  let opened;
  try {
    // Headers first: a web page, a playlist or a too large file is refused without downloading it.
    checked = await precheckDirectLink(url, { open, signal: controller.signal });
    opened = await open(checked.url, { signal: controller.signal, maxBytes: DIRECT_MAX_BYTES });
  } catch (error) {
    clearTimeout(timer);
    throw toDirectError(error);
  }
  const { body } = opened;
  const { headers, live } = checked;
  const finalUrl = opened.url;

  try {
    const { code, progress, log } = await runProbe({ ffmpegPath, spawnImpl, body, live, signal: controller.signal });
    const parsed = parseProbeOutput(progress, log);
    if (!parsed.decodedAudio || (code !== 0 && !live)) throw new MusicError(ErrorCodes.LOAD_FAILED, M.sesDosyasiDegil);
    if (!live) {
      if (!parsed.durationMs || parsed.durationMs < 1000)
        throw new MusicError(ErrorCodes.LOAD_FAILED, M.sesDosyasiDegil);
      if (parsed.durationMs > DIRECT_MAX_DURATION_MS) {
        throw new MusicError(ErrorCodes.LOAD_FAILED, M.dosyaCokUzun(DIRECT_MAX_DURATION_MS / 3_600_000));
      }
    }
    const icyName = typeof headers?.['icy-name'] === 'string' ? headers['icy-name'].trim().slice(0, 200) : null;
    return directTrack({
      url: finalUrl,
      title: parsed.title ?? icyName ?? null,
      author: parsed.artist ?? null,
      durationMs: parsed.durationMs,
      live,
    });
  } catch (error) {
    throw toDirectError(error);
  } finally {
    clearTimeout(timer);
    body.destroy();
  }
}

function runProbe({ ffmpegPath, spawnImpl, body, live, signal }) {
  return new Promise((resolve, reject) => {
    const proc = spawnImpl(ffmpegPath, probeArgs({ live }), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let progress = '';
    let log = '';
    let bodyError = null;
    const onAbort = () => proc.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      progress = (progress + chunk).slice(-4096);
    });
    proc.stderr.on('data', (chunk) => {
      if (log.length < 32_768) log += chunk;
    });
    proc.stdin.on('error', () => {}); // EPIPE once ffmpeg stopped reading (live probe, -t)
    body.on('error', (error) => {
      bodyError = error;
      proc.stdin.end();
    });
    body.pipe(proc.stdin);
    proc.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      body.unpipe(proc.stdin);
      if (signal?.aborted) reject(new MusicError(ErrorCodes.LOAD_FAILED, M.baglantiZamanAsimi));
      else if (bodyError instanceof UnsafeUrlError) reject(bodyError);
      else if (bodyError && !live) reject(bodyError);
      else resolve({ code, progress, log });
    });
  });
}

/** Turkish MusicError for network / safety failures of a direct link. */
export function toDirectError(error) {
  if (error instanceof MusicError) return error;
  if (error instanceof UnsafeUrlError) {
    if (error.reason === 'size')
      return new MusicError(ErrorCodes.LOAD_FAILED, M.dosyaCokBuyuk(DIRECT_MAX_BYTES / 1024 / 1024));
    return new MusicError(ErrorCodes.INVALID_VALUE, M.baglantiyaIzinYok);
  }
  if (Number.isInteger(error?.status)) return new MusicError(ErrorCodes.LOAD_FAILED, M.baglantiAcilamadi(error.status));
  return new MusicError(ErrorCodes.LOAD_FAILED, M.baglantiAcilamadi(null));
}

/**
 * Opens the body of a direct link for playback (same safety rules as the probe). The returned
 * stream counts bytes (`truncated` when the server stopped early) and errors past DIRECT_MAX_BYTES
 * for files; a live stream has no size limit (ffmpeg stops after DIRECT_LIVE_MAX_MS).
 */
export async function openDirectStream(url, { signal, live = false, open = openSafeHttp } = {}) {
  const opened = await open(url, { signal, maxBytes: live ? Infinity : DIRECT_MAX_BYTES });
  if (live || opened.contentLength === null) return opened.body;
  // A file survives dropped connections (long pauses): it continues with a Range request.
  return new ResumableBody(opened.body, {
    url: opened.url,
    expectedLength: opened.contentLength,
    open,
    signal,
    maxBytes: DIRECT_MAX_BYTES,
  });
}
