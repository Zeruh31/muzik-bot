// Görsel kartlar: /seviye rank kartı ve hoş geldin / güle güle kartı, yerelde PNG olarak çizilir
// (@napi-rs/canvas; harici bir kart servisi yok). Yazılar projeyle gelen Noto Sans ve Noto Emoji
// yazı tipleriyle çizilir (assets/fonts, SIL Open Font License 1.1), böylece Türkçe harfler ve emoji
// her bilgisayarda aynı görünür.
//
// Güvenlik: profil fotoğrafı yalnız https://cdn.discordapp.com adresinden indirilir; hoş geldin arka plan
// görseli yalnız https, herkese açık bir adresten (yerel ağ adresleri reddedilir; kurallar ve bağlanırken
// yapılan DNS denetimi müzikteki src/music/netGuard.js ile aynı), zaman aşımı ve boyut
// sınırıyla indirilir. Görselin eni ve boyu çözülmeden önce dosya başlığından okunur (en çok 4096 piksel),
// böylece küçük bir dosya bellekte devasa bir resme açılamaz. İndirmeler ve hazır kartlar bellekte kısa
// süre saklanır (önbellek). Aynı anda en çok 2 kart çizilir; sıra 10'u geçerse yeni istek "meşgul" alır.
// Normalde bu dosyaya dokunmana gerek yok.

import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { guardedLookup, isBlockedAddress } from '../music/netGuard.js';

export const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const SANS = 'KartSans';
const EMOJI = 'KartEmoji';

export const RANK_SIZE = Object.freeze({ width: 934, height: 282 });
export const WELCOME_SIZE = Object.freeze({ width: 1024, height: 450 });

/** Limits for downloaded images. */
export const AVATAR_HOST = 'cdn.discordapp.com';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const BACKGROUND_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 4096;
export const AVATAR_TIMEOUT_MS = 5000;
export const BACKGROUND_TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)\b/i;

export const DEFAULT_ACCENT = '#5865f2';
export const DEFAULT_BACKGROUND = '#2b2d31';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A refused or failed image or card; `code` says why (adres, boyut, tur, zaman, ag, mesgul, kutuphane). */
export class KartHatasi extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'KartHatasi';
    this.code = code;
  }
}

/** '#AABBCC' when valid, else the fallback. */
export const colorOr = (value, fallback) => (typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback);

// ---------------------------------------------------------------------------------------------------------
// Small caches and a concurrency limit

/** A size- and age-limited cache (least recently used goes first). */
export function createCache({ max = 50, maxBytes = 20 * 1024 * 1024, ttlMs = 10 * 60_000, now = Date.now } = {}) {
  const entries = new Map();
  let bytes = 0;
  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.size;
    entries.delete(key);
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at > ttlMs) {
        drop(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, size = value?.length ?? 1) {
      drop(key);
      if (size > maxBytes) return;
      entries.set(key, { value, size, at: now() });
      bytes += size;
      while (entries.size > max || bytes > maxBytes) drop(entries.keys().next().value);
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return bytes;
    },
  };
}

