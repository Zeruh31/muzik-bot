// =====================================================================
//  BOTUN DISCORD'DA YAZDIĞI BÜTÜN MESAJLAR
//
//  Bir yazıyı değiştirmek için tırnak içindeki metni değiştir, kaydet ve
//  botu yeniden başlat. Komut açıklamalarını değiştirdiysen bir kez
//  "npm run deploy-commands" çalıştır ki Discord'daki liste de güncellensin.
//
//  Kurallar:
//   - ${...} ile yazılmış yerler bot tarafından doldurulur (şarkı adı, sayı vb.).
//     Onları silme ya da adlarını değiştirme; yerlerini değiştirebilirsin.
//   - **kalın**, _eğik_, `kod` Discord biçimleridir.
//   - Komut açıklamaları (aciklama ve secenekler) en fazla 100 karakter olabilir.
//   - Web panelinin sayfa yazıları (HTML) src/panel/public klasöründe; panelin hata mesajları
//     burada (panel bölümü). Konsol yazıları bot sahibine yöneliktir, kendi dosyalarında kalır.
// =====================================================================

// --- Her yerde kullanılan ortak mesajlar --------------------------------
export const genel = {
  yetkiYok: 'Bu komutu kullanma yetkin yok.',
  djGerekli: (rolId) => `Bu komutu kullanma yetkin yok. Bu sunucuda bunun için <@&${rolId}> rolü gerekiyor.`,
  komutYok: 'Bu komut artık yok. Komut listesi güncelleniyor olabilir, biraz sonra deneyin.',
  beklenmeyenHata: 'Beklenmeyen bir hata oluştu. Bot sahibi konsol kayıtlarına bakabilir.',
};

// --- Kısa etiketler (tablolarda ve listelerde görünen kelimeler) ---------
export const etiketler = {
  tekrar: { off: 'Kapalı', track: '🔂 Şarkı', queue: '🔁 Kuyruk' },
  bas: { none: 'Kapalı', low: 'Düşük', medium: 'Orta', high: 'Yüksek' },
  sure: 'Süre',
  isteyen: 'İsteyen',
  sesKanali: 'Ses kanalı',
  sunucu: 'Sunucu',
  bilinmiyor: 'Bilinmiyor',
  canli: '🔴 Canlı',
  canliCubuk: '🔴 CANLI', // ilerleme çubuğunun yerine, süresi olmayan yayınlarda
  zamanBirimleri: { gun: 'gün', saat: 'saat', dakika: 'dakika' }, // /stats çalışma süresi
  bilinmeyenParca: 'Bilinmeyen parça',
  bilinmeyenSanatci: 'Bilinmeyen sanatçı',
};

// --- Ses kanalı kontrolleri ----------------------------------------------
export const ses = {
  kanalaKatil: 'Önce bir ses kanalına katılmalısınız.',
  ayniKanal: (kanalId) => `Bu komutu kullanmak için <#${kanalId}> kanalında olmalısınız.`,
  izinEksik: (kanal, eksikler) => `${kanal} kanalında şu iznim eksik: ${eksikler}.`,
  izinAdlari: { gor: 'Kanalı Görüntüle', baglan: 'Bağlan', konus: 'Konuş' },
  kanalDolu: 'Ses kanalı dolu, katılamıyorum.',
};

