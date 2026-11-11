// "Ücretsiz oyunlar" modülünün yazıları: duyuru kartı, /ayar ucretsiz-oyunlar açıklamaları ve kontrol
// merkezindeki "Bildirimler" bölümü. ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Ücretsiz oyunlar';
export const emoji = '🎁';
export const aciklama = 'Epic, Steam ve GOG ücretsiz oyun duyuruları';
export const ayarGrubu = 'Ücretsiz oyun duyuruları (Epic, Steam, GOG)';

// /ayar ucretsiz-oyunlar <ayar> açıklamaları (en fazla 100 karakter)
export const ayarlar = {
  kanal: 'Ücretsiz oyunların duyurulacağı metin kanalı (boşsa duyuru yapılmaz)',
  rol: 'Duyuruda etiketlenecek rol (isteğe bağlı; rol etiketlenebilir olmalı)',
  epic: 'Epic Games Store oyunları duyurulsun (varsayılan açık)',
  steam: 'Steam oyunları duyurulsun (varsayılan açık)',
  gog: 'GOG oyunları duyurulsun (varsayılan açık)',
};

export const platformlar = {
  epic: { ad: 'Epic Games Store', emoji: '🟦', renk: 0x313131 },
  steam: { ad: 'Steam', emoji: '🟪', renk: 0x1b2838 },
  gog: { ad: 'GOG', emoji: '🟣', renk: 0x86328a },
};

export const kart = {
  baslik: (oyun) => `## 🎁 Ücretsiz: ${oyun}`,
  platform: (emoji, ad, deger) => `${emoji} **${ad}**${deger ? ` • normalde ${deger}` : ''} • kalıcı olarak sizin`,
  bitis: (saniye) => `⏳ Son gün: <t:${saniye}:R> (<t:${saniye}:f>)`,
  bitisYok: '⏳ Bitiş tarihi belirtilmemiş; erken alın.',
  kaynak: (kaynak) => `-# Kaynak: ${kaynak}`,
  magaza: 'Mağazada aç',
};

export const bolum = {
  baslik: '### 🎁 Ücretsiz oyun duyuruları',
  kanal: (kanalId) => (kanalId ? `Kanal: <#${kanalId}>` : 'Kanal: ayarlanmadı (`/ayar ucretsiz-oyunlar kanal`)'),
  rol: (rolId) => `Etiketlenen rol: ${rolId ? `<@&${rolId}>` : 'yok'}`,
  platformlar: (liste) => `Platformlar: ${liste || 'hiçbiri'}`,
  sonKontrol: (saniye) => (saniye ? `Son kontrol: <t:${saniye}:R>` : 'Son kontrol: henüz yok'),
  ipucu: '-# Birkaç saatte bir kendiliğinden bakılır. Ayarlar: `/ayar ucretsiz-oyunlar ...`',
  kontrol: 'Şimdi kontrol et',
};

export const cevaplar = {
  yetkiYok: 'Bunun için "Sunucuyu Yönet" izni gerekli.',
  kanalYok: 'Önce bir duyuru kanalı ayarlayın: `/ayar ucretsiz-oyunlar kanal deger:#kanal`.',
  bekle: (saniye) => `Az önce kontrol edildi; tekrar denemek için <t:${saniye}:R> bekleyin.`,
  bitti: (sayi, hatali) =>
    `🎁 Kontrol bitti: ${sayi} yeni oyun duyuruldu.${hatali.length ? ` Şu kaynaklara ulaşılamadı: ${hatali.join(', ')} (sonra yeniden denenecek).` : ''}`,
};
