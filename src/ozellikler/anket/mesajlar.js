// "Anket" modülünün yazıları: /oyun anket ve kontrol merkezindeki "Anket oluştur" formu.
// Komut açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Anket';
export const emoji = '📊';
export const aciklama = "Discord'un kendi anketi: oy değiştirilebilir, süresi dolunca kapanır";

export const komutlar = {
  anket: 'Anket açar (2-10 seçenek, oy değiştirilebilir, süre saat olarak)',
  secenekler: {
    soru: 'Anketin sorusu (en fazla 300 karakter)',
    secenekler: 'Seçenekler, virgülle ayırarak: Cuma, Cumartesi, Pazar (her biri en fazla 55 karakter)',
    sure: 'Kaç saat açık kalsın (1-768, varsayılan 24)',
    coklu: 'Birden fazla seçenek işaretlenebilsin',
  },
};

export const form = {
  baslik: 'Anket oluştur',
  soru: 'Soru',
  secenekler: 'Seçenekler (her satıra bir tane, 2-10)',
  seceneklerIpucu: 'Her satıra bir seçenek yazın; en fazla 55 karakter',
  sure: 'Süre (saat, 1-768)',
  sureIpucu: 'Boş bırakılırsa 24 saat',
};

export const cevaplar = {
  secenekSayisi: (enAz, enFazla) =>
    `${enAz}-${enFazla} seçenek yazın (komutta virgülle ayırarak, ör. \`Cuma, Cumartesi\`; formda her satıra bir tane).`,
  secenekUzun: (enFazla) => `Her seçenek en fazla ${enFazla} karakter olabilir.`,
  secenekTekrar: 'Aynı seçenek iki kez yazılmış.',
  soruUzunlugu: (enFazla) => `Soru 1-${enFazla} karakter olmalı.`,
  sureAraligi: (enAz, enFazla) => `Süre ${enAz} ile ${enFazla} saat arasında bir tam sayı olmalı.`,
  izinYok: 'Bu kanalda anket gönderemiyorum: bot rolünde "Anket Oluştur" (Send Polls) izni olmalı.',
};

export const bolum = {
  metin: "### 📊 Anket\nDiscord'un kendi anketi; oylar değiştirilebilir, süre dolunca kendiliğinden kapanır.",
  olustur: 'Anket oluştur',
};