// --- Müzik işlemlerinin hata mesajları ----------------------------------
export const muzik = {
  lavalinkYok: 'Müzik sunucusuna (Lavalink) bağlanılamıyor. Lavalink açık mı? (`npm run lavalink`)',
  yenidenBaglaniyor:
    'Müzik sunucusu yeniden bağlanıyor; birkaç saniye sonra tekrar deneyin. (Durdurmak için /stop her zaman çalışır.)',
  calmiyor: 'Şu anda bu sunucuda müzik çalmıyor.',
  calanYok: 'Şu anda çalan bir şarkı yok.',
  bosSorgu: 'Bir şarkı adı ya da bağlantı yazmalısınız.',
  sonucYok: 'Hiçbir sonuç bulunamadı.',
  eklenecekYok: 'Eklenecek parça yok.',
  kuyrukDolu: (enFazla) => `Kuyruk dolu (en fazla ${enFazla} parça).`,
  kuyrukBos: 'Kuyruk boş.',
  kuyrukZatenBos: 'Kuyruk zaten boş.',
  siraAraligi: (enFazla) => `Sıra numarası 1 ile ${enFazla} arasında olmalı.`,
  zatenOSirada: 'Parça zaten o sırada.',
  zatenDuraklatilmis: 'Müzik zaten duraklatılmış.',
  zatenCaliyor: 'Müzik zaten çalıyor.',
  tekrarModuGecersiz: 'Geçersiz tekrar modu.',
  karistirmakIcinAz: 'Karıştırmak için kuyrukta en az 2 parça olmalı.',
  sarilamaz: 'Bu parçada ileri/geri sarılamaz (canlı yayın olabilir).',
  zamanDisinda: 'Bu zaman parçanın süresinin dışında.',
  sesAraligi: (en, enFazla) => `Ses seviyesi ${en} ile ${enFazla} arasında olmalı.`,
  basGecersiz: 'Geçersiz bas seviyesi.',
  sozEklentisiYok: "Şarkı sözü eklentisi (LavaLyrics) Lavalink'te yüklü değil.",
  sozBulunamadi: (sarki) => `"${sarki}" için şarkı sözü bulunamadı.`,
  spotifyKapali:
    "Spotify desteği kapalı: bot sahibinin .env'de Spotify anahtarlarını girmesi gerekiyor (README > Spotify). Anahtarlar girildikten sonra Lavalink yeniden başlatılmalı.",
  spotifyBulunamadi:
    'Bu Spotify bağlantısı bulunamadı. Bağlantıyı kontrol edin (şarkı, albüm ya da çalma listesi olmalı).',
  kaynakKapali: (kaynak) => `Bu kaynak (${kaynak}) müzik sunucusunda kapalı.`,
  baglantiyaIzinYok: 'Bu bağlantıya izin verilmiyor.',
  sunucuIsleyemedi: 'Müzik sunucusu isteği işleyemedi. Biraz sonra tekrar deneyin.',
  kaynakDesteklenmiyor: (kaynak) =>
    `Bu kaynak (${kaynak}) şimdilik desteklenmiyor; YouTube ve Spotify bağlantıları ya da şarkı adı deneyin.`,
  youtubeEslesmesiYok: "Bu parçanın YouTube'da karşılığı bulunamadı.",
  sesBaglanamadi: 'Ses kanalına bağlanılamadı. Birkaç saniye sonra tekrar deneyin.',
  ffmpegYok: 'ffmpeg bulunamadı; bot sahibinin ffmpeg kurması gerekiyor (README > Gerekenler).',
  kaynakKesildi: 'Ses akışı beklenmedik biçimde kesildi.',
};

// --- Bir parça yüklenemeyince ya da çalınamayınca ------------------------
export const yuklemeHatasi = {
  youtubeVermiyor:
    "YouTube şu an bu parçayı vermiyor. Bot sahibinin Lavalink'i ve YouTube eklentisini güncellemesi gerekiyor (README > Sık karşılaşılan hatalar).",
  yasKisitlamali: 'Bu video yaş kısıtlamalı ve çalınamıyor.',
  oturumGerekli:
    'YouTube bu parçayı çalmak için oturum açılmasını istiyor. Bot sahibinin YouTube OAuth girişini yapması gerekiyor (README > YouTube girişi).',
  ozelVideo: 'Bu video özel (gizli), çalınamıyor.',
  kullanilamiyor: 'Bu içerik kullanılamıyor (silinmiş ya da bölgenizde engelli olabilir).',
  genel: 'Parça yüklenemedi. Başka bir bağlantı ya da arama deneyin.',
  takildi: 'Parça takıldı, sıradakine geçiliyor.',
  listedenBaskasiniSec: 'Başka bir sonuç denemek için komutu yeniden yazıp listeden başka bir şarkı seçebilirsin.',
};

