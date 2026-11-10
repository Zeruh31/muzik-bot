'use strict';

// Lavalink.jar download with SHA-256 check: the same thing lavalink/indir.ps1 does.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Pinned release; the hash is the "digest" GitHub publishes for this asset (same as indir.ps1).
const LAVALINK_VERSION = '4.2.2';
const LAVALINK_SHA256 = '8cb801e591072c3689fafd71ccf571a95a4ead3cc35dfc045e157d763d89119a';
const LAVALINK_URL = `https://github.com/lavalink-devs/Lavalink/releases/download/${LAVALINK_VERSION}/Lavalink.jar`;

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Downloads `url` to `dest` through a temporary file and only keeps it when its SHA-256
 * matches. Returns { status: 'present' | 'downloaded' }.
 * @param {{ url: string, dest: string, sha256: string, onProgress?: (p: {received: number, total: number|null}) => void,
 *           fetchImpl?: typeof fetch }} options
 */
async function downloadVerified({ url, dest, sha256, onProgress = () => {}, fetchImpl = fetch }) {
  const expected = sha256.toLowerCase();
  if (fs.existsSync(dest) && (await sha256File(dest)) === expected) return { status: 'present' };

  const temp = `${dest}.indiriliyor`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Sunucu yanıtı: HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || null;
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;
    const body = Readable.fromWeb(response.body);
    body.on('data', (chunk) => {
      hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (now - lastReport > 200) {
        lastReport = now;
        onProgress({ received, total });
      }
    });
    await pipeline(body, fs.createWriteStream(temp));
    onProgress({ received, total });
    const actual = hash.digest('hex');
    if (actual !== expected) {
      const error = new Error(
        `İndirilen dosyanın SHA-256 özeti beklenenle uyuşmuyor, dosya silindi. Beklenen: ${expected}, gelen: ${actual}`,
      );
      error.code = 'SHA_MISMATCH';
      throw error;
    }
    fs.renameSync(temp, dest);
    return { status: 'downloaded' };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

module.exports = { downloadVerified, sha256File, LAVALINK_VERSION, LAVALINK_SHA256, LAVALINK_URL };
