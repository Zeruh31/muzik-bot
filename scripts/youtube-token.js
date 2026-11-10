// After the first YouTube OAuth sign-in, Lavalink prints the refresh token to its log.
// This script finds the newest one in lavalink/logs and stores it in .env as
// YOUTUBE_OAUTH_REFRESH_TOKEN, so later starts skip the sign-in step.
//   npm run youtube-token

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/config.js';

const LOG_DIR = join(PROJECT_ROOT, 'lavalink', 'logs');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const KEY = 'YOUTUBE_OAUTH_REFRESH_TOKEN';
const TOKEN_LINE = /Store your refresh token as this can be reused\. \(([^)\s]+)\)/g;

/** A user-facing failure: printed as one Turkish line, exit code 1, no stack trace. */
class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

// Exit via process.exitCode instead of process.exit(), same as the other entry points.
try {
  if (!existsSync(ENV_PATH)) fail('.env dosyası yok. Önce .env.example dosyasını .env adıyla kopyalayın.');
  if (!existsSync(LOG_DIR))
    fail('lavalink/logs klasörü yok. Önce "npm run lavalink" ile Lavalink\'i başlatıp YouTube girişini yapın.');

  const logFiles = readdirSync(LOG_DIR)
    .filter((name) => (name.endsWith('.log') || name.includes('.log.')) && !name.endsWith('.gz'))
    .map((name) => join(LOG_DIR, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

  let token = null;
  for (const file of logFiles) {
    for (const match of readFileSync(file, 'utf8').matchAll(TOKEN_LINE)) token = match[1];
  }
  if (!token) {
    fail(
      'Kayıtlarda YouTube refresh token bulunamadı.\n' +
        '  Lavalink penceresindeki google.com/device adresine gidip kodu girdiniz ve YAN hesapla giriş yaptınız mı?\n' +
        '  Giriş bittikten sonra Lavalink penceresinde "Token retrieved successfully" yazısı çıkmalı.',
    );
  }

  const lines = readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim().startsWith(`${KEY}=`));
  if (index >= 0) lines[index] = `${KEY}=${token}`;
  else lines.push(`${KEY}=${token}`);
  writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');

  console.log(`Tamam: YouTube refresh token .env dosyasına kaydedildi (${token.slice(0, 6)}…).`);
  console.log('Lavalink\'i kapatıp (Ctrl+C) yeniden başlatın: "npm run lavalink". Artık giriş kodu sorulmayacak.');
} catch (error) {
  if (!(error instanceof Failure)) throw error;
  console.error(`
HATA: ${error.message}
`);
  process.exitCode = 1;
}
