// Kullanıcının verdiği bağlantılara (doğrudan ses dosyaları) güvenli erişim: yalnız http/https,
// yalnız internetteki adresler (bu bilgisayar, ev/şirket ağı ve benzeri özel adresler yasak),
// yönlendirmeler tek tek denetlenir, boyut ve süre sınırlıdır. Normalde dokunmana gerek yok.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable, Transform, pipeline } from 'node:stream';

/**
 * Addresses a user-supplied link must never reach (SSRF): loopback, private networks, link-local,
 * CGNAT, multicast and reserved IPv4 ranges. IPv6 rules are in BLOCKED6 below.
 */
const BLOCKED = new net.BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  BLOCKED.addSubnet(subnet, prefix, 'ipv4');
}
/**
 * IPv6-only rules live in their own list: net.BlockList also matches IPv4 addresses against IPv6
 * rules in their mapped form, so ::ffff:0:0/96 in the IPv4 list would block every IPv4 address.
 * ::/96 (IPv4-compatible, includes :: and ::1) and ::ffff:0:0/96 (IPv4-mapped) are refused
 * outright: a public host never needs them.
 */
const BLOCKED6 = new net.BlockList();
for (const [subnet, prefix] of [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['::ffff:0:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  BLOCKED6.addSubnet(subnet, prefix, 'ipv6');
}

/**
 * Ports a direct link may use: the web defaults and 8000-8999, where Icecast/Shoutcast radio
 * streams usually live (8000, 8080, 8443, ...). Everything else (databases, admin panels,
 * Lavalink's 2333, SSH, ...) is refused even on public hosts.
 */
export function isAllowedPort(port) {
  return port === 80 || port === 443 || (port >= 8000 && port <= 8999);
}

/** Thrown when a link points somewhere the bot must not go, or breaks a limit. */
export class UnsafeUrlError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.reason = reason;
  }
}

/** True for an IP address (v4 or v6 text) that is not on the public internet. */
export function isBlockedAddress(address) {
  const text = String(address ?? '').replace(/^\[|\]$/g, '');
  const family = net.isIP(text);
  if (family === 4) return BLOCKED.check(text, 'ipv4');
  if (family === 6) {
    // Zone ids ("fe80::1%eth0") are link-local by definition.
    if (text.includes('%')) return true;
    return BLOCKED6.check(text, 'ipv6');
  }
  return true; // not an IP address at all
}

/**
 * Parses and checks a user-supplied URL: http/https only, no credentials, a host name or a
 * public IP literal. Returns the URL object. DNS names are checked when connecting
 * (see guardedLookup), so a name that later resolves to a private address is refused too.
 */
export function assertPublicUrl(text) {
  let url;
  try {
    url = new URL(String(text));
  } catch {
    throw new UnsafeUrlError('Geçersiz bağlantı.', 'invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('Yalnız http ve https bağlantılarına izin var.', 'protocol');
  }
  if (url.username || url.password)
    throw new UnsafeUrlError('Kullanıcı adı/şifre içeren bağlantılar kabul edilmez.', 'auth');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('Geçersiz bağlantı.', 'invalid');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!isAllowedPort(port)) throw new UnsafeUrlError('Bu bağlantı noktasına (port) izin verilmiyor.', 'port');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError('Bu adrese erişime izin verilmiyor.', 'private');
  } else if (/(^|\.)localhost$/i.test(host) || !host.includes('.')) {
    throw new UnsafeUrlError('Bu adrese erişime izin verilmiyor.', 'private');
  }
  return url;
}

/**
 * dns.lookup replacement for http(s).request: resolves every address of the host and refuses
 * the connection when ANY of them is not public. The socket connects to the addresses returned
 * here, so the check cannot be bypassed by a second, different DNS answer (rebinding).
 */