/** Runs at most `concurrency` tasks at once; refuses new ones when `maxQueue` are already waiting. */
export function createLimiter(concurrency = 2, maxQueue = 10) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return {
    run(task) {
      if (queue.length >= maxQueue) return Promise.reject(new KartHatasi('mesgul'));
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        next();
      });
    },
    get active() {
      return active;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Image headers: width and height without decoding

/**
 * { type, width, height } read from a PNG, JPEG, GIF or WebP header, or null for anything else.
 * @param {Buffer} buf
 */
export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  // PNG: signature, then the IHDR chunk
  if (
    buf.readUInt32BE(0) === 0x89504e47 &&
    buf.readUInt32BE(4) === 0x0d0a1a0a &&
    buf.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF87a / GIF89a: logical screen size
  if (buf.toString('latin1', 0, 4) === 'GIF8') {
    return { type: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP: RIFF container
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP' && buf.length >= 30) {
    const chunk = buf.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ')
      return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { type: 'webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }
  // JPEG: walk the segments up to a start-of-frame marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) return null;
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const length = buf.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) return { type: 'jpeg', width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
      if (length < 2) return null;
      offset += 2 + length;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Downloads

/**
 * True for addresses on this computer or the local network (refused for background images). The rules are
 * the music player's (src/music/netGuard.js), so both features block the same ranges.
 */
export const isPrivateAddress = (address) => isBlockedAddress(address);

/**
 * A minimal fetch() over https.request whose DNS lookup refuses private addresses at connect time
 * (netGuard's guardedLookup) and that never reuses a pooled socket. The checks before the request give a clear
 * error; this one also stops a host whose DNS answer changes in between (rebinding).
 * @returns {Promise<{ status: number, ok: boolean, headers: { get(name: string): string|null }, body: ReadableStream }>}
 */
export function guardedFetch(url, { signal, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(String(url));
    if (target.protocol !== 'https:') {
      reject(new KartHatasi('adres', 'Yalnız https adresleri kabul edilir'));
      return;
    }
    const request = https.request(
      target,
      {
        method: 'GET',
        lookup: guardedLookup,
        agent: false,
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MuzikBot/2.0)', ...headers },
      },
      (response) => {
        const raw = response.headers;
        resolve({
          status: response.statusCode ?? 0,
          ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
          headers: {
            get(name) {
              const value = raw[String(name).toLowerCase()];
              return Array.isArray(value) ? value.join(', ') : (value ?? null);
            },
          },
          body: Readable.toWeb(response),
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Checks a URL before it is fetched. Avatars: only https://cdn.discordapp.com. Backgrounds: https, port 443,
 * no user:password, and a host whose every address is public.
 * @returns {Promise<URL>}
 */
export async function checkImageUrl(raw, { kind, lookup = dnsLookup }) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new KartHatasi('adres', 'Geçersiz adres');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new KartHatasi('adres', 'Yalnız https adresleri kabul edilir');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (kind === 'avatar') {
    if (host !== AVATAR_HOST) throw new KartHatasi('adres', 'Profil fotoğrafı yalnız Discord CDN adresinden alınır');
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new KartHatasi('adres', 'Yerel adresler kabul edilmez');
  }
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => null);
  if (!addresses?.length) throw new KartHatasi('ag', 'Adres bulunamadı');
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new KartHatasi('adres', 'Yerel ağ adresleri kabul edilmez');
  }
  return url;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new KartHatasi('boyut', 'Görsel çok büyük');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw new KartHatasi('boyut', 'Görsel çok büyük');
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new KartHatasi('boyut', 'Görsel çok büyük');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Downloads an image with the rules of its kind and returns its bytes (checked: a known format, at most
 * IMAGE_MAX_SIDE pixels on each side).
 * @param {string} rawUrl
 * @param {{ kind: 'avatar'|'arkaplan', fetchImpl?: typeof fetch, lookup?: Function }} options
 */
export async function fetchImage(rawUrl, { kind, fetchImpl = guardedFetch, lookup = dnsLookup } = {}) {
  const avatar = kind === 'avatar';
  const maxBytes = avatar ? AVATAR_MAX_BYTES : BACKGROUND_MAX_BYTES;
  const signal = AbortSignal.timeout(avatar ? AVATAR_TIMEOUT_MS : BACKGROUND_TIMEOUT_MS);
  let url = await checkImageUrl(rawUrl, { kind, lookup });
  try {
    for (let hop = 0; ; hop += 1) {
      // Redirects are followed by hand so every hop is checked again (a CDN avatar never redirects).
      const response = await fetchImpl(url, {
        signal,
        redirect: 'manual',
        headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel?.().catch(() => {});
        const location = response.headers.get('location');
        if (avatar || !location || hop >= MAX_REDIRECTS) throw new KartHatasi('adres', 'Yönlendirme kabul edilmedi');
        url = await checkImageUrl(new URL(location, url).href, { kind, lookup });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new KartHatasi('ag', `HTTP ${response.status}`);
      }
      if (!IMAGE_TYPES.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel?.().catch(() => {});
        throw new KartHatasi('tur', 'PNG, JPEG, GIF ya da WebP olmalı');
      }
      const buf = await readLimited(response, maxBytes);
      const size = imageSize(buf);
      if (!size) throw new KartHatasi('tur', 'PNG, JPEG, GIF ya da WebP olmalı');
      if (!size.width || !size.height || size.width > IMAGE_MAX_SIDE || size.height > IMAGE_MAX_SIDE) {
        throw new KartHatasi('boyut', `Görsel en çok ${IMAGE_MAX_SIDE}x${IMAGE_MAX_SIDE} piksel olabilir`);
      }
      return buf;
    }
  } catch (error) {
    if (error instanceof KartHatasi) throw error;
    if (error?.name === 'UnsafeUrlError') throw new KartHatasi('adres', 'Yerel ağ adresleri kabul edilmez');
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new KartHatasi('zaman', 'Zaman aşımı');
    throw new KartHatasi('ag', error?.message ?? String(error));
  }
}

// ---------------------------------------------------------------------------------------------------------
// The renderer

/** What a card renderer measured so far (for README and the log). */
function emptyStats() {
  return { adet: 0, toplamMs: 0, sonMs: 0, enCokMs: 0 };
}

/**
 * A card renderer. Loads @napi-rs/canvas on first use; when the native library cannot be loaded on this
 * computer, every draw throws KartHatasi('kutuphane') and the callers send text only.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] for downloads (tests pass a fake)
 * @param {Function} [deps.lookup] DNS lookup for background URLs (tests pass a fake)
 * @param {() => number} [deps.now]
 */
export function createCardRenderer({ fetchImpl = guardedFetch, lookup = dnsLookup, now = Date.now, logger } = {}) {
  let canvasModule = null;
  let loading = null;
  const avatars = createCache({ max: 200, maxBytes: 30 * 1024 * 1024, ttlMs: 30 * 60_000, now });
  const backgrounds = createCache({ max: 10, maxBytes: 20 * 1024 * 1024, ttlMs: 60 * 60_000, now });
  const cards = createCache({ max: 50, maxBytes: 20 * 1024 * 1024, ttlMs: 5 * 60_000, now });
  /** Failed background URLs are not tried again for a while. */
  const failedBackgrounds = createCache({ max: 50, maxBytes: 1e6, ttlMs: 10 * 60_000, now });
  const limiter = createLimiter(2, 10);
  const stats = emptyStats();

  async function canvas() {
    if (canvasModule) return canvasModule;
    loading ??= import('@napi-rs/canvas')
      .then((module) => {
        const { GlobalFonts } = module;
        for (const [file, family] of [
          ['NotoSans-Regular.ttf', SANS],
          ['NotoSans-Bold.ttf', SANS],
          ['NotoEmoji-Bold.ttf', EMOJI],
        ]) {
          if (!GlobalFonts.registerFromPath(`${FONT_DIR}${file}`, family)) {
            logger?.warn?.(`Yazı tipi yüklenemedi: assets/fonts/${file}`);
          }
        }
        canvasModule = module;
        return module;
      })
      .catch((error) => {
        logger?.warn?.(
          `Kart kütüphanesi (@napi-rs/canvas) yüklenemedi; kartlar yerine yazı gönderilecek: ${error?.message ?? error}`,
        );
        throw new KartHatasi('kutuphane', 'Kart kütüphanesi yüklenemedi');
      });
    return loading;
  }

  /** Avatar bytes or null (a failed download draws the placeholder instead). */
  async function avatarOf(url) {
    if (!url) return null;
    const cached = avatars.get(url);
    if (cached !== undefined) return cached;
    try {
      const buf = await fetchImage(url, { kind: 'avatar', fetchImpl, lookup });
      avatars.set(url, buf, buf.length);
      return buf;
    } catch (error) {
      logger?.debug?.(`Profil fotoğrafı alınamadı (${error.code ?? error.message}).`);
      return null;
    }
  }

  async function backgroundOf(url) {
    if (!url) return null;
    const cached = backgrounds.get(url);
    if (cached !== undefined) return cached;
    if (failedBackgrounds.get(url)) return null;
    try {
      const buf = await fetchImage(url, { kind: 'arkaplan', fetchImpl, lookup });
      backgrounds.set(url, buf, buf.length);
      return buf;
    } catch (error) {
      failedBackgrounds.set(url, true, 1);
      logger?.warn?.(`Hoş geldin arka plan görseli kullanılamadı (${error.message}); düz renk kullanılıyor.`);
      return null;
    }
  }

  async function decode(module, buf) {
    if (!buf) return null;
    try {
      return await module.loadImage(buf);
    } catch {
      return null;
    }
  }

  async function measured(key, draw) {
    const hit = key ? cards.get(key) : undefined;
    if (hit) return hit;
    return limiter.run(async () => {
      const started = performance.now();
      const buffer = await draw(await canvas());
      const ms = performance.now() - started;
      stats.adet += 1;
      stats.toplamMs += ms;
      stats.sonMs = ms;
      stats.enCokMs = Math.max(stats.enCokMs, ms);
      if (key) cards.set(key, buffer, buffer.length);
      return buffer;
    });
  }

  return {
    /**
     * The /seviye rank card (934x282 PNG).
     * @param {{ ad: string, kullaniciAdi?: string, avatarUrl?: string|null, seviye: number, buSeviyede: number,
     *   gereken: number, toplamXp: number, sira?: number|null, renk?: string }} data
     */
    async rankKarti(data) {
      const accent = colorOr(data.renk, DEFAULT_ACCENT);
      const key = JSON.stringify([
        'rank',
        data.ad,
        data.kullaniciAdi,
        data.avatarUrl,
        data.seviye,
        data.buSeviyede,
        data.gereken,
        data.toplamXp,
        data.sira,
        accent,
      ]);
      const avatarBuf = await avatarOf(data.avatarUrl);
      return measured(key, async (module) => {
        const { width, height } = RANK_SIZE;
        const cv = module.createCanvas(width, height);
        const ctx = cv.getContext('2d');
        roundRect(ctx, 0, 0, width, height, 24);
        ctx.fillStyle = '#1e1f22';
        ctx.fill();
        roundRect(ctx, 16, 16, width - 32, height - 32, 18);
        ctx.fillStyle = '#2b2d31';
        ctx.fill();

        await drawAvatar(ctx, await decode(module, avatarBuf), {
          cx: 141,
          cy: 141,
          r: 96,
          ring: accent,
          name: data.ad,
        });

        const left = 270;
        const right = width - 44;
        // Rank and level, right aligned on the first line
        ctx.textBaseline = 'alphabetic';
        let x = right;
        x = drawLabelValue(ctx, x, 86, 'SEVİYE', String(data.seviye), accent);
        if (data.sira) drawLabelValue(ctx, x - 28, 86, 'SIRA', `#${data.sira}`, '#ffffff');

        // Name and user name
        const name = cleanText(data.ad) || '?';
        const handle = data.kullaniciAdi ? `@${cleanText(data.kullaniciAdi)}` : '';
        const nameSize = fitFont(ctx, name, 440, 40, 24, 'bold');
        ctx.font = font(nameSize, 'bold');
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        const shownName = ellipsize(ctx, name, 440);
        ctx.fillText(shownName, left, 164);
        if (handle) {
          const nameWidth = ctx.measureText(shownName).width;
          ctx.font = font(22);
          ctx.fillStyle = '#b5bac1';
          const room = right - 200 - (left + nameWidth + 12);
          if (room > 60) ctx.fillText(ellipsize(ctx, handle, room), left + nameWidth + 12, 164);
        }

        // XP numbers, right aligned above the bar
        ctx.font = font(22, 'bold');
        ctx.textAlign = 'right';
        const total = `${fmt(data.buSeviyede)} / ${fmt(data.gereken)} XP`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(total, right, 164);

        // Progress bar
        const barY = 186;
        const barH = 38;
        const barW = right - left;
        roundRect(ctx, left, barY, barW, barH, barH / 2);
        ctx.fillStyle = '#1e1f22';
        ctx.fill();
        const ratio = data.gereken > 0 ? Math.min(1, Math.max(0, data.buSeviyede / data.gereken)) : 0;
        if (ratio > 0) {
          roundRect(ctx, left, barY, Math.max(barH, barW * ratio), barH, barH / 2);
          ctx.fillStyle = accent;
          ctx.fill();
        }
        ctx.font = font(18);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#b5bac1';
        ctx.fillText(`Toplam ${fmt(data.toplamXp)} XP`, left, barY + barH + 26);
        return cv.encode('png');
      });
    },

    /**
     * The welcome or goodbye card (1024x450 PNG).
     * @param {{ baslik: string, ad: string, altMetin?: string, avatarUrl?: string|null, renk?: string,
     *   arkaPlanUrl?: string|null }} data
     */
    async karsilamaKarti(data) {
      const color = colorOr(data.renk, DEFAULT_BACKGROUND);
      const [avatarBuf, backgroundBuf] = await Promise.all([avatarOf(data.avatarUrl), backgroundOf(data.arkaPlanUrl)]);
      return measured(null, async (module) => {
        const { width, height } = WELCOME_SIZE;
        const cv = module.createCanvas(width, height);
        const ctx = cv.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);
        const background = await decode(module, backgroundBuf);
        if (background) {
          // "cover": fill the card, crop what is left over, keep the aspect ratio
          const scale = Math.max(width / background.width, height / background.height);
          const w = background.width * scale;
          const h = background.height * scale;
          ctx.drawImage(background, (width - w) / 2, (height - h) / 2, w, h);
        }
        ctx.fillStyle = 'rgba(0, 0, 0, 0.40)';
        ctx.fillRect(0, 0, width, height);

        await drawAvatar(ctx, await decode(module, avatarBuf), {
          cx: width / 2,
          cy: 150,
          r: 100,
          ring: '#ffffff',
          name: data.ad,
        });

        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#ffffff';
        const title = cleanText(data.baslik).toLocaleUpperCase('tr');
        ctx.font = font(fitFont(ctx, title, width - 80, 52, 28, 'bold'), 'bold');
        ctx.fillText(ellipsize(ctx, title, width - 80), width / 2, 316);
        const name = cleanText(data.ad) || '?';
        ctx.font = font(fitFont(ctx, name, width - 120, 40, 22, 'bold'), 'bold');
        ctx.fillText(ellipsize(ctx, name, width - 120), width / 2, 368);
        if (data.altMetin) {
          ctx.font = font(26);
          ctx.fillStyle = '#e3e5e8';
          ctx.fillText(ellipsize(ctx, cleanText(data.altMetin), width - 120), width / 2, 414);
        }
        return cv.encode('png');
      });
    },

    /** Whether a background URL can be used (downloaded and checked; the result is cached). */
    async arkaPlanKullanilabilir(url) {
      return Boolean(await backgroundOf(url));
    },

    /** Measured render times so far. */
    olcum() {
      return { ...stats, ortalamaMs: stats.adet ? stats.toplamMs / stats.adet : 0 };
    },

    /** Sizes of the caches (for tests and the log). */
    onbellek() {
      return {
        avatar: avatars.size,
        arkaPlan: backgrounds.size,
        kart: cards.size,
        bayt: avatars.bytes + backgrounds.bytes + cards.bytes,
      };
    },

    temizle() {
      avatars.clear();
      backgrounds.clear();
      cards.clear();
      failedBackgrounds.clear();
    },
  };
}

const renderers = new WeakMap();

/** The bot's card renderer (one per bot context; tests can put their own in context.kartCizici). */
export function cardRendererOf(context) {
  if (context.kartCizici) return context.kartCizici;
  if (!renderers.has(context)) {
    renderers.set(context, createCardRenderer({ logger: context.logger?.child?.('kart') ?? context.logger }));
  }
  return renderers.get(context);
}

// ---------------------------------------------------------------------------------------------------------
// Drawing helpers

const fmt = (n) => Math.max(0, Math.floor(Number(n) || 0)).toLocaleString('tr-TR');
const font = (size, weight = 'normal') => `${weight === 'bold' ? 'bold ' : ''}${size}px ${SANS}, ${EMOJI}`;

/** User-controlled text for a card: no control or invisible format characters, at most 64 characters. */
export function cleanText(text) {
  return [
    ...String(text ?? '')
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, 64)
    .join('');
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** The biggest font size (down to `min`) at which `text` fits into `maxWidth`. */
function fitFont(ctx, text, maxWidth, size, min, weight) {
  let current = size;
  for (; current > min; current -= 2) {
    ctx.font = font(current, weight);
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  return current;
}

/** `text` cut with "…" so it fits into `maxWidth` with the current font. */
function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
  return `${chars.join('')}…`;
}

/** "LABEL 12" drawn right aligned ending at x; returns where it starts. */
function drawLabelValue(ctx, x, y, label, value, color) {
  ctx.textAlign = 'right';
  ctx.font = font(48, 'bold');
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
  const valueWidth = ctx.measureText(value).width;
  ctx.font = font(20, 'bold');
  ctx.fillStyle = '#b5bac1';
  const labelX = x - valueWidth - 10;
  ctx.fillText(label, labelX, y);
  return labelX - ctx.measureText(label).width;
}

async function drawAvatar(ctx, image, { cx, cy, r, ring, name }) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = ring;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (image) {
    ctx.drawImage(image, cx - r, cy - r, r * 2, r * 2);
  } else {
    // No photo (or it could not be downloaded): the first letter of the name on a plain circle
    ctx.fillStyle = '#4e5058';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = font(Math.round(r), 'bold');
    ctx.fillText(([...cleanText(name)][0] ?? '?').toLocaleUpperCase('tr'), cx, cy + 4);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
}
