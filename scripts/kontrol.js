// Setup check for non-developers: prints what is OK and what still needs fixing.
//   npm run kontrol

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError, PROJECT_ROOT, loadConfig } from '../src/config.js';
import { findFfmpeg } from '../src/music/ffmpeg.js';

const ok = (text) => console.log(`  [TAMAM] ${text}`);
const warn = (text) => console.log(`  [UYARI] ${text}`);
const bad = (text) => console.log(`  [SORUN] ${text}`);
let problems = 0;
const problem = (text) => {
  problems += 1;
  bad(text);
};

/**
 * fetch that always reads the whole body before returning. An unread body keeps the
 * undici socket busy; exiting while it closes aborted Node on Windows
 * (libuv assertion "!(handle->flags & UV_HANDLE_CLOSING)").
 */
async function request(url, options = {}, ms = 8000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(ms) });
  const text = await res.text();
  return { status: res.status, ok: res.ok, json: () => JSON.parse(text) };
}

console.log('\nMüzik botu kurulum kontrolü\n');

// Node
const major = Number(process.versions.node.split('.')[0]);
if (major >= 24) ok(`Node.js ${process.version}`);
else problem(`Node.js ${process.version} eski; 24 veya daha yenisi gerekli.`);

// .env
const envPath = join(PROJECT_ROOT, '.env');
if (existsSync(envPath)) ok('.env dosyası var');
else problem('.env dosyası yok (.env.example dosyasını kopyalayıp adını .env yapın).');

let config = null;
try {
  config = loadConfig({ requireToken: false });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  problem(error.message);
}

if (config) {
  if (config.discord.token) ok('DISCORD_TOKEN dolu');
  else problem('DISCORD_TOKEN boş');
  if (config.discord.clientId) ok('DISCORD_CLIENT_ID dolu');
  else problem('DISCORD_CLIENT_ID boş');
  if (config.lavalink.password) ok('LAVALINK_PASSWORD dolu');
  else problem('LAVALINK_PASSWORD boş');
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) ok('Spotify anahtarları dolu');
  else warn('Spotify anahtarları boş: Spotify bağlantıları çalışmaz (YouTube çalışır).');
  if (process.env.YOUTUBE_OAUTH_REFRESH_TOKEN) ok('YouTube refresh token kayıtlı');
  else warn('YouTube refresh token yok: ilk girişi yapıp "npm run youtube-token" çalıştırın.');

  const { panel } = config;
  if (!panel.enabled) {
    ok('Web paneli kapalı (PANEL_ENABLED=false)');
  } else {
    if (panel.clientSecret) ok('DISCORD_CLIENT_SECRET dolu (web paneli)');
    else problem('Web paneli açık ama DISCORD_CLIENT_SECRET boş (README > Web paneli)');
    if (panel.sessionSecret.length >= 32) ok('PANEL_SESSION_SECRET yeterince uzun');
    else warn('PANEL_SESSION_SECRET boş ya da kısa: yeniden başlatınca panel oturumları düşer.');
    ok(`Panel adresi: ${panel.publicUrl} (Redirect: ${panel.publicUrl}/auth/callback)`);
  }
}

// ffmpeg: the system one, otherwise the optional ffmpeg-static package.
const ffmpegPath = await findFfmpeg();
if (ffmpegPath === 'ffmpeg') ok('ffmpeg: sistemdeki ffmpeg (PATH)');
else if (ffmpegPath) ok(`ffmpeg: ${ffmpegPath} (ffmpeg-static)`);
else problem('ffmpeg bulunamadı: ffmpeg kurun ya da "npm install" ile ffmpeg-static indirilsin.');

// Java + Lavalink.jar
// `java -version` prints to stderr.
const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
const javaLine = `${java.stderr ?? ''}${java.stdout ?? ''}`.split(/\r?\n/)[0];
const javaMajor = Number(javaLine.match(/version "(\d+)/)?.[1] ?? 0);
if (java.error || !javaMajor) problem('Java bulunamadı (Lavalink için Java 17+ gerekli).');
else if (javaMajor < 17) problem(`Java sürümü eski: ${javaLine} (17+ gerekli).`);
else ok(`Java: ${javaLine}`);
if (existsSync(join(PROJECT_ROOT, 'lavalink', 'Lavalink.jar'))) ok('lavalink/Lavalink.jar var');
else problem('lavalink/Lavalink.jar yok ("npm run lavalink:indir").');

// Lavalink server
if (config?.lavalink.password) {
  const base = `http://${config.lavalink.host}:${config.lavalink.port}`;
  try {
    const res = await request(`${base}/v4/info`, { headers: { Authorization: config.lavalink.password } });
    if (res.status === 401 || res.status === 403) {
      problem("Lavalink şifreyi reddetti: Lavalink'i .env'deki şifreyle yeniden başlatın.");
    } else if (!res.ok) {
      problem(`Lavalink beklenmeyen yanıt verdi (HTTP ${res.status}).`);
    } else {
      const info = res.json();
      ok(`Lavalink çalışıyor (sürüm ${info.version?.semver})`);
      const plugins = (info.plugins ?? []).map((p) => p.name);
      for (const name of ['youtube-plugin', 'lavasrc-plugin', 'lavalyrics-plugin']) {
        if (plugins.includes(name)) ok(`Eklenti yüklü: ${name}`);
        else problem(`Eklenti yüklenmemiş: ${name}`);
      }
      const sources = info.sourceManagers ?? [];
      if (sources.includes('spotify')) ok('Spotify kaynağı açık');
      else warn('Spotify kaynağı kapalı');

      const search = await request(
        `${base}/v4/loadtracks?identifier=${encodeURIComponent('ytsearch:never gonna give you up')}`,
        { headers: { Authorization: config.lavalink.password } },
        20_000,
      );
      const result = search.json();
      if (result.loadType === 'search' && result.data?.length) ok('YouTube araması çalışıyor');
      else problem(`YouTube araması başarısız (${result.loadType}: ${result.data?.message ?? 'sonuç yok'})`);
    }
  } catch {
    problem(`Lavalink'e ulaşılamadı (${base}). Ayrı bir pencerede "npm run lavalink" açık mı?`);
  }
}

// Discord reachability (no token needed)
try {
  const res = await request('https://discord.com/api/v10/gateway');
  if (res.ok) ok('Discord sunucularına erişilebiliyor');
  else warn(`Discord yanıt verdi ama durum kodu ${res.status}`);
} catch {
  problem("Discord'a erişilemiyor. İnternet bağlantısını (ve Discord engelliyse erişim aracınızı) kontrol edin.");
}

console.log(
  problems ? `\n${problems} sorun bulundu. Yukarıdaki [SORUN] satırlarını düzeltin.\n` : '\nHer şey hazır görünüyor.\n',
);
// exitCode instead of process.exit(): let the event loop drain so sockets close normally.
process.exitCode = problems ? 1 : 0;