export function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'function' ? {} : (options ?? {});
  const cb = typeof options === 'function' ? options : callback;
  dns.lookup(hostname, { all: true, family: opts.family ?? 0, hints: opts.hints }, (error, addresses) => {
    if (error) return cb(error);
    const list = (addresses ?? []).filter((a) => a?.address);
    if (!list.length) return cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    if (list.some((a) => isBlockedAddress(a.address))) {
      return cb(new UnsafeUrlError('Bu adrese erişime izin verilmiyor.', 'private'));
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

export const SAFE_HTTP_DEFAULTS = Object.freeze({
  maxRedirects: 5,
  headersTimeoutMs: 15_000,
  /** No data at all for this long: the connection is considered dead. */
  idleTimeoutMs: 30_000,
});

/**
 * GET a user-supplied URL safely. Redirects are followed by hand (at most `maxRedirects`), each
 * target passes assertPublicUrl and the guarded DNS lookup again. Resolves with
 * { body, status, headers, url: final URL string, contentType, contentLength (or null) } once the
 * headers of a 2xx answer arrived; `body` is a ByteCountingStream the caller reads and must
 * destroy. `maxBytes` (when finite) is enforced on the body: it errors with UnsafeUrlError.
 */
export async function openSafeHttp(
  text,
  {
    signal,
    maxBytes = Infinity,
    maxRedirects = SAFE_HTTP_DEFAULTS.maxRedirects,
    headersTimeoutMs = SAFE_HTTP_DEFAULTS.headersTimeoutMs,
    idleTimeoutMs = SAFE_HTTP_DEFAULTS.idleTimeoutMs,
    headers = {},
    requestImpl = null,
  } = {},
) {
  let url = assertPublicUrl(text);
  for (let hop = 0; ; hop++) {
    const response = await requestOnce(url, { signal, headersTimeoutMs, idleTimeoutMs, headers, requestImpl });
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      response.destroy();
      if (hop >= maxRedirects) throw new UnsafeUrlError('Bağlantı çok fazla yönlendiriyor.', 'redirects');
      url = assertPublicUrl(new URL(response.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      response.destroy();
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    }
    const length = Number(response.headers['content-length']);
    const contentLength = Number.isFinite(length) && length >= 0 ? length : null;
    if (contentLength !== null && contentLength > maxBytes) {
      response.destroy();
      throw new UnsafeUrlError('Dosya çok büyük.', 'size');
    }
    const body = new ByteCountingStream({ maxBytes, expectedLength: contentLength });
    pipeline(response, body, () => {});
    return {
      body,
      status,
      headers: response.headers,
      url: url.toString(),
      contentType: String(response.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase(),
      contentLength,
    };
  }
}

function requestOnce(url, { signal, headersTimeoutMs, idleTimeoutMs, headers, requestImpl }) {
  return new Promise((resolve, reject) => {
    const request = requestImpl ?? (url.protocol === 'https:' ? https.request : http.request);
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const req = request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        // A fresh connection per request: a pooled socket would skip the guarded lookup.
        agent: false,
        signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MuzikBot/2.0)', Accept: '*/*', ...headers },
      },
      (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        response.setTimeout?.(idleTimeoutMs, () => response.destroy(new Error('Bağlantı zaman aşımına uğradı.')));
        resolve(response);
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('Bağlantı zaman aşımına uğradı.'));
    }, headersTimeoutMs);
    timer.unref?.();
    req.on('error', fail);
    req.end();
  });
}

/**
 * Pass-through that counts the bytes of a response body and errors once more than `maxBytes`
 * arrived. `truncated` tells (like PrefetchStream) that the source ended before sending the
 * Content-Length it announced.
 */
export class ByteCountingStream extends Transform {
  bytesReceived = 0;
  expectedLength;
  complete = false;
  #maxBytes;

  constructor({ maxBytes = Infinity, expectedLength = null } = {}) {
    super();
    this.#maxBytes = maxBytes;
    this.expectedLength = expectedLength;
  }

  get truncated() {
    return this.complete && this.expectedLength !== null && this.bytesReceived < this.expectedLength;
  }

  _transform(chunk, _encoding, callback) {
    this.bytesReceived += chunk.length;
    if (this.bytesReceived > this.#maxBytes) {
      callback(new UnsafeUrlError('Dosya çok büyük.', 'size'));
      return;
    }
    callback(null, chunk);
  }

  _flush(callback) {
    this.complete = true;
    callback();
  }
}

/** "bytes 100-199/1000" -> { start: 100, end: 199, total: 1000 } (total null for "*"), or null. */
export function parseContentRange(value) {
  const match = String(value ?? '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3]) };
}

/**
 * The body of a file of known length that survives dropped connections: when the server closes
 * the connection before the whole file arrived (e.g. a pause longer than the idle timeout: no
 * data flows while the player does not read), the file is opened again once more data is wanted,
 * with `Range: bytes=<received>-`. A server that ignores Range sends the file again from the
 * start; what was already delivered is skipped. The consumer sees one continuous stream.
 * `truncated` is true when it gave up (`maxReopens` failed attempts in a row) before the end.
 */
export class ResumableBody extends Readable {
  bytesReceived = 0;
  expectedLength;
  complete = false;
  reopens = 0;
  #source = null;
  #url;
  #open;
  #signal;
  #maxBytes;
  #maxReopens;
  #failures = 0;
  #wanted = false;
  #dropped = false;
  #reopening = false;

  constructor(first, { url, expectedLength, open, signal, maxBytes = Infinity, maxReopens = 5 }) {
    super();
    this.#url = url;
    this.expectedLength = expectedLength;
    this.#open = open;
    this.#signal = signal;
    this.#maxBytes = maxBytes;
    this.#maxReopens = maxReopens;
    this.#attach(first, 0);
  }

  get truncated() {
    return this.complete && this.bytesReceived < this.expectedLength;
  }

  #attach(source, skip) {
    this.#source = source;
    let toSkip = skip;
    source.on('data', (data) => {
      let chunk = data;
      if (toSkip > 0) {
        if (chunk.length <= toSkip) {
          toSkip -= chunk.length;
          return;
        }
        chunk = chunk.subarray(toSkip);
        toSkip = 0;
      }
      this.#failures = 0;
      this.bytesReceived += chunk.length;
      if (this.bytesReceived > this.#maxBytes) {
        this.destroy(new UnsafeUrlError('Dosya çok büyük.', 'size'));
        return;
      }
      this.#wanted = this.push(chunk);
      if (!this.#wanted) source.pause();
    });
    source.once('end', () => this.#sourceDone(source, null));
    source.once('error', (error) => this.#sourceDone(source, error));
  }

  #sourceDone(source, error) {
    if (this.#source !== source || this.destroyed) return;
    this.#source = null;
    source.removeAllListeners('data');
    source.on('error', () => {});
    source.destroy();
    if (error instanceof UnsafeUrlError || this.#signal?.aborted) {
      this.destroy(error ?? new Error('aborted'));
      return;
    }
    if (this.bytesReceived >= this.expectedLength) {
      this.complete = true;
      this.push(null);
      return;
    }
    this.#dropped = true;
    if (this.#wanted) this.#reopen();
  }

  _read() {
    this.#wanted = true;
    if (this.#source) this.#source.resume();
    else if (this.#dropped) this.#reopen();
  }

  async #reopen() {
    if (this.#reopening || this.destroyed) return;
    if (this.#failures >= this.#maxReopens) {
      this.complete = true; // truncated: the player resumes or reports it
      this.push(null);
      return;
    }
    this.#reopening = true;
    this.#dropped = false;
    this.#failures += 1;
    this.reopens += 1;
    try {
      const reply = await this.#open(this.#url, {
        signal: this.#signal,
        headers: { Range: `bytes=${this.bytesReceived}-` },
      });
      if (this.destroyed) {
        reply.body.destroy();
        return;
      }
      let skip = 0;
      if (reply.status === 206) {
        if (parseContentRange(reply.headers?.['content-range'])?.start !== this.bytesReceived) {
          reply.body.destroy();
          throw new Error('Sunucu yanlış aralık gönderdi');
        }
      } else {
        skip = this.bytesReceived; // Range not supported: the whole file again
      }
      this.#attach(reply.body, skip);
    } catch (error) {
      if (error instanceof UnsafeUrlError || this.#signal?.aborted) {
        this.destroy(error);
        return;
      }
      this.#dropped = true;
      const retry = setTimeout(() => this.#wanted && this.#reopen(), 1000);
      retry.unref?.();
    } finally {
      this.#reopening = false;
    }
  }

  _destroy(error, callback) {
    const source = this.#source;
    this.#source = null;
    if (source) {
      source.removeAllListeners('data');
      source.on('error', () => {});
      source.destroy();
    }
    callback(error);
  }
}
