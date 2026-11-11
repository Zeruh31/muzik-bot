// Card renderer (src/ozellikler/_kart.js): real PNGs of the right size with Turkish names and emoji, the
// bundled OFL fonts, download rules (Discord CDN only for avatars, https and public hosts for backgrounds,
// size and pixel limits), the caches and the concurrency limit.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkImageUrl,
  createCache,
  createCardRenderer,
  createLimiter,
  fetchImage,
  FONT_DIR,
  guardedFetch,
  imageSize,
  isPrivateAddress,
  KartHatasi,
  RANK_SIZE,
  WELCOME_SIZE,
} from '../src/ozellikler/_kart.js';
import { progressOf } from '../src/ozellikler/seviye/xp.js';

const require = createRequire(import.meta.url);
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

function pngHeader(width, height) {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function realPng(width = 64, height = 64) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e67e22';
  ctx.fillRect(0, 0, width, height);
  return canvas.encode('png');
}

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), options });
    const route = routes(String(url));
    const headers = new Headers(route.headers ?? {});
    return new Response(route.status >= 300 && route.status < 400 ? null : (route.body ?? null), {
      status: route.status ?? 200,
      headers,
    });
  };
  fn.calls = calls;
  return fn;
}

describe('cards', () => {
  it('ship with the OFL fonts', () => {
    for (const file of [
      'NotoSans-Regular.ttf',
      'NotoSans-Bold.ttf',
      'NotoEmoji-Bold.ttf',
      'OFL-NotoSans.txt',
      'OFL-NotoEmoji.txt',
    ]) {
      assert.ok(existsSync(join(FONT_DIR, file)), file);
    }
  });

  it('draw PNGs of the right size with a Turkish name and emoji, and cache them', async () => {
    const avatar = await realPng(256, 256);
    const fetchImpl = fakeFetch(() => ({ body: avatar, headers: { 'content-type': 'image/png' } }));
    const kart = createCardRenderer({ fetchImpl, lookup: publicDns });
    const data = {
      ad: 'Çağrı Şükrü İğdır 🎮',
      kullaniciAdi: 'çağrı',
      avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
      ...progressOf(23_456),
      sira: 3,
    };
    const rank = await kart.rankKarti(data);
    assert.deepEqual(imageSize(rank), { type: 'png', ...RANK_SIZE });
    const again = await kart.rankKarti(data);
    assert.equal(again, rank, 'same data: from the cache');
    assert.equal(fetchImpl.calls.length, 1, 'the avatar is downloaded once');

    const welcome = await kart.karsilamaKarti({
      baslik: 'Hoş geldin',
      ad: 'Gülşen Öztürk ✨',
      altMetin: 'Örnek • 128. üye',
      avatarUrl: null,
    });
    assert.deepEqual(imageSize(welcome), { type: 'png', ...WELCOME_SIZE });
    const olcum = kart.olcum();
    assert.equal(olcum.adet, 2);
    assert.ok(olcum.ortalamaMs > 0 && olcum.ortalamaMs < 2000, `${olcum.ortalamaMs} ms`);
  });

  it('use fonts that really have the Turkish letters (no empty boxes)', async () => {
    await createCardRenderer().karsilamaKarti({ baslik: 'x', ad: 'x' }); // registers the fonts
    const families = GlobalFonts.families.map((f) => f.family);
    assert.ok(families.includes('KartSans') && families.includes('KartEmoji'));
    const pixels = (text) => {
      const canvas = createCanvas(60, 60);
      const ctx = canvas.getContext('2d');
      ctx.font = '40px KartSans, KartEmoji';
      ctx.fillStyle = '#000';
      ctx.fillText(text, 10, 45);
      return Buffer.from(ctx.getImageData(0, 0, 60, 60).data);
    };
    // A font without a letter draws the same "missing" box for every such letter.
    const glyphs = ['ğ', 'ş', 'ı', 'İ', 'ç', 'ö', 'ü', '🎮'].map(pixels);
    for (let i = 0; i < glyphs.length; i += 1) {
      assert.ok(
        glyphs[i].some((v) => v !== 0),
        `glyph ${i} draws something`,
      );
      for (let j = i + 1; j < glyphs.length; j += 1)
        assert.ok(!glyphs[i].equals(glyphs[j]), `glyphs ${i} and ${j} differ`);
    }
    assert.ok(!pixels('ğ').equals(pixels('g')));
  });

  it('fall back to the plain colour when the background cannot be used', async () => {
    const fetchImpl = fakeFetch(() => ({ body: 'hello', headers: { 'content-type': 'text/html' } }));
    const kart = createCardRenderer({ fetchImpl, lookup: publicDns });
    assert.equal(await kart.arkaPlanKullanilabilir('https://example.com/a.png'), false);
    const png = await kart.karsilamaKarti({ baslik: 'Güle güle', ad: 'x', arkaPlanUrl: 'https://example.com/a.png' });
    assert.deepEqual(imageSize(png), { type: 'png', ...WELCOME_SIZE });
  });
});

