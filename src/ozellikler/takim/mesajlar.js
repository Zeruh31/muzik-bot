// "Takım" modülünün yazıları: /oyun takim, sağ tık "Takıma ekle" ve kontrol merkezindeki "Oyun" bölümü.
// Komut açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Takım';
export const emoji = '👥';
export const aciklama = 'Ses kanalındakileri rastgele takımlara böler';

export const komutlar = {
  takim: 'Ses kanalınızdakileri rastgele takımlara böler',
  // Sağ tık > Uygulamalar menüsünde görünen ad (en fazla 32 karakter)
  takimaEkle: 'Takıma ekle',
  secenekler: {
    takimlar: 'Kaç takım (2-4, varsayılan 2)',
    kaptan: 'Her takıma rastgele bir kaptan seçilsin',
    kanal: (n) => `${n}. takımın taşınacağı ses kanalı (isteğe bağlı)`,
  },
};

export const kart = {
  baslik: (sayi) => `## 👥 ${sayi} takım kuruldu`,
  takim: (n, kisiSayisi) => `**${['🔴', '🔵', '🟢', '🟡'][n - 1] ?? '⚪'} Takım ${n}** (${kisiSayisi})`,
  kanal: (kanalId) => `→ <#${kanalId}>`,
  kaptan: '👑',
  bos: '_boş_',
  altBilgi: (sahipId) =>
    `-# Kuran: <@${sahipId}> • Karıştırma onda ve yöneticilerde; taşıma için "Üyeleri Taşı" izni de gerekir.`,
  karistir: 'Yeniden karıştır',
  tasi: 'Kanallara taşı',
  tasiKanalYok: 'Taşımak için her takıma bir ses kanalı seçin (`/oyun takim kanal1:... kanal2:...`).',
};

export const cevaplar = {
  sesteDegilsin: 'Önce bir ses kanalına girin; takımlar oradaki kişilerden kurulur.',
  azKisi: (gereken, olan) => `${gereken} takım için en az ${gereken} kişi gerekli; ses kanalınızda ${olan} kişi var.`,
  suresiDoldu:
    'Bu takım listesi artık geçerli değil (bot yeniden başladı ya da 3 saatten fazla geçti). `/oyun takim` ile yeniden kurun.',
  yetkiYok: 'Bunu yalnız takımları kuran kişi ya da "Sunucuyu Yönet" izni olanlar yapabilir.',
  kanalEksik: (gereken) =>
    `Taşımak için ${gereken} ses kanalı gerekli. \`/oyun takim\` komutunda \`kanal1\`, \`kanal2\`... seçin.`,
  kanalAyni: 'Her takım için farklı bir ses kanalı seçin.',
  botTasiyamaz: 'Üyeleri taşıyamıyorum: bot rolünde "Üyeleri Taşı" izni yok.',
  kanalIzni: (kanalId) =>
    `<#${kanalId}> kanalına kimseyi taşıyamıyorum: orada "Kanalı Görüntüle", "Bağlan" ve "Üyeleri Taşı" iznim olmalı.`,
  sizeKapali: (kanalId) => `<#${kanalId}> kanalına sizin bağlanma izniniz yok; kimseyi taşıyamam.`,
  tasindi: (tasinan, atlanan, izinsiz = 0) =>
    `✅ ${tasinan} kişi takım kanalına taşındı.` +
    (atlanan ? ` ${atlanan} kişi ses kanalında olmadığı için atlandı.` : '') +
    (izinsiz ? ` ${izinsiz} kişinin takım kanalına girme izni olmadığı için taşınmadı.` : ''),
  tasimaYetkisi: 'Üyeleri kanallara taşımak için "Üyeleri Taşı" ya da "Sunucuyu Yönet" izniniz olmalı.',
  ekleBotOlmaz: 'Botlar takıma eklenemez.',
  ekleListeYok: 'Son 3 saatte kurduğunuz bir takım listesi yok. Önce `/oyun takim` ile takımları kurun.',
  ekleZatenVar: (kisi) => `${kisi} zaten bir takımda.`,
  eklendi: (kisi, takim) => `✅ ${kisi}, Takım ${takim} listesine eklendi.`,
};

export const bolum = {
  metin: '### 👥 Takım\nSes kanalınızdakileri rastgele böler. Kaptan ve kanallara taşıma için `/oyun takim`.',
  kur: (n) => `${n} takım`,
};