// --- Botun kendiliğinden kanala yazdığı mesajlar --------------------------
export const duyurular = {
  simdiCaliyor: '🎶 Şimdi çalıyor',
  youtubeKaynagi: (baglanti) => `▶️ YouTube'dan çalınan: ${baglanti}`,
  kuyrukBitti: '✅ Kuyruk bitti.',
  ayrilacagim: (saniye) => ` ${saniye} saniye içinde yeni şarkı eklenmezse kanaldan ayrılacağım.`,
  bosKanaldanAyrildim: '👋 Ses kanalında kimse kalmadığı için ayrıldım.',
  sonrakiSonucDeneniyor: (calinamayan, neden, yeni) =>
    `⚠️ ${calinamayan} çalınamadı: ${neden}\n🔁 Aynı aramanın sıradaki sonucunu deniyorum: ${yeni}`,
  kurtarildi: '🔌 Müzik sunucusu yeniden başladı; kaldığım yerden devam ediyorum.',
  kurtarilamadiParca: (sarki) =>
    `⚠️ Müzik sunucusu geri geldi ama ${sarki} kaldığı yerden sürdürülemedi; sıradakine geçiyorum.`,
  kurtarilamadiBekliyorum:
    '⚠️ Müzik sunucusu geri gelmedi. 24/7 açık olduğu için kanalda kalıyorum; sunucu açılınca `/play` ile devam edebilirsiniz.',
  kurtarilamadiAyrildim:
    '⚠️ Müzik sunucusu geri gelmedi. Kanaldan ayrıldım; sunucu açılınca `/play` ile yeniden başlatabilirsiniz.',
};

// --- Şarkı kuyruğa eklenince ---------------------------------------------
export const ekleme = {
  calmayaBasliyor: '▶️ Çalmaya başlıyor',
  kuyrugaEklendi: '➕ Kuyruğa eklendi',
  kuyruktakiSirasi: (sira) => `Kuyruktaki sırası: ${sira}`,
  listeEklendi: '📃 Çalma listesi kuyruğa eklendi',
  listeAciklamasi: (ad, sayi) => `**${ad}** — ${sayi} parça`,
  varsayilanListeAdi: 'Liste',
  notBasligi: 'Not',
  sinirYuzundenEklenmedi: (sayi) => `Kuyruk sınırı yüzünden ${sayi} parça eklenmedi.`,
  desteklenmeyenAtlandi: (sayi) => `${sayi} parça şimdilik desteklenmeyen bir kaynaktan olduğu için eklenmedi.`,
};

// --- Şarkı seçme listesi (/play şarkı adıyla ve /search) -----------------
export const secim = {
  baslik: '🔎 Bir şarkı seçin',
  altBilgi: (saniye) => `Çalmak istediğinizi aşağıdan seçin (${saniye} saniye).`,
  menuYazisi: 'Bir şarkı seçin',
  zamanAsimi: (arama) => `⌛ Zamanında şarkı seçilmedi: ${arama}`,
  sadeceYazan: 'Bu seçimi yalnızca komutu yazan kişi yapabilir.',
  eklenemedi: (sarki) => `"${sarki}" eklenemedi.`,
};

// --- Sayfalı listeler (/queue, /servers) ----------------------------------
export const sayfalar = {
  sadeceYazan: 'Bu sayfaları yalnızca komutu kullanan kişi çevirebilir.',
};

