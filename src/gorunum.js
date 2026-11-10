// =====================================================================
//  GÖRÜNÜM AYARLARI
//  Botun renkleri, durum yazısı ve şarkı seçme listesinin ayarları
//  burada. İstediğin değeri değiştir, kaydet, botu yeniden başlat.
//  Yazıların kendisi src/mesajlar.js dosyasında; "/help" altındaki
//  bağlantılar .env dosyasında (BRAND_* ayarları).
// =====================================================================

// --- Renkler -----------------------------------------------------------
// Mesaj kutularının ana rengi .env dosyasındaki EMBED_COLOR ayarıdır.
// Hata mesajlarının rengi burada. Renk kodunun başında 0x olmalı: 0x + 6 hane.
export const renkler = {
  hata: 0xed4245, // kırmızı
};

// --- /help altındaki bağlantılar ---------------------------------------
// Bunlar .env dosyasından okunur (Ayarlar > Görünüm, masaüstü uygulamasında):
//   BRAND_SUPPORT_URL  destek sunucusu davet bağlantısı (ör. https://discord.com/invite/...)
//   BRAND_AUTHOR_NAME  botu yapanın adı
//   BRAND_AUTHOR_URL   yapanın bağlantısı (web sitesi, sosyal medya)
// Boş bırakılan bağlantı /help'te hiç gösterilmez.

// --- Botun durumu (isminin altında görünen yazı) -----------------------
// tur şunlardan biri olabilir: 'Dinliyor', 'Oynuyor', 'İzliyor', 'Yarışıyor'
// Discord bazen durumu siler; bot bu yüzden her yenilemeSaniye saniyede bir yeniden ayarlar.
export const durum = {
  tur: 'Dinliyor',
  metin: '/help',
  yenilemeSaniye: 100,
};

// --- /play ile şarkı adı yazılınca çıkan seçim listesi -------------------
// Listeyi tamamen kapatmak için .env dosyasında PLAY_SHOW_CHOICES=false yap.
export const secim = {
  playSonucSayisi: 5, // /play listesinde kaç sonuç gösterilsin (en fazla 5: her sonuç bir düğme)
  searchSonucSayisi: 10, // /search listesinde kaç sonuç gösterilsin (en fazla 25)
  sureSaniye: 60, // seçim için kaç saniye beklensin
};
