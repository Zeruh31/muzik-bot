// "Seviye" modülünün yazıları: /seviye, sağ tık "Seviyesini göster", seviye duyurusu ve kontrol merkezi bölümü.
// Komut açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Seviye';
export const emoji = '📈';
export const aciklama = 'XP, seviye kartı ve liderlik tablosu';
export const ayarGrubu = 'Seviye ve XP ayarları';

export const komutlar = {
  seviye: 'Seviye ve XP: kartın, liderlik tablosu, yönetici araçları',
  // Sağ tık > Uygulamalar menüsünde görünen ad (en fazla 32 karakter)
  seviyesiniGoster: 'Seviyesini göster',
  alt: {
    rank: 'Seviye kartını gösterir',
    liderlik: 'Sunucunun liderlik tablosu',
    ver: 'Bir kişiye XP verir (yönetici)',
    al: 'Bir kişiden XP alır (yönetici)',
    sifirla: 'Bir kişinin ya da herkesin XP kaydını siler (yönetici)',
    rol: 'Bir seviyeye rol bağlar; rol boşsa bağı kaldırır (yönetici)',
    haric: 'Bir kanalı ya da rolü XP almayanlara ekler/çıkarır (yönetici)',
    roller: 'Seviye rollerini ve XP almayan kanal/rolleri listeler',
  },
  secenekler: {
    kullanici: 'Kimin kartı (boşsa sizin)',
    hedef: 'Kişi',
    sifirlaKullanici: 'Kimin kaydı (boşsa HERKESİN)',
    xp: 'Ne kadar XP',
    sayfa: 'Sayfa (1, 2, 3...)',
    seviye: 'Seviye (1-1000)',
    rol: 'Verilecek rol (boşsa bu seviyenin rolü kaldırılır)',
    kanal: 'XP almayacak (ya da artık alacak) kanal ya da kategori',
    haricRol: 'XP almayacak (ya da artık alacak) rol',
  },
};

// /ayar seviye <ayar> açıklamaları (en fazla 100 karakter)
export const ayarlar = {
  acik: 'XP verilsin mi (varsayılan açık)',
  ses: 'Ses kanalında dakika başına XP verilsin mi (varsayılan açık)',
  duyuru: 'Seviye atlayınca duyuru yapılsın mı (varsayılan açık)',
  'duyuru-kanal': 'Duyuru kanalı (boşsa mesajın yazıldığı kanal)',
  'duyuru-metni': 'Duyuru metni: {kullanıcı}, {ad}, {seviye}, {sunucu}',
  'yalniz-en-yuksek': 'Yalnız en yüksek seviye rolü kalsın (varsayılan kapalı: roller birikir)',
  'ayrilinca-sil': 'Sunucudan ayrılanın XP kaydı silinsin (Server Members Intent gerekir)',
  'kart-renk': 'Seviye kartının vurgu rengi, ör. #5865f2',
};

/** Listeli ayarlar (masaüstü uygulamasında). */
export const listeler = {
  haricKanallar: 'XP almayan kanallar (en fazla 25)',
  haricRoller: 'XP almayan roller (en fazla 25)',
  roller: 'Seviye rolleri (seviyeye ulaşınca verilen roller)',
};

export const varsayilanDuyuru = '🎉 {kullanıcı} **{seviye}**. seviyeye ulaştı!';

export const kart = {
  dosyaAdi: 'seviye.png',
  rankMetni: (kisiId, seviye, xp, sira) =>
    `<@${kisiId}> • Seviye **${seviye}** • ${xp} XP${sira ? ` • Sıra **#${sira}**` : ''}`,
  gorselYok: '-# (Görsel kart şu an çizilemedi.)',
  liderlikBaslik: (sunucu) => `## 🏆 ${sunucu} liderlik tablosu`,
  liderlikSatiri: (sira, kisiId, seviye, xp) =>
    `${['🥇', '🥈', '🥉'][sira - 1] ?? `**${sira}.**`} <@${kisiId}> • Seviye ${seviye} • ${xp} XP`,
  liderlikBos: 'Henüz kimse XP kazanmadı. Mesaj yazarak ya da seste konuşarak XP kazanılır.',
  liderlikAlt: (sayfa, toplamSayfa, kisi) => `-# Sayfa ${sayfa}/${toplamSayfa} • ${kisi} kişi`,
  onceki: 'Önceki',
  sonraki: 'Sonraki',
};