describe('image downloads', () => {
  it('take avatars only from https://cdn.discordapp.com and never follow a redirect', async () => {
    await assert.rejects(checkImageUrl('http://cdn.discordapp.com/a.png', { kind: 'avatar' }), { code: 'adres' });
    await assert.rejects(checkImageUrl('https://media.discordapp.net/a.png', { kind: 'avatar' }), { code: 'adres' });
    await assert.rejects(checkImageUrl('https://cdn.discordapp.com.evil.com/a.png', { kind: 'avatar' }), {
      code: 'adres',
    });
    await assert.rejects(checkImageUrl('https://user:pw@cdn.discordapp.com/a.png', { kind: 'avatar' }), {
      code: 'adres',
    });
    const redirect = fakeFetch(() => ({ status: 302, headers: { location: 'https://cdn.discordapp.com/b.png' } }));
    await assert.rejects(fetchImage('https://cdn.discordapp.com/a.png', { kind: 'avatar', fetchImpl: redirect }), {
      code: 'adres',
    });
  });

  it('refuse backgrounds on this computer or the local network, also behind a redirect', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.20.0.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:192.168.0.1',
      '100.64.0.1',
    ])
      assert.ok(isPrivateAddress(address), address);
    assert.ok(!isPrivateAddress('93.184.216.34'));
    await assert.rejects(checkImageUrl('https://localhost/a.png', { kind: 'arkaplan', lookup: publicDns }), {
      code: 'adres',
    });
    await assert.rejects(checkImageUrl('https://192.168.1.10/a.png', { kind: 'arkaplan' }), { code: 'adres' });
    const lan = async () => [{ address: '10.0.0.5', family: 4 }];
    await assert.rejects(checkImageUrl('https://router.example/a.png', { kind: 'arkaplan', lookup: lan }), {
      code: 'adres',
    });
    await assert.rejects(checkImageUrl('https://example.com:8443/a.png', { kind: 'arkaplan', lookup: publicDns }), {
      code: 'adres',
    });
    const lookup = async (host) => [{ address: host === 'evil.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
    const hop = fakeFetch(() => ({ status: 301, headers: { location: 'https://evil.example/x.png' } }));
    await assert.rejects(fetchImage('https://example.com/a.png', { kind: 'arkaplan', fetchImpl: hop, lookup }), {
      code: 'adres',
    });
  });

  it('use the address rules of the music player and and refuse private addresses again when connecting', async () => {
    assert.ok(isPrivateAddress('192.0.2.1') && isPrivateAddress('fe80::1%eth0') && isPrivateAddress('2002::1'));
    // localhost resolves to 127.0.0.1: netGuard's lookup refuses it before any connection is made.
    await assert.rejects(guardedFetch('https://localhost/a.png'), (error) => error.name === 'UnsafeUrlError');
    await assert.rejects(guardedFetch('http://example.com/a.png'), { code: 'adres' });
    const refusedAtConnect = async () => {
      throw Object.assign(new Error('Bu adrese erişime izin verilmiyor.'), { name: 'UnsafeUrlError' });
    };
    await assert.rejects(
      fetchImage('https://example.com/a.png', { kind: 'arkaplan', fetchImpl: refusedAtConnect, lookup: publicDns }),
      { code: 'adres' },
    );
  });

  it('refuse files that are too big, not images, or too many pixels', async () => {
    const big = fakeFetch(() => ({
      body: 'x',
      headers: { 'content-type': 'image/png', 'content-length': String(5 * 1024 * 1024) },
    }));
    await assert.rejects(
      fetchImage('https://example.com/a.png', { kind: 'arkaplan', fetchImpl: big, lookup: publicDns }),
      { code: 'boyut' },
    );
    const streamed = fakeFetch(() => ({
      body: Buffer.alloc(3 * 1024 * 1024),
      headers: { 'content-type': 'image/png' },
    }));
    await assert.rejects(fetchImage('https://cdn.discordapp.com/a.png', { kind: 'avatar', fetchImpl: streamed }), {
      code: 'boyut',
    });
    const html = fakeFetch(() => ({ body: '<html>', headers: { 'content-type': 'text/html' } }));
    await assert.rejects(fetchImage('https://cdn.discordapp.com/a.png', { kind: 'avatar', fetchImpl: html }), {
      code: 'tur',
    });
    const bomb = fakeFetch(() => ({ body: pngHeader(20_000, 20_000), headers: { 'content-type': 'image/png' } }));
    await assert.rejects(
      fetchImage('https://example.com/a.png', { kind: 'arkaplan', fetchImpl: bomb, lookup: publicDns }),
      { code: 'boyut' },
    );
    const smallGif = Buffer.alloc(30);
    smallGif.write('GIF89a', 0, 'latin1');
    smallGif.writeUInt16LE(16, 6);
    smallGif.writeUInt16LE(16, 8);
    const fakeType = fakeFetch(() => ({ body: smallGif, headers: { 'content-type': 'image/png' } }));
    const gif = await fetchImage('https://cdn.discordapp.com/a.png', { kind: 'avatar', fetchImpl: fakeType });
    assert.equal(imageSize(gif).type, 'gif');
    const timeout = async (url, { signal }) => {
      throw Object.assign(new Error('aborted'), { name: signal ? 'TimeoutError' : 'Error' });
    };
    await assert.rejects(fetchImage('https://cdn.discordapp.com/a.png', { kind: 'avatar', fetchImpl: timeout }), {
      code: 'zaman',
    });
  });

  it('read width and height from PNG, GIF, JPEG and WebP headers', async () => {
    assert.deepEqual(imageSize(await realPng(30, 20)), { type: 'png', width: 30, height: 20 });
    const canvas = createCanvas(40, 25);
    canvas.getContext('2d').fillRect(0, 0, 40, 25);
    assert.deepEqual(imageSize(await canvas.encode('jpeg')), { type: 'jpeg', width: 40, height: 25 });
    assert.deepEqual(imageSize(await canvas.encode('webp')), { type: 'webp', width: 40, height: 25 });
    const gif = Buffer.alloc(30);
    gif.write('GIF89a', 0, 'latin1');
    gif.writeUInt16LE(7, 6);
    gif.writeUInt16LE(9, 8);
    assert.deepEqual(imageSize(gif), { type: 'gif', width: 7, height: 9 });
    assert.equal(imageSize(Buffer.from('not an image at all, really not')), null);
  });
});

