'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Appends lines to a file and rotates it: name.log -> name.1.log -> ... -> name.<keep>.log.
 * Writes are batched (flushed every `flushMs`) to keep a chatty Lavalink cheap.
 */
class RotatingFileWriter {
  constructor(file, { maxBytes = 2 * 1024 * 1024, keep = 5, flushMs = 300 } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.flushMs = flushMs;
    this.pending = [];
    this.timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  rotatedName(index) {
    const ext = path.extname(this.file);
    return `${this.file.slice(0, -ext.length)}.${index}${ext}`;
  }

  write(line) {
    this.pending.push(`${line}\n`);
    if (!this.timer && this.flushMs > 0) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    } else if (this.flushMs <= 0) {
      this.flush();
    }
  }

  rotate() {
    for (let i = this.keep - 1; i >= 1; i -= 1) {
      const from = this.rotatedName(i);
      if (fs.existsSync(from)) fs.renameSync(from, this.rotatedName(i + 1));
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, this.rotatedName(1));
    this.size = 0;
  }

  /** Writes everything pending now (synchronously, so it also works while the app exits). */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const chunks = this.pending;
    this.pending = [];
    try {
      for (const chunk of chunks) {
        const bytes = Buffer.byteLength(chunk);
        if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
        fs.appendFileSync(this.file, chunk, 'utf8');
        this.size += bytes;
      }
    } catch {
      // Logging must never take the app down (disk full, file locked by an editor...).
    }
  }
}

/**
 * In-memory list of recent log entries for the UI plus one rotating file per source.
 * Entry: { id, time, source: 'bot'|'lavalink'|'app', level, text }
 */
class LogStore {
  constructor({ dir, limit = 5000, writerOptions } = {}) {
    this.dir = dir;
    this.limit = limit;
    this.entries = [];
    this.nextId = 1;
    this.writers = new Map();
    this.writerOptions = writerOptions;
    this.listeners = new Set();
  }

  #writer(source) {
    if (!this.dir) return null;
    if (!this.writers.has(source)) {
      this.writers.set(source, new RotatingFileWriter(path.join(this.dir, `${source}.log`), this.writerOptions));
    }
    return this.writers.get(source);
  }

  add(source, level, text, time = new Date()) {
    const entry = { id: this.nextId++, time: time.toISOString(), source, level: level ?? 'info', text: String(text) };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.#writer(source)?.write(`${entry.time} ${entry.level.toUpperCase().padEnd(5)} ${entry.text}`);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  onEntry(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Entries matching the filter: { sources?: string[], levels?: string[], search?: string, afterId?: number }. */
  query({ sources, levels, search, afterId = 0 } = {}) {
    const needle = search ? String(search).toLocaleLowerCase('tr') : '';
    return this.entries.filter(
      (e) =>
        e.id > afterId &&
        (!sources?.length || sources.includes(e.source)) &&
        (!levels?.length || levels.includes(e.level)) &&
        (!needle || e.text.toLocaleLowerCase('tr').includes(needle)),
    );
  }

  clear() {
    this.entries = [];
  }

  flush() {
    for (const writer of this.writers.values()) writer.flush();
  }
}

module.exports = { LogStore, RotatingFileWriter };
