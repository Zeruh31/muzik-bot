// "Roller ve takım arama" modülünün yazıları: rol panelleri (/ayar rol-menusu), takım arama ilanları
// (/oyun ara), oyun rolleri (/ayar takim-ara) ve kontrol merkezi bölümleri.
// Komut ve ayar açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Roller ve takım arama';
export const emoji = '🎭';
export const aciklama = 'Düğmeli rol menüleri ve "3/4 aranıyor" takım arama ilanları';
export const ayarGrubu = 'Takım arama ilanları';

// /ayar roller-ve-ara <ayar> açıklamaları
export const ayarlar = {
  'ara-sure': 'İlan kaç saat sonra kapansın (1-12, varsayılan 2)',
  'ara-etiket': 'İlan açılınca oyunun rolü etiketlensin',
};

/** Listeli ayarlar (masaüstü uygulamasında; yalnız Discord'dan değişir). */
export const listeler = {
  rolPanelleri: 'Rol panelleri (düğmeyle rol alınan mesajlar)',
  oyunRolleri: 'Takım arama ilanlarında etiketlenen oyun rolleri',
};

export const komutlar = {
  ara: 'Takım arkadaşı arar: "3/4 aranıyor" ilanı, Katıl ve Ayrıl düğmeleri',
  secenekler: {
    oyun: 'Hangi oyun (ör. PUBG, LoL, Valorant)',
    kisi: 'Takımda toplam kaç kişi olacak (siz dahil, 2-16)',
    not: 'Kısa not (ör. "rank, mikrofon şart")',
  },
  rolMenusu: {
    grup: 'Rol panelleri',
    olustur: 'Yeni rol paneli kurar (en fazla 25 rol)',
    ekle: 'Bir panele rol ekler',
    cikar: 'Bir panelden rol çıkarır',
    sil: 'Bir paneli siler',
    liste: 'Rol panellerini listeler',
    secenekler: {
      kanal: 'Panelin gönderileceği metin kanalı',
      baslik: 'Panelin başlığı',
      rol: (n) => (n ? `${n}. rol` : 'Rol'),
      stil: 'Düğmeler ya da seçme menüsü',
      coklu: 'Birden çok rol seçilebilsin (varsayılan evet)',
      panel: 'Hangi panel',
      emoji: 'Düğmedeki emoji',
    },
    stiller: { dugme: 'Düğmeler', menu: 'Seçme menüsü' },
  },
  takimAra: {
    grup: 'Takım arama oyun rolleri',
    oyunRolu: 'Oyunun ilanda etiketlenecek rolü (rol boşsa kaldırır)',
    liste: 'Oyun rollerini listeler',
    secenekler: {
      oyun: 'Oyunun adı (ör. PUBG)',
      rol: 'Etiketlenecek rol',
    },
  },
};

export const panel = {
  baslik: (metin) => `## ${metin}`,
  satir: (emoji, rolId) => `${emoji ? `${emoji} ` : '• '}<@&${rolId}>`,
  bos: '_Henüz rol yok. `/ayar rol-menusu ekle` ile ekleyin._',
  ipucuCoklu: '-# Bir role basınca alırsınız, yeniden basınca bırakırsınız.',
  ipucuTek: '-# Yalnız bir rol seçilebilir; yenisini seçince eskisi bırakılır.',
  menuYer: 'Rol seçin',
};

export const ilan = {
  baslik: (oyun, katilan, kisi) => `## 🎮 ${oyun} • ${katilan}/${kisi} aranıyor`,
  dolu: (oyun, kisi) => `## ✅ ${oyun} • ${kisi}/${kisi} takım tamam`,
  kapandi: (oyun) => `## ⌛ ${oyun} • ilan kapandı`,
  not: (metin) => `> ${metin}`,
  katilanlar: (liste) => `Katılanlar: ${liste}`,
  kapanis: (saniye) => `Kapanış: <t:${saniye}:R>`,
  sahip: (kisiId) => `-# İlanı açan: <@${kisiId}>`,
  rol: (rolId) => `<@&${rolId}>`,
  katil: 'Katıl',
  ayril: 'Ayrıl',
  kapat: 'Kapat',
  tamamDuyuru: (liste, oyun) => `✅ **${oyun}** takımı tamam: ${liste}. İyi oyunlar!`,
};

