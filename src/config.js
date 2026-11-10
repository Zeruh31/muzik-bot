// .env dosyasını okur ve her ayarı denetler. Yanlış bir değerde Türkçe bir hata yazıp durur.
// Yeni bir .env ayarı eklemek istersen burada okunur. Normalde dokunmana gerek yok.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetLogLevel } from './logger.js';

export const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');

/** Thrown for user-fixable configuration problems; the message is shown as-is (Turkish). */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const SEARCH_SOURCES = ['ytmsearch', 'ytsearch', 'scsearch'];
const SNOWFLAKE = /^\d{17,20}$/;

let envLoaded = false;

/** Loads .env into process.env once. Variables already set in the environment win. */
export function loadEnvFile() {
  if (envLoaded) return;
  envLoaded = true;
  try {
    if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  } catch (error) {
    throw new ConfigError(`.env dosyası okunamadı: ${error.message}`);
  } finally {
    // LOG_LEVEL may come from .env; make the logger pick it up even if it already logged.
    resetLogLevel();
  }
}

function readString(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function readBool(name, fallback) {
  const raw = readString(name).toLowerCase();
  if (raw === '') return fallback;
  if (['1', 'true', 'evet', 'yes', 'on', 'acik', 'açık'].includes(raw)) return true;
  if (['0', 'false', 'hayir', 'hayır', 'no', 'off', 'kapali', 'kapalı'].includes(raw)) return false;
  throw new ConfigError(`${name} değeri "true" ya da "false" olmalı (şu an: "${process.env[name]}").`);
}

function readInt(name, fallback, min, max) {
  const raw = readString(name);
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} değeri ${min} ile ${max} arasında bir tam sayı olmalı (şu an: "${raw}").`);
  }
  return value;
}

/** Comma separated Discord ids, e.g. BOT_OWNER_IDS=123,456. Empty -> []. */
function readIdList(name) {
  const ids = readString(name)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const bad = ids.find((id) => !SNOWFLAKE.test(id));
  if (bad) throw new ConfigError(`${name} yalnızca virgülle ayrılmış Discord kimlikleri içermeli (hatalı: "${bad}").`);
  return Object.freeze(ids);
}

/** Optional https link (BRAND_AUTHOR_URL, BRAND_SUPPORT_URL). Empty -> ''. */
function readHttpsUrl(name) {
  const raw = readString(name);
  if (raw === '') return '';
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== 'https:') {
    throw new ConfigError(
      `${name} https:// ile başlayan geçerli bir adres olmalı ya da boş bırakılmalı (şu an: "${raw}").`,
    );
  }
  return url.href;
}

function readColor(name, fallback) {
  const raw = readString(name);
  if (raw === '') return fallback;
  if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) {
    throw new ConfigError(`${name} değeri 5865F2 gibi 6 haneli bir renk kodu olmalı (şu an: "${raw}").`);
  }
  return Number.parseInt(raw.replace('#', ''), 16);
}

/**
 * Reads the bot settings from the environment.
 * @param {{ requireToken?: boolean }} [options] requireToken=false lets scripts that do not
 *   log in (e.g. command validation) run without a Discord token.
 */
