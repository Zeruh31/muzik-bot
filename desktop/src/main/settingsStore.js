'use strict';

// App options (not the bot's .env): stored as JSON in the app's user-data folder.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  projectDir: null,
  autoStartBot: false,
  openAtLogin: false,
  autoRestart: true,
  trayNoticeShown: false,
});

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (
          key in saved &&
          (saved[key] === null || typeof saved[key] === typeof DEFAULTS[key] || DEFAULTS[key] === null)
        ) {
          this.data[key] = saved[key];
        }
      }
    } catch {
      // first start or unreadable file: defaults
    }
  }

  get(key) {
    return this.data[key];
  }

  all() {
    return { ...this.data };
  }

  /** Updates known keys only and writes the file atomically. */
  set(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
      if (DEFAULTS[key] !== null && typeof value !== typeof DEFAULTS[key]) continue;
      this.data[key] = value;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
    return this.all();
  }
}

module.exports = { SettingsStore, DEFAULTS };
