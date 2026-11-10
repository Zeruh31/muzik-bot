'use strict';

// Builds the command lines for Lavalink and the bot. The Lavalink part does what
// lavalink/baslat.ps1 does, but starts java.exe directly (hidden) instead of a PowerShell
// window:
//  1) Java must exist and be 17 or newer
//  2) lavalink/Lavalink.jar must exist
//  3) the Lavalink settings from .env are passed as environment variables,
//     LAVALINK_PASSWORD must not be empty, SPOTIFY_ENABLED is true only when both Spotify
//     keys exist, LAVALINK_PORT is validated (default 2333)
//  4) java -Xmx<LAVALINK_JAVA_MEMORY or 512M> -jar Lavalink.jar, working directory lavalink/
//
// Child processes get a whitelisted environment: the ordinary Windows variables plus, for
// Lavalink, only the keys application.yml reads. Anything else (JAVA_TOOL_OPTIONS,
// _JAVA_OPTIONS, NODE_OPTIONS, ELECTRON_*...) never reaches java.exe or node.exe, whether it
// comes from the system or from .env. The bot reads .env itself (process.loadEnvFile).

const fs = require('node:fs');
const path = require('node:path');
const { LaunchError } = require('./service');

/** Case-insensitive lookup, because Windows environment names are case-insensitive. */
function getEnv(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function setEnv(env, name, value) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  env[name] = value;
}

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

/** Ordinary Windows variables programs need to run (paths, temp, user folders, proxy). */
const SYSTEM_ENV_KEYS = [
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMPUTERNAME',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'JAVA_HOME',
  'LANG',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TZ',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR',
];

/** .env keys Lavalink needs (application.yml placeholders). */
const LAVALINK_ENV_KEYS = [
  'LAVALINK_PASSWORD',
  'LAVALINK_PORT',
  'YOUTUBE_OAUTH_REFRESH_TOKEN',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
];

/** Environment for child processes: only whitelisted system variables. */
function childBaseEnv(baseEnv) {
  const allowed = new Set(SYSTEM_ENV_KEYS);
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (allowed.has(key.toUpperCase()) && typeof value === 'string') env[key] = value;
  }
  return env;
}

