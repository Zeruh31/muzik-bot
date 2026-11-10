// Botun durumu ("Dinliyor: /help"). Yazıyı ve türü src/gorunum.js içinde değiştirebilirsin.
// Discord durumu zaman zaman düşürdüğü için belirli aralıklarla yeniden ayarlanır.

import { ActivityType } from 'discord.js';

const TYPES = {
  dinliyor: ActivityType.Listening,
  oynuyor: ActivityType.Playing,
  izliyor: ActivityType.Watching,
  yarışıyor: ActivityType.Competing,
  yarisiyor: ActivityType.Competing,
};

/** 'Dinliyor' -> ActivityType.Listening. Unknown names fall back to Listening. */
export function activityType(name) {
  return TYPES[String(name ?? '').toLocaleLowerCase('tr')] ?? ActivityType.Listening;
}

/**
 * Sets the presence now and again every `intervalSeconds`. The timer does not keep the
 * process alive (unref), so shutting down works as before. Returns { stop }.
 */
export function startPresence(client, { metin, tur, yenilemeSaniye }, logger) {
  const apply = () => {
    try {
      client.user?.setPresence({ status: 'online', activities: [{ name: metin, type: activityType(tur) }] });
    } catch (error) {
      logger?.debug('Durum ayarlanamadı:', error?.message ?? error);
    }
  };
  apply();
  const timer = setInterval(apply, Math.max(Number(yenilemeSaniye) || 100, 10) * 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
