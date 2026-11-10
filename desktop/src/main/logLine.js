'use strict';

// Turns raw console lines of the bot and Lavalink into { level, source, time, message }
// records, and hides secrets before anything is shown or written to disk.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// Bot logger (src/logger.js): "[10.11.2026 09:05:28] INFO  [bot] message"
const BOT_LINE = /^\[([^\]]+)\]\s+(DEBUG|INFO|WARN|ERROR)\s*\[([^\]]+)\]\s?(.*)$/;
// Spring Boot / Lavalink: "2026-11-10T09:05:28.684+03:00  INFO 27764 --- [Lavalink] [main] logger : message"
const LAVALINK_LINE =
  /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\d+\s+---\s+(?:\[[^\]]*\]\s+)?\[\s*([^\]]*?)\s*\]\s+(\S+)\s*:\s?(.*)$/;

const LEVEL_MAP = { TRACE: 'debug', DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error' };

function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/** Parses one line printed by the bot (`node src/index.js`). */
function parseBotLine(line) {
  const text = stripAnsi(line).replace(/\s+$/, '');
  const match = BOT_LINE.exec(text);
  if (match) {
    return { level: match[2].toLowerCase(), time: match[1], scope: match[3], message: match[4], structured: true };
  }
  // index.js prints fatal startup problems as "HATA: ..." without the logger format.
  if (/^\s*HATA:/.test(text)) {
    return { level: 'error', time: null, scope: null, message: text.trim(), structured: false };
  }
  return { level: null, time: null, scope: null, message: text, structured: false };
}

/** Parses one line printed by Lavalink (Spring Boot console format). */
function parseLavalinkLine(line) {
  const text = stripAnsi(line).replace(/\s+$/, '');
  const match = LAVALINK_LINE.exec(text);
  if (match) {
    return {
      level: LEVEL_MAP[match[2]],
      time: match[1],
      scope: match[4],
      message: match[5],
      structured: true,
    };
  }
  if (/^(Exception|Error:|Caused by:|\s+at )/.test(text)) {
    return { level: 'error', time: null, scope: null, message: text, structured: false };
  }
  return { level: null, time: null, scope: null, message: text, structured: false };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MASK = '***';

/**
 * Hides secrets in a line: the given secret values (from .env) plus well-known token
 * shapes (Google refresh/access tokens, Discord bot tokens).
 * @param {string} text
 * @param {string[]} [secrets]
 */
function redact(text, secrets = []) {
  let out = String(text ?? '');
  // youtube-plugin prints: "Store your refresh token as this can be reused. (1//0abc...)"
  out = out.replace(/(refresh token[^()\n]*\()([^)\s]+)(\))/gi, `$1${MASK}$3`);
  out = out.replace(/\b1\/\/[0-9A-Za-z_-]{20,}/g, `1//${MASK}`);
  out = out.replace(/\bya29\.[0-9A-Za-z_.-]{20,}/g, `ya29.${MASK}`);
  out = out.replace(/\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g, MASK);
  const values = [...new Set(secrets.filter((s) => typeof s === 'string' && s.trim().length >= 6))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of values) out = out.replace(new RegExp(escapeRegExp(secret), 'g'), MASK);
  return out;
}

module.exports = { parseBotLine, parseLavalinkLine, redact, stripAnsi, MASK };
