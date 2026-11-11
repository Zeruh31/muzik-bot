// Sesli komutların kuralları: hangi niyet çift kanıt ister, hangisi hangi DJ kuralına uyar, Whisper'a verilen
// ipucu kelimeleri. Söyleyişler (kalıplar) kaliplar.js'te. Yeni bir niyet türü eklemek kod ister
// (kaliplar.js'e kalıp, burada kurallar, yonetici.js > apply içinde ne yapacağı, mesajlar.js'te cevabı).

/** Volume change of "sesi kıs" / "sesi aç". */
export const SES_ADIMI = 20;

/** Seek step in ms of "ileri al" / "geri sar" when no duration is said. */
export const SARMA_ADIMI = 10_000;

/** Words given to Whisper as hotwords on the first pass (karar: control verbs only, never whole commands). */
export const HOTWORDS = 'aç çal durdur geç atla duraklat devam sesi kıs önceki karıştır tekrarla sar ekle';

/** Commands that change what is playing or how: the second pass must agree (çift kanıt). Information never. */
export const CIFT_KANIT = Object.freeze(
  new Set([
    'kapat',
    'gec',
    'duraklat',
    'ses-kis',
    'ses-ayarla',
    'sar-ileri',
    'sar-geri',
    'sar-konum',
    'sessiz',
    'basa-sar',
    'siraya-atla',
    'tekrarla',
    'tekrar-liste',
    'dongu-kapat',
    'karistir',
    'otomatik-ac',
    'otomatik-kapat',
  ]),
);

/** Commands about the song that was playing when they were said: refused when the song changed meanwhile. */
export const SARKIYA_BAGLI = Object.freeze(
  new Set(['gec', 'onceki', 'tekrarla', 'sar-ileri', 'sar-geri', 'sar-konum', 'basa-sar', 'siraya-atla']),
);

/** Answers with text only: no DJ rule, no state change. */
export const BILGI = Object.freeze(new Set(['bilgi-calan', 'bilgi-sira', 'bilgi-sayi']));

/** The slash command whose DJ rule (src/bot/dj.js) each voice command follows (null: none). */
export const DJ_KARSILIGI = Object.freeze({
  cal: 'play',
  'kuyruga-ekle': 'play',
  'hemen-cal': 'playfirst',
  'liste-cal': 'liste',
  kapat: 'stop',
  gec: 'skip',
  duraklat: 'pause',
  devam: 'resume',
  'ses-kis': 'volume',
  'ses-ac': 'volume',
  'ses-ayarla': 'volume',
  sessiz: 'volume',
  'sesi-geri-ac': 'volume',
  'sar-ileri': 'seek',
  'sar-geri': 'seek',
  'sar-konum': 'seek',
  'basa-sar': 'seek',
  'siraya-atla': 'skipto',
  onceki: 'previous',
  karistir: 'shuffle',
  tekrarla: 'loop',
  'tekrar-liste': 'loopqueue',
  'dongu-kapat': 'loop',
  'otomatik-ac': 'autoplay',
  'otomatik-kapat': 'autoplay',
  'bilgi-calan': null,
  'bilgi-sira': null,
  'bilgi-sayi': null,
});
