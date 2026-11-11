// Özellik altyapısının (yönlendirici, intent'ler, zamanlayıcı) Discord'da ve konsolda yazdığı ortak mesajlar.
// Her modülün kendi yazıları kendi klasöründeki mesajlar.js dosyasındadır.
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const ortak = {
  ozellikKapali: (ozellik, intentler) =>
    `"${ozellik}" özelliği kapalı: Discord bu bot için ${intentler} iznini (intent) vermedi. ` +
    'Bot sahibi Developer Portal > Bot > Privileged Gateway Intents bölümünde bunu açıp botu yeniden başlatmalı (README, 3. adım).',
  eskiDugme: 'Bu düğme artık geçerli değil. `/menu` ile yeni bir menü açın.',
  sunucudaKullan: 'Bu yalnızca bir sunucuda kullanılabilir.',
  // Yasaklı izni olan rol: `kim` cümlenin başı ("<@&1> rolünde", "Rolde"), `izinler` Discord'daki Türkçe adlar.
  rolTehlikeli: (kim, izinler) =>
    `${kim} ${izinler.map((ad) => `'${ad}'`).join(', ')} ${izinler.length === 1 ? 'izni' : 'izinleri'} var; ` +
    `${izinler.length === 1 ? 'bu izin' : 'bu izinler'} rol menüsü/otomatik rol/seviye rolü için kullanılamaz. ` +
    `Sunucu Ayarları > Roller'den ${izinler.length === 1 ? 'bu izni' : 'bu izinleri'} kapatın.`,
};

// Yasaklı rol izinlerinin Discord istemcisindeki Türkçe adları (anahtar: PermissionFlagsBits adı).
export const izinAdlari = Object.freeze({
  Administrator: 'Yönetici',
  ManageGuild: 'Sunucuyu Yönet',
  ManageRoles: 'Rolleri Yönet',
  BanMembers: 'Üyeleri Yasakla',
  KickMembers: 'Üyeleri At',
  ManageChannels: 'Kanalları Yönet',
  ManageMessages: 'Mesajları Yönet',
  ManageWebhooks: "Webhook'ları Yönet",
  ModerateMembers: 'Üyelere Zaman Aşımı Uygula',
  MentionEveryone: 'Herkesten Bahset',
  ManageNicknames: 'Takma Adları Yönet',
  ManageGuildExpressions: 'İfadeleri Yönet',
  ManageEvents: 'Etkinlikleri Yönet',
  ViewAuditLog: 'Denetim Kaydını Görüntüle',
  MuteMembers: 'Üyeleri Sustur',
  DeafenMembers: 'Üyeleri Sağırlaştır',
  MoveMembers: 'Üyeleri Taşı',
  ManageThreads: 'Konuları Yönet',
});

// Birkaç modülün alt komutlarını toplayan üst komutların açıklamaları (en fazla 100 karakter).
// Bir modül komutuna `ust: 'oyun'` yazınca komut /oyun altına girer; değiştirince "npm run deploy-commands".
export const ustKomutlar = {
  oyun: 'Oyun araçları: takım kur, takım ara, zar at, seç, yazı tura, anket ve çekiliş',
};

// Kontrol merkezinde birkaç modülün bölümlerini tek başlıkta toplayan kategoriler (modülde menu.kategori).
export const menuKategorileri = {
  oyun: { baslik: 'Oyun', emoji: '🎲', aciklama: 'Takım, takım arama, zar, anket ve çekiliş' },
  bildirimler: { baslik: 'Bildirimler', emoji: '🔔', aciklama: 'Ücretsiz oyun duyuruları (yöneticiler için)' },
  ayarlar: { baslik: 'Ayarlar', emoji: '⚙️', aciklama: 'Sunucu ayarları, geçici odalar, rol menüleri ve kayıt' },
};

// Konsola yazılanlar (bot sahibine yönelik).
export const konsol = {
  intentReddedildi: (intentler, ozellikler) =>
    `Discord ayrıcalıklı intent'leri reddetti (${intentler}). Developer Portal > Bot > Privileged Gateway Intents ` +
    `bölümünde açın. Şimdilik bunlar olmadan bağlanılıyor; kapalı özellikler: ${ozellikler}.`,
};