export const cevaplar = {
  botOlmaz: 'Botların seviyesi olmaz.',
  kendineVerme: 'Kendinize XP veremezsiniz (yalnız sunucu sahibi verebilir). Başka bir yöneticiden isteyin.',
  yetkiYok: 'Bunu yalnız "Sunucuyu Yönet" izni olanlar yapabilir.',
  onaySor: {
    ver: (kisiId, xp) => `<@${kisiId}> kişisine **${xp} XP** verilsin mi?`,
    al: (kisiId, xp) => `<@${kisiId}> kişisinden **${xp} XP** alınsın mı?`,
    sifirla: (kisiId) => `<@${kisiId}> kişisinin XP kaydı **silinsin** mi? Bu geri alınamaz.`,
    hepsi: '⚠️ Bu sunucudaki **herkesin** XP kaydı silinsin mi? Bu geri alınamaz.',
  },
  onayla: 'Onayla',
  vazgec: 'Vazgeç',
  vazgecildi: 'Vazgeçildi; hiçbir şey değişmedi.',
  onayEski: 'Bu onayın süresi doldu ya da zaten kullanıldı. Komutu yeniden yazın.',
  verildi: (kisiId, xp, seviye) => `✅ <@${kisiId}> kişisine ${xp} XP verildi. Şimdi seviye **${seviye}**.`,
  alindi: (kisiId, xp, seviye) => `✅ <@${kisiId}> kişisinden ${xp} XP alındı. Şimdi seviye **${seviye}**.`,
  silindi: (kisiId) => `✅ <@${kisiId}> kişisinin XP kaydı silindi.`,
  kayitYok: (kisiId) => `<@${kisiId}> kişisinin XP kaydı yok.`,
  hepsiSilindi: (sayi) =>
    `✅ ${sayi} kişinin XP kaydı silindi. Verilmiş seviye rolleri üyelerde kalır; gerekirse elle alın.`,
  rolBaglandi: (seviye, rolId) =>
    `✅ ${seviye}. seviyeye <@&${rolId}> bağlandı. Kişiler bir sonraki seviye atlamalarında alır.`,
  rolKaldirildi: (seviye) => `✅ ${seviye}. seviyenin rolü kaldırıldı.`,
  rolYoktu: (seviye) => `${seviye}. seviyeye bağlı bir rol yoktu.`,
  rolDolu: (enFazla) => `En fazla ${enFazla} seviye rolü olabilir. Önce birini kaldırın.`,
  haricSec: 'Bir kanal ya da rol seçin.',
  haricDurum: {
    eklendi: (ne) => `🚫 ${ne} artık XP almıyor.`,
    cikarildi: (ne) => `✅ ${ne} yeniden XP alıyor.`,
    dolu: (ne, enFazla) => `${ne} eklenemedi: en fazla ${enFazla} kanal ve ${enFazla} rol olabilir.`,
  },
  rollerBaslik: '## 📈 Seviye ayarları',
  rollerSatiri: (seviye, rolId) => `Seviye ${seviye} → <@&${rolId}>`,
  rollerYok: '_Seviye rolü yok. `/seviye rol seviye:5 rol:@Rol` ile ekleyin._',
  rolModu: (yalnizEnYuksek) => (yalnizEnYuksek ? 'Rol modu: yalnız en yüksek rol kalır' : 'Rol modu: roller birikir'),
  haricKanallar: (liste) => `XP almayan kanallar: ${liste || '_yok_'}`,
  haricRoller: (liste) => `XP almayan roller: ${liste || '_yok_'}`,
  mesgul: 'Şu an çok fazla kart çiziliyor; birkaç saniye sonra tekrar deneyin.',
  saltOkunur:
    'Seviye verileri şu an değiştirilemiyor: data/xp.json daha yeni bir bot sürümüne ait. Bot sahibi botu güncellemeli.',
};

export const bolum = {
  metin: '### 📈 Seviye\nMesaj yazarak (dakikada bir) ve seste konuşarak XP kazanılır. Kartınız ve liderlik tablosu:',
  kart: 'Kartım',
  liderlik: 'Liderlik',
};

export const konsol = {
  rolVerilemedi: (sunucu, rolId, neden) => `Seviye rolü verilemedi (sunucu ${sunucu}, rol ${rolId}): ${neden}`,
  rolIzniYok: (sunucu) => `Seviye rolleri verilemiyor (sunucu ${sunucu}): botun "Rolleri Yönet" izni yok.`,
};
