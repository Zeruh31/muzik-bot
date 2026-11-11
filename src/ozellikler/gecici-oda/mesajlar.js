// "Geçici odalar" modülünün yazıları: oda adı, odadaki kontrol mesajı, cevaplar ve kontrol merkezi bölümü.
// Ayar açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Geçici odalar';
export const emoji = '🔊';
export const aciklama = '"➕ Oda aç" kanalına girene kendi ses odası açılır';
export const ayarGrubu = 'Geçici ses odaları';

// /ayar gecici-oda <ayar> açıklamaları
export const ayarlar = {
  kanal: 'Girince oda açılan ses kanalı (ör. "➕ Oda aç")',
  kategori: 'Odaların kategorisi (boşsa "Oda aç" kanalınınki)',
  limit: 'Yeni odaların kişi sınırı (0 = sınırsız)',
  bekleme: 'Yeni oda açma bekleme süresi, saniye (varsayılan 30)',
};

/** The name of a new room ({kullanıcı} is the owner's server nickname). */
export const odaAdi = (kullanici) => `${kullanici} odası`;

export const kontrol = {
  baslik: '## 🔊 Oda kontrolleri',
  sahip: (kisiId) => `Sahip: <@${kisiId}>`,
  sinir: (n) => `Kişi sınırı: ${n ? n : 'sınırsız'}`,
  kilit: (kilitli) => (kilitli ? '🔒 Kilitli: yalnız içeridekiler ve izin verilenler girebilir' : '🔓 Açık'),
  ipucu: '-# Bu düğmeleri yalnız odanın sahibi kullanabilir. Oda boşalınca 10 saniye sonra silinir.',
  ad: 'Adı değiştir',
  limit: 'Kişi sınırı',
  kilitle: 'Kilitle',
  ac: 'Kilidi aç',
  at: 'Birini odadan at',
  devret: 'Sahipliği devret',
};

export const form = {
  adBaslik: 'Oda adı',
  ad: 'Yeni ad',
  limitBaslik: 'Kişi sınırı',
  limit: 'Kaç kişi (0 = sınırsız, en fazla 99)',
};

export const cevaplar = {
  odaYok: 'Bu oda artık yok ya da bot tarafından açılmadı.',
  yoneticiGerekli: 'Bu ayarı yalnız "Sunucuyu Yönet" izni olanlar değiştirebilir.',
  sahipDegil: 'Bunu yalnız odanın sahibi (ya da "Sunucuyu Yönet" izni olanlar) yapabilir.',
  bekle: (kisiId, saniye) => `<@${kisiId}>, yeni oda açmak için ${saniye} saniye bekleyin.`,
  adGecersiz: 'Ad 1-100 karakter olmalı ve görünmeyen karakter içermemeli.',
  adSiniri: (dakika) =>
    `Discord bir kanalın adının 10 dakikada en fazla 2 kez değiştirilmesine izin veriyor. ${dakika} dakika sonra tekrar deneyin.`,
  adDegisti: (ad) => `✅ Odanın yeni adı: **${ad}**`,
  limitGecersiz: 'Kişi sınırı 0 ile 99 arasında bir tam sayı olmalı.',
  limitDegisti: (n) => `✅ Kişi sınırı: ${n ? n : 'sınırsız'}`,
  kilitlendi: '🔒 Oda kilitlendi.',
  kilitAcildi: '🔓 Odanın kilidi açıldı.',
  kendini: 'Kendinizi seçemezsiniz.',
  botOlmaz: 'Bir bot seçilemez.',
  uyeBulunamadi: 'Bu kişi sunucuda bulunamadı.',
  yoneticiAtilamaz: '"Sunucuyu Yönet" ya da "Üyeleri Taşı" izni olan biri odadan atılamaz.',
  atildi: (kisiId) => `✅ <@${kisiId}> odadan çıkarıldı ve bu odaya giremez.`,
  odadaDegil: (kisiId) => `<@${kisiId}> bu odada değil.`,
  devredildi: (kisiId) => `👑 Odanın yeni sahibi <@${kisiId}>.`,
  sahipAyrildi: (kisiId) => `👑 Sahip ayrıldı; odanın yeni sahibi <@${kisiId}>.`,
  izinYok: 'Bunu yapamıyorum: bot rolünde "Kanalları Yönet", "Rolleri Yönet" ya da "Üyeleri Taşı" izni eksik.',
  kaydedilemedi:
    'Oda kaydedilemedi (data/gecici-odalar.json yazılamadı; dosya başka bir programda açık olabilir). Biraz sonra tekrar deneyin.',
  yeniSurum: 'Geçici odalar şu an değiştirilemiyor: data/gecici-odalar.json daha yeni bir bot sürümüne ait.',
  merkezKaydedildi: (kanalId) => `✅ "Oda aç" kanalı: <#${kanalId}>`,
};

export const bolum = {
  metin: (kanalId, kategoriId, acik) =>
    [
      '### 🔊 Geçici odalar',
      kanalId ? `"Oda aç" kanalı: <#${kanalId}>` : '"Oda aç" kanalı: _seçilmedi_ (aşağıdan seçin)',
      `Kategori: ${kategoriId ? `<#${kategoriId}>` : '"Oda aç" kanalının kategorisi'} • Açık oda: ${acik}`,
      '-# Kişi sınırı, bekleme süresi ve kategori için `/ayar gecici-oda`.',
    ].join('\n'),
  kanalSec: '"Oda aç" ses kanalını seçin',
};

// Konsola yazılanlar (bot sahibine yönelik).
export const konsol = {
  acilamadi: (hata) => `Geçici oda açılamadı: ${hata}. Bot rolünde "Kanalları Yönet" ve "Üyeleri Taşı" izni olmalı.`,
  silinemedi: (kanalId, hata) => `Geçici oda silinemedi (${kanalId}): ${hata}. Bir sonraki açılışta tekrar denenecek.`,
  kayitUymuyor: (kanalId) =>
    `Geçici oda kaydı kanalıyla uyuşmuyor (${kanalId}: tür, kategori ya da açılış zamanı farklı); kayıt silindi, kanala dokunulmadı.`,
  temizlendi: (sayi) => `Geçici odalar: bot kapalıyken boşalan ${sayi} oda silindi.`,
};
