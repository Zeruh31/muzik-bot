// Kontrol merkezinin (/menu, kalıcı panel, sağ tık menüsü) yazıları.
// Komut açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".

export const baslik = 'Kontrol merkezi';
export const emoji = '🎛️';
export const ayarGrubu = 'Kontrol merkezi ve kalıcı panel ayarları';

export const komutlar = {
  menu: 'Kontrol merkezini açar (yalnız siz görürsünüz): müzik, listeler, ayarlar',
  // Sağ tık > Uygulamalar menüsünde görünen ad (en fazla 32 karakter)
  kullaniciMenusu: 'Bot menüsünü aç',
};

// /ayar menu <ayar> açıklamaları
export const ayarlar = {
  'panel-aralik': 'Kalıcı panel en sık kaç saniyede bir güncellensin (3-60, varsayılan 5)',
};

export const merkez = {
  baslik: '## 🎛️ Kontrol Merkezi',
  panelBasligi: '## 🎛️ Kontrol Merkezi',
  bolumSec: 'Bir bölüm seçin',
  bosMenu: 'Bu sunucuda gösterilecek bir bölüm yok.',
  menuyuAc: 'Menüyü aç',
  panelAltBilgi: '-# Düğmeleri kullanmak için botla aynı ses kanalında olun. Ayarlar ve listeler için **Menüyü aç**.',
  hedefKisi: (kullaniciId) => `-# <@${kullaniciId}> için açıldı.`,
};

export const panel = {
  kuruldu: (kanalId) =>
    `🎛️ Kontrol Merkezi <#${kanalId}> kanalına kuruldu. Bot yeniden başlasa da aynı mesajı günceller.`,
  kaldirildi: '🎛️ Kalıcı panel kaldırıldı.',
  gonderilemedi: (kanalId) =>
    `<#${kanalId}> kanalına panel gönderemedim. Kanalda "Kanalı Görüntüle", "Mesaj Gönder" ve "Mesaj Geçmişini Oku" iznim olmalı.`,
};