describe('cache and limiter', () => {
  it('the cache drops old and least recently used entries and keeps a byte limit', () => {
    let now = 0;
    const cache = createCache({ max: 2, maxBytes: 10, ttlMs: 100, now: () => now });
    cache.set('a', 'a', 4);
    cache.set('b', 'b', 4);
    cache.get('a');
    cache.set('c', 'c', 4);
    assert.equal(cache.get('b'), undefined, 'least recently used went');
    assert.equal(cache.get('a'), 'a');
    cache.set('big', 'x', 11);
    assert.equal(cache.get('big'), undefined, 'bigger than the whole cache');
    now = 101;
    assert.equal(cache.get('a'), undefined, 'too old');
  });

  it('runs at most two cards at once and says "busy" when ten are waiting', async () => {
    const limiter = createLimiter(2, 10);
    let running = 0;
    let most = 0;
    const releases = [];
    const task = () =>
      new Promise((resolve) => {
        running += 1;
        most = Math.max(most, running);
        releases.push(() => {
          running -= 1;
          resolve();
        });
      });
    const runs = Array.from({ length: 12 }, () => limiter.run(task));
    await assert.rejects(limiter.run(task), (error) => error instanceof KartHatasi && error.code === 'mesgul');
    while (releases.length || running) {
      await new Promise((resolve) => setImmediate(resolve));
      releases.shift()?.();
    }
    await Promise.all(runs);
    assert.equal(most, 2);
  });
});
