// Etkileşimli /help'in kategori yazıları. Komut açıklamaları komutların kendisinden gelir.

export const baslik = 'Yardım';
export const emoji = '❓';

export const kategoriler = {
  muzik: { ad: 'Müzik', emoji: '🎵', aciklama: 'Şarkı çalma, kuyruk ve listeler' },
  oyun: { ad: 'Oyun', emoji: '🎲', aciklama: 'Takım kurma, zar, seçim, anket ve çekiliş' },
  seviye: { ad: 'Seviye', emoji: '📈', aciklama: 'XP, seviye kartı ve liderlik tablosu' },
  genel: { ad: 'Genel', emoji: '📌', aciklama: 'Kontrol merkezi, davet, istatistikler' },
  ayarlar: { ad: 'Ayarlar', emoji: '⚙️', aciklama: 'Sunucu ayarları (yöneticiler için)' },
};

export const yardim = {
  kategoriSec: 'Bir kategori seçin',
  kategoriBasligi: (emoji, ad) => `${emoji} ${ad} komutları`,
  sagTik: (ad) => `Sağ tık > Uygulamalar > **${ad}**`,
  menuIpucu: 'Komutları ezberlemek istemezseniz `/menu` her şeyi düğmelerle açar.',
  bilinmeyenKategori: 'Bu kategori artık yok; `/help` ile yeniden açın.',
};