export const form = {
  araBaslik: 'Takım ara',
  oyun: 'Oyun',
  kisi: 'Takımda toplam kaç kişi (2-16)',
  not: 'Not (isteğe bağlı)',
  panelBaslik: 'Yeni rol paneli',
  panelAdi: 'Başlık',
  panelKanal: 'Kanal',
  panelRoller: 'Roller (en fazla 25)',
  panelStil: 'Görünüm',
  stiller: {
    'dugme-cok': 'Düğmeler, birden çok rol',
    'dugme-tek': 'Düğmeler, tek rol',
    'menu-cok': 'Seçme menüsü, birden çok rol',
    'menu-tek': 'Seçme menüsü, tek rol',
  },
};

export const cevaplar = {
  yoneticiGerekli: 'Rol panellerini ve oyun rollerini yalnız "Sunucuyu Yönet" izni olanlar değiştirebilir.',
  panelYok: 'Bu rol paneli artık yok.',
  panelBulunamadi:
    'Bu adla bir rol paneli bulunamadı. Panel adını yazarken çıkan öneriden seçin ya da /ayar rol-menusu liste ile bakın.',
  panelCokluEslesme: 'Birden çok panel bulundu, listeden seçin.',
  panelDolu: (n) => `Bir panelde en fazla ${n} rol olabilir.`,
  panelSiniri: (n) => `Bir sunucuda en fazla ${n} rol paneli olabilir.`,
  rolZatenVar: (rolId) => `<@&${rolId}> bu panelde zaten var.`,
  rolPanelde: (rolId) => `<@&${rolId}> bu panelde yok.`,
  emojiGecersiz: 'Emoji tek bir emoji ya da bu sunucunun özel emojisi olmalı.',
  kuruldu: (kanalId, sayi) => `✅ Rol paneli <#${kanalId}> kanalına kuruldu (${sayi} rol).`,
  eklendiPanele: (rolId) => `✅ <@&${rolId}> panele eklendi.`,
  cikarildiPanelden: (rolId) => `✅ <@&${rolId}> panelden çıkarıldı.`,
  silindi: '✅ Rol paneli silindi.',
  panelListesi: (satirlar) => (satirlar.length ? satirlar.join('\n') : 'Bu sunucuda rol paneli yok.'),
  panelSatiri: (baslik, kanalId, sayi) => `• **${baslik}** <#${kanalId}> (${sayi} rol)`,
  gonderilemedi: (kanalId) =>
    `<#${kanalId}> kanalına panel gönderemedim. Orada "Kanalı Görüntüle", "Mesaj Gönder" ve "Mesaj Geçmişini Oku" iznim olmalı.`,
  // Rol denetimi
  rolHerkes: '@everyone rolü seçilemez.',
  rolYonetilen: (rolId) => `<@&${rolId}> bir bota ya da sunucu takviyesine ait; elle verilemez.`,
  rolBotAltinda: (rolId) =>
    `<@&${rolId}> rolünü veremem: rolüm ondan aşağıda. Sunucu Ayarları > Roller'de bot rolünü bu rolün üstüne sürükleyin.`,
  rolSiziAsiyor: (rolId) =>
    `<@&${rolId}> sizin en yüksek rolünüzle aynı ya da daha yüksek; bu rolü panele koyamazsınız.`,
  yenidenKur: (baslik, kanalId) =>
    `⚠️ **${baslik}** (<#${kanalId}>) eski bir panel: rolleri kimin koyduğu bilinmiyor. Yeniden kurun (\`/ayar rol-menusu sil\` ve \`olustur\`).`,
  verilmiyor: (baslik, rolId, neden) => `⚠️ **${baslik}**: <@&${rolId}> verilmiyor (${neden}).`,
  botRolVeremez: 'Rol veremiyorum: bot rolünde "Rolleri Yönet" izni yok.',
  // Rol tıklama
  rolDegisti: (eklenen, kaldirilan, atlanan = [], eski = false) =>
    [
      eski ? '⚠️ Bu panel eski: rol verilemiyor. Bir yönetici `/ayar rol-menusu` ile paneli yeniden kursun.' : null,
      eklenen.length ? `✅ Verildi: ${eklenen.map((id) => `<@&${id}>`).join(', ')}` : null,
      kaldirilan.length ? `➖ Bırakıldı: ${kaldirilan.map((id) => `<@&${id}>`).join(', ')}` : null,
      ...atlanan.map(({ rolId, neden }) => `⚠️ <@&${rolId}> verilemedi: ${neden}. Bir yöneticiye haber verin.`),
    ]
      .filter(Boolean)
      .join('\n') || 'Rolleriniz değişmedi.',
  // Takım arama
  ilanYok: 'Bu ilan kapandı.',
  zatenKatildin: 'Bu ilana zaten katıldınız.',
  ilanDolu: 'Bu takım doldu.',
  katildin: (oyun) => `✅ **${oyun}** ilanına katıldınız.`,
  katilmadin: 'Bu ilana katılmamıştınız.',
  sahipAyrilamaz: 'İlanı siz açtınız; kapatmak için **Kapat** düğmesine basın.',
  ayrildin: 'İlandan ayrıldınız.',
  kapatmaYetkisi: 'İlanı yalnız açan kişi ya da "Sunucuyu Yönet" izni olanlar kapatabilir.',
  kapatildi: 'İlan kapatıldı.',
  zatenIlanVar: 'Açık bir ilanınız zaten var. Yenisi için önce onu kapatın.',
  acmaBeklemesi: (dakika) => `Yeni ilan açmak için ${dakika} dakika bekleyin.`,
  oyunGecersiz: 'Oyun adı 1-50 karakter olmalı.',
  kisiGecersiz: 'Kişi sayısı 2 ile 16 arasında olmalı.',
  oyunRoluKaydedildi: (oyun, rolId) => `✅ **${oyun}** ilanlarında <@&${rolId}> etiketlenecek.`,
  oyunRoluEtiketlenemez: (rolId) =>
    `⚠️ <@&${rolId}> etiketlenebilir değil; bot rolünde "@everyone, @here ve Tüm Rollerden Bahset" izni yoksa ` +
    'ping gitmez. Sunucu Ayarları > Roller > rol > "Herkesin bu rolden bahsetmesine izin ver" seçeneğini açın.',
  oyunRoluKaldirildi: (oyun) => `✅ **${oyun}** için rol eşleşmesi kaldırıldı.`,
  oyunRolleriListesi: (satirlar) => (satirlar.length ? satirlar.join('\n') : 'Henüz oyun rolü yok.'),
  oyunRoluSatiri: (oyun, rolId) => `• **${oyun}** → <@&${rolId}>`,
  oyunRoluSiniri: (n) => `En fazla ${n} oyun rolü tanımlanabilir.`,
  kaydedilemedi:
    'Kaydedilemedi (data/roller-ve-ara.json yazılamadı; dosya başka bir programda açık olabilir). Biraz sonra tekrar deneyin.',
  yeniSurum: 'Rol panelleri şu an değiştirilemiyor: data/roller-ve-ara.json daha yeni bir bot sürümüne ait.',
};

export const bolum = {
  ara: '### 🎮 Takım ara\n"3/4 aranıyor" ilanı açar; dolunca ya da süre bitince kapanır. Komutla: `/oyun ara`.',
  araDugme: 'Takım ara',
  roller: (satirlar) =>
    [
      '### 🎭 Rol menüleri',
      ...(satirlar.length ? satirlar : ['_Henüz panel yok._']),
      '-# Rol eklemek, çıkarmak, silmek için `/ayar rol-menusu`; oyun rolleri için `/ayar takim-ara`.',
    ].join('\n'),
  yeniPanel: 'Yeni rol paneli',
};
