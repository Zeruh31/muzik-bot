// /ayar komutunun ve kontrol merkezindeki "Ayarlar" bölümünün yazıları.
// Her modülün kendi ayarlarının açıklamaları o modülün mesajlar.js dosyasında (ayarlar bölümü).
// Komut açıklamaları en fazla 100 karakter olabilir; değiştirince bir kez "npm run deploy-commands".

export const baslik = 'Ayarlar';
export const emoji = '⚙️';

export const komut = {
  aciklama: 'Sunucu ayarları (yalnız "Sunucuyu Yönet" izni olanlar)',
  goster: 'Bu sunucunun bütün ayarlarını gösterir',
  panel: 'Sabit "Kontrol Merkezi" mesajını bir kanala kurar ya da kaldırır',
  secenekler: {
    deger: 'Yeni değer (boşsa şu anki değer gösterilir)',
    sifirla: 'Varsayılana döndür',
    kanal: 'Panelin kurulacağı metin kanalı',
    kaldir: 'Paneli kaldır',
  },
  grupAciklamasi: (baslik) => `${baslik} ayarları`,
};

export const cevaplar = {
  kaydedildi: (ayar, deger) => `⚙️ **${ayar}** ayarı ${deger} olarak kaydedildi.`,
  sifirlandi: (ayar, deger) => `⚙️ **${ayar}** varsayılana döndü: ${deger}.`,
  simdiki: (ayar, deger, varsayilan) => `⚙️ **${ayar}**: ${deger}${varsayilan ? ' (varsayılan)' : ''}`,
  bilinmeyenAyar: 'Böyle bir ayar yok. Ayarların listesi için `/ayar goster`.',
  kaydedilemedi:
    'Ayar kaydedilemedi (data/ozellikler.json yazılamadı; dosya başka bir programda açık olabilir). Ayar değişmedi, biraz sonra tekrar deneyin.',
  yeniSurum:
    'Ayarlar şu an değiştirilemiyor: data/ozellikler.json daha yeni bir bot sürümüne ait. Bot sahibi botu güncellemeli; o zamana kadar varsayılanlar geçerli.',
  yeniSurumKonsol: (surum) =>
    `data/ozellikler.json daha yeni bir bot sürümüne ait (şema ${surum}); dosyaya dokunulmuyor, ayarlar varsayılan değerlerle çalışıyor ve /ayar değişiklikleri reddediliyor. Botu güncelleyin.`,
  gosterBaslik: '⚙️ Sunucu ayarları',
  ayarYok: 'Henüz ayarlanabilecek bir özellik yok.',
  bolumBasligi: (emoji, baslik) => `${emoji} ${baslik}`,
  ayarSatiri: (ad, deger, varsayilan) => `\`${ad}\`: ${deger}${varsayilan ? ' _(varsayılan)_' : ''}`,
  kapaliOzellik: (baslik, intentler) => `⚠️ ${baslik}: kapalı (Developer Portal'da ${intentler} açılmalı)`,
  panelSatiri: (kanalId) => (kanalId ? `🎛️ Kalıcı panel: <#${kanalId}>` : '🎛️ Kalıcı panel: kurulmadı (`/ayar panel`)'),
  rolDurdu: (neden) => `⚠️ **verilmiyor:** ${neden}`,
  menuIpucu: 'Değiştirmek için `/ayar <bölüm> <ayar> deger:...` yazın.',
  // Değerlerin gösterimi
  bos: '_ayarlanmadı_',
  acik: 'Açık',
  kapali: 'Kapalı',
};

// Doğrulama hataları
export const hatalar = {
  kanalTuru: (turler) => `Bu ayar için şu türde bir kanal seçin: ${turler}.`,
  kanalBaskaSunucu: 'Seçilen kanal bu sunucuda değil.',
  kanalIzni: (kanalId) =>
    `<#${kanalId}> kanalında mesaj göremiyor ya da gönderemiyorum. Kanal izinlerini kontrol edin.`,
  rolHerkes: '@everyone rolü seçilemez.',
  rolYonetilen: 'Bu rol bir bota ya da sunucu takviyesine ait; elle verilemez.',
  rolHiyerarsi: (rolId) =>
    `<@&${rolId}> rolünü veremem: rolüm ondan aşağıda. Sunucu Ayarları > Roller'de bot rolünü bu rolün üstüne sürükleyin.`,
  rolKisiHiyerarsi: (rolId) =>
    `<@&${rolId}> rolünü ayarlayamazsınız: sizin en yüksek rolünüzden aşağıda olmalı (sunucu sahibi hariç).`,
  metinUzunlugu: (enAz, enFazla) => `Metin ${enAz}-${enFazla} karakter olmalı.`,
  metinKarakteri: 'Metin görünmeyen denetim karakterleri içeremez.',
  sayiAraligi: (enAz, enFazla) => `Değer ${enAz} ile ${enFazla} arasında bir tam sayı olmalı.`,
  bayrak: 'Değer açık (True) ya da kapalı (False) olmalı.',
};

export const turAdlari = { metin: 'metin', ses: 'ses', kategori: 'kategori' };