// --- Web paneli yetki mesajları -------------------------------------------
export const panel = {
  gecersizSunucu: 'Geçersiz sunucu kimliği.',
  botSunucudaDegil: 'Bot bu sunucuda değil.',
  uyeDegilsin: 'Bu sunucunun üyesi değilsiniz.',
  kanalaKatil: 'Kontrol için botla aynı ses kanalına katılın.',
  botunKanalinaKatil: (kanal) => `Kontrol için "${kanal}" ses kanalına katılın.`,
  botunKanali: 'botun kanalı',
  djGerekli: 'Bu komutu kullanma yetkin yok. Bu sunucuda müzik kontrolü için DJ rolü gerekiyor.',
  tekrarModuGecersiz: 'Tekrar modu off, track ya da queue olmalı.',
  sesSeviyesiGecersiz: (en, enFazla) => `Ses seviyesi ${en} ile ${enFazla} arasında bir tam sayı olmalı.`,
  siraGecersiz: 'Sıra numarası geçersiz.',
  sorguUzunlugu: 'Şarkı adı ya da bağlantı 1-500 karakter olmalı.',
  bilinmeyenIslem: 'Bilinmeyen işlem.',
  cokFazlaIstek: 'Çok fazla istek. Biraz bekleyip tekrar deneyin.',
  girisYapin: 'Önce Discord ile giriş yapın.',
  oturumDoldu: 'Discord oturumunuzun süresi doldu. Çıkış yapıp yeniden girin.',
  cokFazlaSekme: 'Çok fazla açık sekme var.',
  sesKanaliBulunamadi: 'Ses kanalınız bulunamadı.',
  bulunamadi: 'Bulunamadı.',
  sayfaBulunamadi: 'Sayfa bulunamadı.',
  govdeGecersiz: 'İstek gövdesi geçersiz.',
  beklenmeyenHata: 'Beklenmeyen bir hata oluştu.',
  kaynakDogrulanamadi: 'İstek bu panelden gelmiyor (kaynak doğrulanamadı).',
  csrfGecersiz: 'Güvenlik anahtarı (CSRF) geçersiz. Sayfayı yenileyin.',
};

