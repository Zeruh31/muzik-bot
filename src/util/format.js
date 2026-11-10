// Süre, zaman ve metin biçimlendirme yardımcıları (ör. 3725000 ms -> "1:02:05").
import { etiketler } from '../mesajlar.js';

// Pure formatting helpers (no Discord or Lavalink imports, so they are easy to test).

/** 3725000 -> "1:02:05", 65000 -> "1:05". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Text progress bar such as "▬▬▬🔘▬▬▬▬▬▬". */
export function progressBar(position, duration, size = 16) {
  if (!Number.isFinite(duration) || duration <= 0) return etiketler.canliCubuk;
  const ratio = Math.min(Math.max(position / duration, 0), 1);
  const index = Math.min(Math.round(ratio * (size - 1)), size - 1);
  return Array.from({ length: size }, (_, i) => (i === index ? '🔘' : '▬')).join('');
}

/**
 * Parses a user-entered time into milliseconds.
 * Accepts "90", "1:30", "1:02:30", "1m30s", "2m 10s", "1h 5m", "1sa 2dk 3sn".
 * Returns null when the input cannot be understood.
 */
export function parseTime(input) {
  const text = String(input ?? '')
    .trim()
    .toLowerCase();
  if (text === '') return null;

  if (/^\d+$/.test(text)) return Number(text) * 1000;

  if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
    const parts = text.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    return parts.reduce((acc, part) => acc * 60 + part, 0) * 1000;
  }

  const units = { h: 3600, sa: 3600, saat: 3600, m: 60, dk: 60, dakika: 60, s: 1, sn: 1, saniye: 1 };
  // Longer unit names first, otherwise "saniye" would match as "sa" (hours).
  const re = /(\d+)\s*(saniye|saat|sa|dakika|dk|sn|h|m|s)/g;
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(re)) {
    total += Number(match[1]) * units[match[2]];
    consumed += match[0];
  }
  if (consumed.replace(/\s/g, '') !== text.replace(/\s/g, '')) return null;
  return total * 1000;
}

/** Cuts a string to max length, adding an ellipsis when shortened. */
export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Escapes Discord markdown in user-controlled text such as track titles. */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/([\\*_`~|>[\]()])/g, '\\$1');
}

/** Bytes -> "123.4 MB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Milliseconds -> "2 gün 3 saat 4 dakika" (largest three units). */
export function formatUptime(ms) {
  const totalMinutes = Math.floor(Math.max(ms, 0) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  const unit = etiketler.zamanBirimleri;
  if (days) parts.push(`${days} ${unit.gun}`);
  if (hours) parts.push(`${hours} ${unit.saat}`);
  parts.push(`${minutes} ${unit.dakika}`);
  return parts.join(' ');
}
