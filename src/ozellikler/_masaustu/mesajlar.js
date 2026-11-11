// Masaüstü uygulamasının ayar isteklerine verilen yanıtların yazıları ve ayar kategorileri.
// Ayarların kendi açıklamaları her modülün mesajlar.js dosyasında (ayarlar ve listeler bölümleri).

/** Uygulamadaki kategori sırası; modül -> kategori eşlemesi aşağıda. */
export const kategoriler = ['Müzik', 'Oyun', 'Seviye', 'Karşılama', 'Kayıt', 'Odalar', 'Bildirimler', 'Diğer'];

/** Hangi modülün ayarları hangi kategoride görünür; listede olmayan modül "Diğer"e düşer. */
export const modulKategorisi = {
  ayarlar: 'Müzik',
  menu: 'Müzik',
  'roller-ve-ara': 'Oyun',
  seviye: 'Seviye',
  karsilama: 'Karşılama',
  kayit: 'Kayıt',
  'gecici-oda': 'Odalar',
  'ucretsiz-oyunlar': 'Bildirimler',
};

export const hatalar = {
  bozukDosya: 'İstek dosyası okunamadı (bozuk JSON).',
  buyukDosya: (kb) => `İstek dosyası çok büyük (en fazla ${kb} KB).`,
  bicim: (neden) => `İstek geçersiz: ${neden}.`,
  baglanti: 'İstek dosyası bir kısayol ya da sembolik bağlantı; işlenmedi.',
  eski: 'İstek çok eski (bot o sırada kapalıydı); uygulanmadı. Ayarı yeniden kaydedin.',
  sunucuYok: 'Bot bu sunucuda değil.',
  modulYok: 'Bilinmeyen modül.',
  ayarYok: 'Bilinmeyen ayar.',
  yalnizDiscord: (komut) => `Bu ayar uygulamadan değiştirilemez; Discord'da ${komut} ile yapın.`,
  kanalYok: 'Seçilen kanal bu sunucuda bulunamadı.',
  rolYok: 'Seçilen rol bu sunucuda bulunamadı.',
  deger: 'Değer bu ayarın türüne uymuyor.',
  liste: (enFazla) => `Liste en fazla ${enFazla} kimlik içerebilir.`,
  sahipBilinmiyor:
    "Rol ayarları bot sahibi adına kaydedilir, ama bot sahibi öğrenilemedi. Bu ayarı Discord'da /ayar ile yapın.",
  sahipUyeDegil:
    "Rol ayarları bot sahibi adına kaydedilir; bot sahibi bu sunucunun üyesi değil. Bu ayarı Discord'da /ayar ile yapın.",
  sahipYetkisiz:
    'Rol ayarları bot sahibi adına kaydedilir; bot sahibinin bu sunucuda "Sunucuyu Yönet" izni yok. İzni verin ya da ayarı Discord\'da /ayar ile yapın.',
  beklenmeyen: 'Ayar uygulanamadı (beklenmeyen hata, bot kayıtlarına bakın).',
};

export const konsol = {
  uygulandi: (sunucu, ayar) => `Masaüstünden ayar değişti: ${ayar} (sunucu ${sunucu})`,
  reddedildi: (sunucu, ayar, neden) => `Masaüstü ayar isteği reddedildi: ${ayar} (sunucu ${sunucu}): ${neden}`,
  yazilamadi: (dosya, neden) => `Masaüstü dosyası yazılamadı (${dosya}): ${neden}`,
  birikti: (sayi, sinir) =>
    `data/istekler içinde ${sinir} istekten fazlası birikti; en eski ${sayi} istek okunmadan silindi.`,
  silinemedi: (dosya, neden) => `Masaüstü dosyası silinemedi (${dosya}): ${neden}`,
  izlenemiyor: (neden) => `data/istekler izlenemiyor (${neden}); yalnız yoklama ile bakılacak.`,
};