export function loadConfig({ requireToken = true } = {}) {
  loadEnvFile();

  const token = readString('DISCORD_TOKEN');
  const clientId = readString('DISCORD_CLIENT_ID');
  const guildId = readString('DISCORD_GUILD_ID');

  if (requireToken) {
    if (!token) {
      throw new ConfigError(
        "DISCORD_TOKEN boş. .env dosyasını açıp Discord Developer Portal > Bot sayfasındaki token'ı yazın.\n" +
          '  .env dosyanız yoksa önce .env.example dosyasını kopyalayıp adını .env yapın (README.md, 4. adım).',
      );
    }
    if (!clientId) {
      throw new ConfigError(
        'DISCORD_CLIENT_ID boş. Discord Developer Portal > General Information sayfasındaki "Application ID" değerini .env dosyasına yazın.',
      );
    }
  }
  if (clientId && !SNOWFLAKE.test(clientId)) {
    throw new ConfigError('DISCORD_CLIENT_ID yalnızca rakamlardan oluşmalı (Application ID).');
  }
  if (guildId && !SNOWFLAKE.test(guildId)) {
    throw new ConfigError('DISCORD_GUILD_ID yalnızca rakamlardan oluşmalı (sunucu kimliği) ya da boş bırakılmalı.');
  }

  const lavalinkPassword = readString('LAVALINK_PASSWORD');
  if (requireToken && !lavalinkPassword) {
    throw new ConfigError('LAVALINK_PASSWORD boş. .env dosyasına bir şifre yazın (Lavalink de aynı şifreyle açılır).');
  }

  const searchSource = readString('SEARCH_SOURCE', 'ytmsearch');
  if (!SEARCH_SOURCES.includes(searchSource)) {
    throw new ConfigError(`SEARCH_SOURCE şunlardan biri olmalı: ${SEARCH_SOURCES.join(', ')}.`);
  }

  return Object.freeze({
    discord: Object.freeze({ token, clientId, guildId, ownerIds: readIdList('BOT_OWNER_IDS') }),
    lavalink: Object.freeze({
      host: readString('LAVALINK_HOST', '127.0.0.1'),
      port: readInt('LAVALINK_PORT', 2333, 1, 65535),
      password: lavalinkPassword,
    }),
    music: Object.freeze({
      defaultVolume: readInt('DEFAULT_VOLUME', 80, 1, 150),
      twentyFourSeven: readBool('TWENTY_FOUR_SEVEN', false),
      leaveWhenEmptySeconds: readInt('LEAVE_WHEN_EMPTY_SECONDS', 60, 0, 86_400),
      leaveAfterQueueEndSeconds: readInt('LEAVE_AFTER_QUEUE_END_SECONDS', 120, 0, 86_400),
      searchSource,
      maxQueueSize: readInt('MAX_QUEUE_SIZE', 1000, 1, 10_000),
      playShowChoices: readBool('PLAY_SHOW_CHOICES', true),
    }),
    embedColor: readColor('EMBED_COLOR', 0x5865f2),
    // Links under /help. All empty by default: nothing is shown until the bot owner fills them in.
    brand: Object.freeze({
      authorName: readString('BRAND_AUTHOR_NAME').slice(0, 64),
      authorUrl: readHttpsUrl('BRAND_AUTHOR_URL'),
      supportUrl: readHttpsUrl('BRAND_SUPPORT_URL'),
    }),
    panel: readPanelConfig(),
  });
}

/** Web panel settings. The panel is off unless PANEL_ENABLED=true. */
function readPanelConfig() {
  const port = readInt('PANEL_PORT', 3000, 1, 65535);
  const rawUrl = readString('PANEL_PUBLIC_URL', `http://127.0.0.1:${port}`);
  let publicUrl;
  try {
    publicUrl = new URL(rawUrl);
  } catch {
    throw new ConfigError(
      `PANEL_PUBLIC_URL geçerli bir adres değil (şu an: "${rawUrl}"). Örnek: http://127.0.0.1:3000`,
    );
  }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || (publicUrl.pathname !== '/' && publicUrl.pathname !== '')) {
    throw new ConfigError('PANEL_PUBLIC_URL yalnızca http(s)://adres:port biçiminde olmalı, sonunda yol olmamalı.');
  }
  return Object.freeze({
    enabled: readBool('PANEL_ENABLED', false),
    host: readString('PANEL_HOST', '127.0.0.1'),
    port,
    publicUrl: publicUrl.origin,
    clientSecret: readString('DISCORD_CLIENT_SECRET'),
    sessionSecret: readString('PANEL_SESSION_SECRET'),
    trustProxy: readBool('PANEL_TRUST_PROXY', false),
  });
}
