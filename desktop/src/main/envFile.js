'use strict';

// Reads and edits the project's .env file.
//
// Parsing follows the same rules as Node's built-in parser (process.loadEnvFile /
// util.parseEnv), which the bot uses, and lavalink/dotenv.ps1:
//  - blank lines and lines starting with # are skipped, an optional "export " is ignored
//  - KEY = everything before the first "=", trimmed; lines without "=" are skipped
//  - a value starting with " ' or ` runs to the next same quote (it may span lines);
//    anything after the closing quote is ignored; only "\n" inside double quotes
//    becomes a newline
//  - an unquoted value ends at the first #, then surrounding spaces are trimmed
//  - a later line with the same key wins
//
// Writing only touches the lines of the keys that change. Comments, blank lines, the
// order of keys, unknown keys, line endings and a UTF-8 BOM are all kept.

const QUOTES = ['"', "'", '`'];

/**
 * Parses .env text into a document that remembers where every entry lives.
 * @returns {{ bom: boolean, eol: string, lines: string[], entries: Array<{
 *   key: string, value: string, start: number, end: number, head: string, tail: string }> }}
 */
function parseEnvDocument(text) {
  const source = String(text ?? '');
  const bom = source.charCodeAt(0) === 0xfeff;
  const body = bom ? source.slice(1) : source;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r\n|\r|\n/);
  const entries = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    let trimmed = raw.trim();
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trimStart();
    const eq = trimmed.indexOf('=');
    if (trimmed === '' || trimmed.startsWith('#') || eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    const rawEq = raw.indexOf('=');
    const afterEq = raw.slice(rawEq + 1);
    const leading = afterEq.match(/^\s*/)[0];
    const head = raw.slice(0, rawEq + 1) + leading;
    const rest = afterEq.slice(leading.length);

    let value = null;
    let tail = '';
    let end = i;
    const quote = rest[0];
    if (rest.length > 0 && QUOTES.includes(quote)) {
      const close = rest.indexOf(quote, 1);
      if (close > 0) {
        value = rest.slice(1, close);
        tail = rest.slice(close + 1);
      } else {
        // Multi-line value: the closing quote may be on a following line.
        for (let j = i + 1; j < lines.length; j += 1) {
          const at = lines[j].indexOf(quote);
          if (at >= 0) {
            value = [rest.slice(1), ...lines.slice(i + 1, j), lines[j].slice(0, at)].join('\n');
            tail = lines[j].slice(at + 1);
            end = j;
            break;
          }
        }
      }
      if (value !== null && quote === '"') value = value.replaceAll('\\n', '\n');
    }
    if (value === null) {
      const hash = rest.indexOf('#');
      const valuePart = hash >= 0 ? rest.slice(0, hash) : rest;
      value = valuePart.trim();
      tail = hash >= 0 ? valuePart.slice(valuePart.trimEnd().length) + rest.slice(hash) : '';
    }

    entries.push({ key, value, start: i, end, head, tail });
    i = end;
  }
  return { bom, eol, lines, entries };
}

/** KEY -> value, like util.parseEnv (later duplicates win). */
function parseEnv(text) {
  const result = {};
  for (const entry of parseEnvDocument(text).entries) result[entry.key] = entry.value;
  return result;
}

/** Keys in the order they first appear in the file. */
function envKeys(text) {
  return [...new Set(parseEnvDocument(text).entries.map((entry) => entry.key))];
}

/**
 * The comment block written right above each key (used to describe keys the form does not
 * know, straight from .env.example). Section rulers like "# --- Discord ---" are skipped.
 */
function keyComments(text) {
  const doc = parseEnvDocument(text);
  const result = {};
  for (const entry of doc.entries) {
    const lines = [];
    for (let i = entry.start - 1; i >= 0; i -= 1) {
      const line = doc.lines[i].trim();
      if (!line.startsWith('#')) break;
      const body = line.replace(/^#\s?/, '');
      if (/^(-{3}|={3})/.test(body) || /^[A-Z_][A-Z0-9_]*=/.test(body)) continue;
      lines.unshift(body);
    }
    if (lines.length && !(entry.key in result)) result[entry.key] = lines.join(' ').trim();
  }
  return result;
}

class EnvValueError extends Error {
  constructor(key, message) {
    super(`${key}: ${message}`);
    this.name = 'EnvValueError';
    this.key = key;
  }
}

/**
 * Turns a value into text that the parser above reads back unchanged.
 * Quotes are only added when needed.
 */
function serializeValue(key, value) {
  const text = String(value ?? '');
  if (/[\r\n]/.test(text)) throw new EnvValueError(key, 'değer birden fazla satır olamaz.');
  if (text === '') return '';
  const needsQuotes = text.includes('#') || text !== text.trim() || QUOTES.includes(text[0]);
  if (!needsQuotes) return text;
  for (const quote of QUOTES) {
    if (text.includes(quote)) continue;
    // Inside double quotes the two characters \n would turn into a newline.
    if (quote === '"' && text.includes('\\n')) continue;
    return `${quote}${text}${quote}`;
  }
  throw new EnvValueError(key, 'değer aynı anda ", \' ve ` işaretlerini içeremez.');
}

/** A trailing part that stays harmless after the value: nothing, spaces, or a # comment. */
function safeTail(tail) {
  return /^\s*(#.*)?$/.test(tail) ? tail : '';
}

/**
 * Applies `updates` (KEY -> new value) to .env text and returns the new text.
 * Existing keys are rewritten in place (every occurrence, so the value that wins is the
 * new one); a trailing "# comment" on the line is kept. Missing keys are appended.
 */
function updateEnvText(text, updates) {
  const doc = parseEnvDocument(text);
  const lines = [...doc.lines];
  const pending = new Map(Object.entries(updates));
  const seen = new Set();

  // Walk backwards so replacing multi-line entries does not shift earlier indexes.
  for (const entry of [...doc.entries].reverse()) {
    if (!pending.has(entry.key)) continue;
    seen.add(entry.key);
    const serialized = serializeValue(entry.key, pending.get(entry.key));
    const line = entry.head + serialized + safeTail(entry.tail);
    lines.splice(entry.start, entry.end - entry.start + 1, line);
  }

  const missing = [...pending.keys()].filter((key) => !seen.has(key));
  if (missing.length) {
    // Keep one line break between the old content and the appended keys.
    while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') lines.pop();
    const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
    if (hadTrailingNewline) lines.pop();
    for (const key of missing) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new EnvValueError(key, 'geçersiz anahtar adı.');
      lines.push(`${key}=${serializeValue(key, pending.get(key))}`);
    }
    const wasEmpty = doc.lines.length === 1 && doc.lines[0] === '';
    if (hadTrailingNewline || wasEmpty) lines.push('');
  }

  return (doc.bom ? '﻿' : '') + lines.join(doc.eol);
}

module.exports = { parseEnvDocument, parseEnv, envKeys, keyComments, serializeValue, updateEnvText, EnvValueError };
