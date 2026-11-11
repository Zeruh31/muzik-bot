// "Karşılama" modülünün yazıları: hoş geldin / güle güle mesajları, kartları ve kontrol merkezi bölümü.
// Komut ve ayar açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Karşılama';
export const emoji = '👋';
export const aciklama = 'Hoş geldin / güle güle mesajı ve otomatik rol (yöneticiler için)';
export const ayarGrubu = 'Hoş geldin, güle güle ve otomatik rol ayarları';

// /ayar karsilama <ayar> açıklamaları (en fazla 100 karakter)
export const ayarlar = {
  'hosgeldin-kanal': 'Hoş geldin mesajının kanalı (boşsa mesaj gönderilmez)',
  'hosgeldin-metni': 'Hoş geldin metni: {kullanıcı}, {ad}, {sunucu}, {üye_sayısı}',
  'hosgeldin-kart': 'Hoş geldin mesajında görsel kart olsun (varsayılan açık)',
  'gulegule-kanal': 'Güle güle mesajının kanalı (boşsa mesaj gönderilmez)',
  'gulegule-metni': 'Güle güle metni: {kullanıcı}, {ad}, {sunucu}, {üye_sayısı}',
  'gulegule-kart': 'Güle güle mesajında görsel kart olsun (varsayılan kapalı)',
  'kart-renk': 'Kartın arka plan rengi, ör. #2b2d31',
  'kart-gorsel': 'Kartın arka plan görseli: https adresi (PNG/JPEG/WebP, en çok 4 MB)',
  'otorol-1': 'Katılan herkese verilecek rol',
  'otorol-2': 'Katılan herkese verilecek ikinci rol',
  'otorol-3': 'Katılan herkese verilecek üçüncü rol',
  'bot-rol': 'Katılan botlara verilecek rol (botlar otomatik rolleri almaz)',
};

export const varsayilanlar = {
  hosgeldin: 'Hoş geldin {kullanıcı}! **{sunucu}** sunucusunun {üye_sayısı}. üyesisin. 🎉',
  gulegule: '**{ad}** aramızdan ayrıldı. Şimdi {üye_sayısı} kişiyiz. 👋',
};

export const kart = {
  hosgeldinBaslik: 'Hoş geldin',
  gulegulebaslik: 'Güle güle',
  hosgeldinAlt: (sira, sunucu) => `${sunucu} • ${sira}. üye`,
  gulegulealt: (sayi, sunucu) => `${sunucu} • şimdi ${sayi} kişiyiz`,
  dosyaAdi: 'karsilama.png',
};

export const cevaplar = {
  yetkiYok: 'Bunu yalnız "Sunucuyu Yönet" izni olanlar yapabilir.',
  onizlemeBasligi: (tur) => `-# Önizleme (${tur === 'hosgeldin' ? 'hoş geldin' : 'güle güle'}); kimseye gönderilmedi.`,
  kanalYok: (tur) =>
    `${tur === 'hosgeldin' ? 'Hoş geldin' : 'Güle güle'} kanalı ayarlı değil, bu yüzden şu an mesaj gönderilmiyor. ` +
    `\`/ayar karsilama ${tur}-kanal\` ile seçin.`,
  gorselUyari:
    'Arka plan görseli kullanılamadı (https olmalı, herkese açık bir adresten, PNG/JPEG/WebP/GIF, en çok 4 MB ve 4096 piksel); düz renk kullanıldı.',
};

export const bolum = {
  metin: (hosgeldinKanal, gulegulekanal, roller) =>
    [
      '### 👋 Karşılama',
      `Hoş geldin: ${hosgeldinKanal ? `<#${hosgeldinKanal}>` : '_kapalı_'} • Güle güle: ${gulegulekanal ? `<#${gulegulekanal}>` : '_kapalı_'}`,
      `Otomatik rol: ${roller || '_yok_'}`,
      '-# Ayarlar: `/ayar karsilama ...`. Önizleme yalnız size gösterilir.',
    ].join('\n'),
  hosgeldin: 'Hoş geldin önizle',
  gulegule: 'Güle güle önizle',
};
