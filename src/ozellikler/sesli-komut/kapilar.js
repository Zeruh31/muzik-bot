// Bir cümlenin komut olarak uygulanıp uygulanmayacağını belirleyen kapılar (karar.md, 6. madde). Saf işlevler.
//   a) akustik   Whisper'ın "konuşma yok" olasılığı < 0.35 ve sıkıştırma oranı < 2.0 (uydurma ve tekrar döngüsü)
//   b) konum     uyandırma sözü ilk 3 kelimede (niyet.js)
//   c) sözdizimi komut tablosuna uyuyor (niyet.js)
//   d) durum     çalmıyorken "geç", duraklatılmışken "durdur", duraklatılmamışken "devam et" gibi anlamsız komutlar sessizce yok sayılır
//   e) çift kanıt çalanı değiştiren komutlar (komutlar.js > CIFT_KANIT) ikinci geçişte (yalnız uyandırma sözü
//                ile) aynı niyeti vermezse uygulanmaz
// Akustik kapı ve ikinci geçiş ayardan kapatılabilir; diğerleri her zaman açık.

import { VOLUME_MAX, VOLUME_MIN } from '../../music/MusicService.js';
import { CIFT_KANIT } from './komutlar.js';
import { cozumle } from './niyet.js';

export const AKUSTIK = Object.freeze({ nspMax: 0.35, crMax: 2.0 });

/** Gate a: the recogniser itself thinks it heard speech, and the text is not a repetition loop. */
export function akustikKapi({ nsp, cr } = {}, { nspMax = AKUSTIK.nspMax, crMax = AKUSTIK.crMax } = {}) {
  return Number.isFinite(nsp) && Number.isFinite(cr) && nsp < nspMax && cr < crMax;
}

/**
 * Gates a-c for one transcript.
 * @returns {{ sonuc: 'yoksay', neden: string } | { sonuc: 'anlamadim', uyandirma } | { sonuc: 'niyet', niyet, uyandirma }}
 */
export function degerlendir(utt, wake, { akustik = true, kirpik = kirpikKaniti(utt) } = {}) {
  if (akustik && !akustikKapi(utt)) return { sonuc: 'yoksay', neden: 'akustik' };
  const found = cozumle(utt?.text ?? '', wake, { kirpik });
  if (!found) return { sonuc: 'yoksay', neden: 'uyandirma' };
  if (found.niyet.tur === 'anlasilmadi') {
    // Only a clear, whole wake phrase earns an "anlamadım" (with a "did you mean" when something is close): a
    // loose or cut-off match on ordinary talk stays silent.
    return found.uyandirma.dist <= 1 && !found.uyandirma.dropped
      ? { sonuc: 'anlamadim', uyandirma: found.uyandirma, oneri: found.niyet.oneri ?? null }
      : { sonuc: 'yoksay', neden: 'anlasilmadi' };
  }
  return { sonuc: 'niyet', niyet: found.niyet, uyandirma: found.uyandirma };
}

/**
 * Gate d: whether the command means something in the player's state (a getState() snapshot or null).
 * A meaningless one is ignored without an answer.
 */
export function durumKapisi(niyet, state) {
  const current = Boolean(state?.current);
  const queue = state?.queue?.length ?? 0;
  switch (niyet?.tur) {
    case 'cal':
    case 'kuyruga-ekle':
    case 'hemen-cal':
    case 'liste-cal':
    case 'bilgi-calan':
    case 'bilgi-sira':
    case 'bilgi-sayi':
      return true;
    case 'kapat':
    case 'gec':
    case 'tekrarla':
    case 'tekrar-liste':
    case 'basa-sar':
      return current;
    case 'dongu-kapat':
      return current && (state.repeatMode ?? 'off') !== 'off';
    case 'sar-ileri':
    case 'sar-geri':
      return current && !state.current.isStream;
    case 'sar-konum':
      return current && !state.current.isStream && !(state.current.duration > 0 && niyet.ms >= state.current.duration);
    case 'siraya-atla':
      return niyet.sira >= 1 && niyet.sira <= queue;
    case 'ses-ayarla':
      return current && state.volume !== niyet.seviye;
    case 'sessiz':
      return current && !state.muted;
    case 'sesi-geri-ac':
      return Boolean(state?.muted);
    case 'otomatik-ac':
      return Boolean(state) && !state.autoplay;
    case 'otomatik-kapat':
      return Boolean(state?.autoplay);
    case 'duraklat':
      return current && !state.paused;
    case 'devam':
      return current && Boolean(state.paused);
    case 'ses-kis':
      return current && state.volume > VOLUME_MIN;
    case 'ses-ac':
      return current && state.volume < VOLUME_MAX;
    case 'onceki':
      return Boolean(state?.hasPrevious);
    case 'karistir':
      return queue >= 2;
    default:
      return false;
  }
}

/**
 * Evidence that the start of the audio may be cut: speech began within KIRPIK_ONSET_MS of the received audio
 * (nothing before it), and not at an artificial start after a 10 s split. Only then is a cut-off wake phrase
 * accepted at all.
 */
export const KIRPIK_ONSET_MS = 150;
export function kirpikKaniti(utt) {
  const vad = utt?.vad;
  return Boolean(vad) && Number.isFinite(vad.onsetMs) && vad.onsetMs <= KIRPIK_ONSET_MS && !vad.yapay;
}

/** Gate e applies to this command; always after a cut-off wake phrase. */
export const ciftKanitGerekir = (niyet, uyandirma = null) => Boolean(uyandirma?.dropped) || CIFT_KANIT.has(niyet?.tur);

/** Gate e: the second pass gave the same command. */
export function ayniNiyet(a, b) {
  if (!a || !b || a.tur !== b.tur) return false;
  // Same values too: "sesi 30 yap" and "sesi 40 yap" are not the same command.
  for (const key of ['sorgu', 'ad', 'seviye', 'ms', 'sira', 'adim']) if (a[key] !== b[key]) return false;
  return true;
}