/** Finds an executable on PATH (with PATHEXT), like `Get-Command`. */
function findExecutable(name, env, exists = fs.existsSync) {
  const dirs = String(getEnv(env, 'PATH') ?? '')
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const exts = path.extname(name)
    ? ['']
    : String(getEnv(env, 'PATHEXT') ?? '.EXE;.CMD;.BAT')
        .split(';')
        .filter((e) => /^\.(exe|com)$/i.test(e));
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Path of java.exe from PATH, then JAVA_HOME. */
function findJava(env, exists = fs.existsSync) {
  const onPath = findExecutable('java.exe', env, exists);
  if (onPath) return onPath;
  const home = getEnv(env, 'JAVA_HOME');
  if (!isBlank(home)) {
    const candidate = path.join(home, 'bin', 'java.exe');
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Major version from `java -version` output ("openjdk version "21.0.12.1"", or "1.8.0_x" -> 8). */
function parseJavaMajor(text) {
  const match = /version "(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!match) return null;
  const first = Number(match[1]);
  return first === 1 && match[2] ? Number(match[2]) : first;
}

/** LAVALINK_PORT with the same rule as Get-LavalinkPort in lavalink/dotenv.ps1. */
function parseLavalinkPort(raw) {
  if (isBlank(raw)) return 2333;
  const text = String(raw).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) {
    throw new LaunchError(`LAVALINK_PORT 1 ile 65535 arasında bir sayı olmalı (şu an: ${raw}).`);
  }
  return port;
}

function parseHeap(raw) {
  if (isBlank(raw)) return '512M';
  const text = String(raw).trim();
  if (!/^\d+[kKmMgG]?$/.test(text)) {
    throw new LaunchError(`LAVALINK_JAVA_MEMORY 512M ya da 1G gibi olmalı (şu an: ${raw}).`);
  }
  return text;
}

/** Whitelisted system environment plus the Lavalink keys from .env (nothing else). */
function lavalinkEnv(baseEnv, envValues) {
  const env = childBaseEnv(baseEnv);
  for (const key of LAVALINK_ENV_KEYS) {
    if (!isBlank(envValues[key])) setEnv(env, key, String(envValues[key]));
  }
  return env;
}

/**
 * @param {{ projectDir: string, envValues: Record<string,string>, baseEnv: object, javaPath: string|null,
 *           javaMajor: number|null, exists?: (p: string) => boolean }} options
 */
function buildLavalinkLaunch({ projectDir, envValues, baseEnv, javaPath, javaMajor, exists = fs.existsSync }) {
  if (!javaPath) {
    throw new LaunchError(
      'Java bulunamadı. Lavalink için Java 17 veya daha yenisi gerekir (önerilen: Java 21, https://adoptium.net). Kurduktan sonra uygulamayı kapatıp yeniden açın.',
    );
  }
  if (javaMajor !== null && javaMajor !== undefined && javaMajor < 17) {
    throw new LaunchError(`Java sürümünüz çok eski (Java ${javaMajor}). Java 17 veya daha yenisi gerekir.`);
  }
  const lavalinkDir = path.join(projectDir, 'lavalink');
  const jarPath = path.join(lavalinkDir, 'Lavalink.jar');
  if (!exists(jarPath)) {
    throw new LaunchError('lavalink\\Lavalink.jar yok. Araçlar sekmesindeki "Lavalink\'i indir" düğmesine basın.');
  }

  const env = lavalinkEnv(baseEnv, envValues);
  if (isBlank(getEnv(env, 'LAVALINK_PASSWORD'))) {
    throw new LaunchError(
      'LAVALINK_PASSWORD boş. Ayarlar > Lavalink bölümünde kendinize bir şifre belirleyin (bot da aynı şifreyi kullanır).',
    );
  }
  const spotify = !isBlank(getEnv(env, 'SPOTIFY_CLIENT_ID')) && !isBlank(getEnv(env, 'SPOTIFY_CLIENT_SECRET'));
  setEnv(env, 'SPOTIFY_ENABLED', spotify ? 'true' : 'false');
  const port = parseLavalinkPort(getEnv(env, 'LAVALINK_PORT'));
  // application.yml reads the same variable: port: ${LAVALINK_PORT:2333}
  setEnv(env, 'LAVALINK_PORT', String(port));
  const heap = parseHeap(envValues.LAVALINK_JAVA_MEMORY);

  return {
    command: javaPath,
    // Java writes to pipes in the ANSI code page by default; UTF-8 keeps "ü" and friends intact.
    args: [`-Xmx${heap}`, '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-jar', jarPath],
    cwd: lavalinkDir,
    env,
    port,
    spotify,
    youtubeLoggedIn: !isBlank(getEnv(env, 'YOUTUBE_OAUTH_REFRESH_TOKEN')),
  };
}

/** Command for the bot: `node src/index.js` in the project folder. */
function buildBotLaunch({ projectDir, baseEnv, nodePath, nodeMajor, exists = fs.existsSync }) {
  if (!nodePath) {
    throw new LaunchError(
      'Node.js bulunamadı. Node.js 24 veya daha yenisini kurun (https://nodejs.org), sonra uygulamayı yeniden açın.',
    );
  }
  if (nodeMajor !== null && nodeMajor !== undefined && nodeMajor < 24) {
    throw new LaunchError(`Node.js sürümünüz eski (v${nodeMajor}). Bot için Node.js 24 veya daha yenisi gerekir.`);
  }
  const entry = path.join(projectDir, 'src', 'index.js');
  if (!exists(entry)) throw new LaunchError(`Botun giriş dosyası bulunamadı: ${entry}`);
  if (!exists(path.join(projectDir, 'node_modules'))) {
    throw new LaunchError('Botun bağımlılıkları kurulmamış. Proje klasöründe bir kez "npm install" çalıştırın.');
  }
  return { command: nodePath, args: [entry], cwd: projectDir, env: childBaseEnv(baseEnv) };
}

/** Command for one of the bot's helper scripts (`node scripts/<name>.js`). */
function buildScriptLaunch({ projectDir, baseEnv, nodePath, script, args = [] }) {
  if (!nodePath) throw new LaunchError('Node.js bulunamadı.');
  return {
    command: nodePath,
    args: [path.join(projectDir, 'scripts', script), ...args],
    cwd: projectDir,
    env: childBaseEnv(baseEnv),
  };
}

module.exports = {
  getEnv,
  childBaseEnv,
  findExecutable,
  findJava,
  parseJavaMajor,
  parseLavalinkPort,
  parseHeap,
  lavalinkEnv,
  SYSTEM_ENV_KEYS,
  LAVALINK_ENV_KEYS,
  buildLavalinkLaunch,
  buildBotLaunch,
  buildScriptLaunch,
};
