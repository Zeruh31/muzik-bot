// Kontrol merkezindeki "Müzik" bölümünün yazıları (/menu ve kalıcı panel).
// Komutların kendi yazıları src/mesajlar.js > komutlar bölümünde kalır.

export const baslik = 'Müzik';
export const emoji = '🎵';
export const aciklama = 'Çalan şarkı, kontroller, kuyruk, listeler ve geçmiş';

export const bolum = {
  simdiCaliyor: '### 🎵 Şimdi çalıyor',
  calanYok: '### 🎵 Şu anda bir şey çalmıyor\n**Şarkı ekle** ile başlatın ya da `/play` yazın.',
  isteyen: (kim) => `İsteyen: ${kim}`,
  bitis: (zaman) => `bitiş ${zaman}`,
  duraklatildi: '⏸️ Duraklatıldı',
  siradakiler: (sayi) => `**Sırada ${sayi} şarkı**`,
  siraBos: '_Kuyrukta bekleyen şarkı yok._',
  dahaFazla: (sayi) => `… ve ${sayi} şarkı daha`,
};

export const dugmeler = {
  ekle: 'Şarkı ekle',
  kuyruk: 'Kuyruk',
  listeler: 'Listeler',
  gecmis: 'Geçmiş',
};

export const form = {
  baslik: 'Şarkı ekle',
  alan: 'Şarkı adı ya da bağlantı',
  ipucu: 'YouTube, Spotify bağlantısı ya da şarkı adı',
};

export const secimler = {
  listeYazisi: 'Çalınacak listeyi seçin',
  listeBos: 'Bu sunucuda kayıtlı liste yok. `/muzik liste kaydet` ile oluşturabilirsiniz.',
  listeSatiri: (sayi) => `${sayi} şarkı`,
  gecmisYazisi: 'Yeniden eklenecek şarkıyı seçin',
  gecmisBos: 'Bu sunucuda henüz çalınmış bir şarkı yok.',
  gecmisDegisti: 'Geçmiş bu arada değişti; listeyi yeniden açın.',
};
