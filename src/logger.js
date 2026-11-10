// Konsola tarihli kayıt yazar: "[tarih] SEVİYE [kaynak] mesaj". Masaüstü uygulaması bu biçimi
// okuduğu için biçimi değiştirme. Minimal timestamped console logger, dependency-free on purpose.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Read lazily: the logger module is imported before config.js loads .env, so reading
// LOG_LEVEL at import time would ignore the value set in .env.
let threshold = null;
function currentThreshold() {
  threshold ??= LEVELS[(process.env.LOG_LEVEL ?? 'info').trim().toLowerCase()] ?? LEVELS.info;
  return threshold;
}

/** Forgets the cached level so the next log line re-reads LOG_LEVEL (called after .env is loaded). */
export function resetLogLevel() {
  threshold = null;
}

function stamp() {
  return new Date().toLocaleString('tr-TR', { hour12: false });
}

function write(level, scope, args) {
  if (LEVELS[level] < currentThreshold()) return;
  const line = `[${stamp()}] ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line, ...args);
}

/** Creates a logger bound to a scope name, e.g. createLogger('bot'). */
export function createLogger(scope) {
  return {
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
