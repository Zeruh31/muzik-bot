// Bir kanala kendiliğinden (bir olay ya da zamanlayıcı yüzünden) mesaj gönderen özellikler için koruma:
// kayıt kanalı, hoş geldin, seviye duyurusu, ücretsiz oyun gibi. Kanal silinmişse ya da botun orada yazma izni
// yoksa Discord her mesajda 403/404 döner; her olayda yeniden denemek hem boşa istek hem de konsolda yüzlerce
// hata demektir. Bu yardımcı böyle bir hatadan sonra o hedefe gönderimi artan sürelerle durdurur
// (5 dk, 10 dk, 20 dk ... en çok 6 saat), her duraklamada konsola tek bir Türkçe uyarı yazar ve ilk başarılı
// gönderimde her şeyi sıfırlar. Normalde bu dosyaya dokunmana gerek yok.

import { RESTJSONErrorCodes } from 'discord.js';
import { systemClock } from './_zamanlayici.js';

export const ILK_BEKLEME_MS = 5 * 60_000;
export const EN_UZUN_BEKLEME_MS = 6 * 60 * 60_000;
/** Errors that will not go away by trying again soon: no access, missing permission, gone. */
const ERISIM_KODLARI = new Set([
  RESTJSONErrorCodes.MissingAccess, // 50001
  RESTJSONErrorCodes.MissingPermissions, // 50013
  RESTJSONErrorCodes.UnknownChannel, // 10003
]);

/** Whether an error means the target cannot be written to for now (403, 404, 50001, 50013, 10003). */
export function isAccessError(error) {
  return ERISIM_KODLARI.has(error?.code) || error?.status === 403 || error?.status === 404;
}

/**
 * @param {{ clock?: { now: () => number }, logger?: object }} [deps]
 * @returns the guard: gonder(), durum()
 */
export function createSendGuard({ clock = systemClock, logger } = {}) {
  /** key -> { kadar, bekleme, hata } while paused */
  const paused = new Map();

  return {
    /**
     * Runs `send` unless `key` (e.g. "kayit:<guildId>") is paused. Never throws.
     * @param {string} key one target, e.g. a feature and a guild
     * @param {() => Promise<*>} send
     * @param {(hata: string, dakika: number) => string} uyari the Turkish console line for a pause
     * @returns {Promise<'gonderildi'|'durduruldu'|'hata'>}
     */
    async gonder(key, send, uyari) {
      const state = paused.get(key);
      const now = clock.now();
      if (state && now < state.kadar) return 'durduruldu';
      try {
        await send();
        paused.delete(key);
        return 'gonderildi';
      } catch (error) {
        if (!isAccessError(error)) {
          logger?.debug?.(`Gönderilemedi (${key}): ${error?.message ?? error}`);
          return 'hata';
        }
        const bekleme = state ? Math.min(state.bekleme * 2, EN_UZUN_BEKLEME_MS) : ILK_BEKLEME_MS;
        const hata = String(error?.message ?? error).slice(0, 200);
        paused.set(key, { kadar: now + bekleme, bekleme, hata });
        logger?.warn?.(uyari(hata, Math.round(bekleme / 60_000)));
        return 'durduruldu';
      }
    },

    /** { kadar, hata } while `key` is paused, otherwise null. */
    durum(key) {
      const state = paused.get(key);
      return state && clock.now() < state.kadar ? { kadar: state.kadar, hata: state.hata } : null;
    },

    /** Forgets a pause (e.g. after the target was changed in the settings). */
    sifirla(key) {
      paused.delete(key);
    },
  };
}