// =====================================================================
//  KOMUTLAR
//  aciklama   : Discord'da komutun altında görünen açıklama (en fazla 100 karakter)
//  secenekler : komutun seçeneklerinin açıklamaları (seçenek adlarını değiştirme)
//  diğerleri  : komutun cevap olarak yazdıkları
// =====================================================================
export const komutlar = {
  bassboost: {
    aciklama: 'Bas güçlendirme seviyesini ayarlar',
    secenekler: { seviye: 'Bas seviyesi' },
    kapatildi: '🎚️ Bas güçlendirme kapatıldı.',
    ayarlandi: (seviye) => `🎚️ Bas güçlendirme: **${seviye}**`,
  },
  clear: {
    aciklama: 'Kuyruğu temizler (çalan şarkı devam eder)',
    tamam: (sayi) => `🧹 Kuyruktan ${sayi} şarkı silindi.`,
  },
  disconnect: {
    aciklama: 'Ses kanalından ayrılır (müziği durdurur ve kuyruğu temizler)',
  },
  dj: {
    aciklama: 'DJ rolünü ayarlar: rol ayarlıysa müziği yalnızca DJ rolü olanlar yönetebilir',
    secenekler: {
      rol: 'DJ rolü (aynı rolü tekrar seçersen DJ rolü kaldırılır)',
      kaldır: 'DJ rolünü kaldır (herkes yeniden kontrol edebilir)',
    },
    ayarlandi: (rolId) =>
      `🎧 DJ rolü <@&${rolId}> olarak ayarlandı. Kontrol komutlarını artık bu rol, sunucu yöneticileri ve botla kanalda yalnız olan kişi kullanabilir.`,
    kaldirildi: '🎧 DJ rolü kaldırıldı. Herkes müziği yeniden kontrol edebilir.',
    simdikiRol: (rolId) => `🎧 Bu sunucunun DJ rolü: <@&${rolId}>. Kaldırmak için \`/dj kaldır:True\`.`,
    rolYok: '🎧 Bu sunucuda DJ rolü ayarlı değil; herkes müziği kontrol edebilir. Ayarlamak için `/dj rol:@Rol`.',
    kaydedilemedi:
      'DJ ayarı kaydedilemedi (data/sunucular.json yazılamadı; dosya başka bir programda açık olabilir). Ayar değişmedi, biraz sonra tekrar deneyin.',
  },
  grab: {
    aciklama: 'Çalan şarkıyı size özel mesaj (DM) olarak gönderir',
    baslik: '💾 Kaydedilen şarkı',
    dmKapali: 'Size özel mesaj gönderemedim. Sunucu ayarlarından "Doğrudan Mesajlar"a izin verip tekrar deneyin.',
    tamam: '📬 Şarkıyı özel mesaj olarak gönderdim.',
  },
  help: {
    aciklama: 'Tüm komutları ve ne işe yaradıklarını gösterir',
    baslik: '🎵 Komutlar',
    bilgiBasligi: 'Bilgi',
    yirmiDortYedi: '24/7 modu açık: bot ses kanalında kalır.',
    bosKanal: (saniye) => `Ses kanalı ${saniye} saniye boş kalırsa bot ayrılır.`,
    kaynaklar: 'YouTube ve Spotify bağlantıları ile şarkı adları desteklenir.',
    panel: (adres) => `Web paneli: ${adres}`,
    baglantilarBasligi: 'Bağlantılar',
    discordBaglantisi: (link) => `[Discord](${link})`,
    yazar: (ad, link) => `By [${ad}](${link})`,
    yazarBaglantisiz: (ad) => `By ${ad}`,
  },
  invite: {
    aciklama: 'Botu başka bir sunucuya eklemek için davet bağlantısı verir',
    baslik: '📨 Davet bağlantısı',
    metin: 'Botu eklemek istediğiniz sunucuda "Sunucuyu Yönet" yetkiniz olmalı.',
    dugme: 'Sunucuya ekle',
  },
  loop: {
    aciklama: 'Çalan şarkıyı tekrarlamayı açar/kapatır',
    acildi: '🔂 Şarkı tekrarı **açıldı**.',
    kapandi: '➡️ Şarkı tekrarı **kapatıldı**.',
  },
  loopqueue: {
    aciklama: 'Tüm kuyruğu tekrarlamayı açar/kapatır',
    acildi: '🔁 Kuyruk tekrarı **açıldı**.',
    kapandi: '➡️ Kuyruk tekrarı **kapatıldı**.',
  },
  lyrics: {
    aciklama: 'Çalan şarkının (ya da yazdığınız şarkının) sözlerini gösterir',
    secenekler: { şarkı: 'Boş bırakılırsa çalan şarkı kullanılır' },
    kaynak: (kaynak) => `Kaynak: ${kaynak}`,
    kaynaksiz: 'Şarkı sözleri',
  },
  move: {
    aciklama: 'Kuyruktaki bir şarkının sırasını değiştirir',
    secenekler: { parça: 'Taşınacak şarkının şu anki sırası', konum: 'Şarkının gideceği yeni sıra' },
    tamam: (sarki, sira) => `↕️ ${sarki} → ${sira}. sıraya taşındı.`,
  },
  nowplaying: {
    aciklama: 'Çalan şarkıyı ilerleme çubuğuyla gösterir',
    caliyor: '🎶 Şimdi çalıyor',
    duraklatildi: '⏸️ Duraklatıldı',
    canliYayin: '🔴 Canlı yayın',
    ses: 'Ses',
    tekrar: 'Tekrar',
    bas: 'Bas',
    kuyrukta: 'Kuyrukta',
    sarkiSayisi: (sayi) => `${sayi} şarkı`,
  },
  pause: {
    aciklama: 'Müziği duraklatır',
    tamam: '⏸️ Müzik duraklatıldı. Devam etmek için `/resume`.',
  },
  play: {
    aciklama: 'Bir şarkı, YouTube/Spotify bağlantısı ya da çalma listesi çalar',
    secenekler: { şarkı: 'Şarkı adı ya da bağlantı' },
  },
  playfirst: {
    aciklama: 'Kuyruktaki bir şarkıyı başa alır (sıradaki çalınacak şarkı olur)',
    secenekler: { sıra: 'Başa alınacak şarkının kuyruktaki sırası (/queue ile görebilirsiniz)' },
    tamam: (sarki) => `⏫ ${sarki} sıranın başına alındı; sıradaki şarkı bu.`,
    zatenBasta: (sarki) => `⏫ ${sarki} zaten sıradaki şarkı.`,
  },
  queue: {
    aciklama: 'Şarkı kuyruğunu sayfa sayfa gösterir',
    secenekler: { sayfa: 'Gösterilecek sayfa' },
    baslik: '📜 Kuyruk',
    simdiCaliyor: (sarki) => `**Şimdi çalıyor:** ${sarki}`,
    simdiCalanYok: '**Şimdi çalıyor:** —',
    bekleyenYok: '_Kuyrukta bekleyen şarkı yok._',
    altBilgi: (sayfa, sayfaSayisi, sarkiSayisi, toplam, tekrar) =>
      `Sayfa ${sayfa}/${sayfaSayisi} • ${sarkiSayisi} şarkı • Toplam ${toplam} • Tekrar: ${tekrar}`,
    bos: 'Kuyruk boş. `/play` ile şarkı ekleyebilirsiniz.',
  },
  remove: {
    aciklama: 'Kuyruktan bir şarkıyı çıkarır',
    secenekler: { sıra: 'Çıkarılacak şarkının kuyruktaki sırası' },
    tamam: (sarki) => `🗑️ Kuyruktan çıkarıldı: ${sarki}`,
  },
  resume: {
    aciklama: 'Duraklatılan müziği devam ettirir',
    tamam: '▶️ Müzik devam ediyor.',
  },
  search: {
    aciklama: 'Arama sonuçlarını listeler, içinden seçtiğiniz şarkıyı çalar',
    secenekler: { şarkı: 'Aranacak şarkı adı' },
  },
  seek: {
    aciklama: 'Şarkıda belirtilen zamana atlar',
    secenekler: { zaman: 'Örnek: 1:30, 90, 2dk 10sn, 1m30s' },
    anlasilmadi: 'Zamanı anlayamadım. Örnek: `1:30`, `90` ya da `2dk 10sn`.',
    tamam: (zaman) => `⏩ ${zaman} konumuna atlandı.`,
  },
  servers: {
    aciklama: 'Botun bulunduğu sunucuları listeler (yalnızca bot sahibi)',
    baslik: (sayi) => `🏠 Bulunduğum sunucular (${sayi})`,
    uyeSayisi: (sayi) => `👥 ${sayi} üye`,
    altBilgi: (sayfa, sayfaSayisi) => `Sayfa ${sayfa}/${sayfaSayisi}`,
    hicYok: 'Hiçbir sunucuda değilim.',
  },
  shuffle: {
    aciklama: 'Kuyruktaki şarkıları karıştırır',
    tamam: (sayi) => `🔀 Kuyruktaki ${sayi} şarkı karıştırıldı.`,
  },
  skip: {
    aciklama: 'Çalan şarkıyı atlar',
    tamam: (sarki) => `⏭️ Atlandı: ${sarki}`,
  },
  skipto: {
    aciklama: 'Kuyrukta belirtilen sıradaki şarkıya atlar',
    secenekler: { sıra: 'Kuyruktaki sıra numarası (/queue ile görebilirsiniz)' },
    tamam: (sira, sarki) => `⏩ ${sira}. sıraya atlandı: ${sarki}`,
  },
  stats: {
    aciklama: 'Botun ve müzik sunucusunun durumunu gösterir',
    baslik: '📊 İstatistikler',
    gecikme: '🏓 Gecikme',
    calismaSuresi: '⏱️ Çalışma süresi',
    bellek: '🗄️ Bellek',
    sunucular: '🏠 Sunucular',
    kullanicilar: '👥 Kullanıcılar',
    aktifOyuncu: '🎵 Aktif oyuncu',
    lavalink: '🎛️ Lavalink',
    lavalinkBilgisi: ({ surum, calan, calisma, bellek, cpu, eklentiler }) =>
      [
        `Sürüm: ${surum} • Çalan: ${calan}`,
        `Çalışma: ${calisma} • Bellek: ${bellek} • CPU: %${cpu}`,
        `Eklentiler: ${eklentiler}`,
      ].join('\n'),
    lavalinkYok: '❌ Bağlı değil',
    panel: '🌐 Web paneli',
  },
  stop: {
    aciklama: 'Müziği durdurur, kuyruğu temizler ve ses kanalından ayrılır',
    tamam: '⏹️ Müzik durduruldu ve kanaldan ayrıldım.',
  },
  volume: {
    aciklama: 'Ses seviyesini gösterir ya da değiştirir',
    secenekler: { seviye: 'Yeni ses seviyesi (1-150, normal: 100)' },
    simdiki: (seviye) => `🔊 Şu anki ses seviyesi: **${seviye}**`,
    ayarlandi: (seviye) => `🔊 Ses seviyesi **${seviye}** yapıldı.`,
    yuksekUyarisi: (seviye) => `🔊 Ses seviyesi **${seviye}** yapıldı (100 üstünde ses bozulabilir).`,
  },
};
