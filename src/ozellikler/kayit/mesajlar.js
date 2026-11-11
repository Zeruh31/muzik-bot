// "Kayıt" modülünün yazıları: kayıt kanalına giden kartlar, ayar açıklamaları, uyarılar ve kontrol merkezi bölümü.
// Ayar açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Kayıt';
export const emoji = '📜';
export const aciklama = 'Sunucuda olanları bir kayıt kanalına yazar';

// /ayar kayit <ayar> açıklamaları
export const ayarlar = {
  kanal: 'Kayıtların yazılacağı metin kanalı (boşsa kayıt kapalı)',
  uyeler: 'Sunucuya giren ve çıkan üyeler',
  silinen: 'Silinen mesajlar (içeriğiyle)',
  duzenlenen: 'Düzenlenen mesajlar (önceki ve sonraki hâli)',
  ses: 'Ses kanalına giriş, çıkış ve kanal değiştirme',
  roller: 'Bir üyeye rol verilmesi ya da alınması',
  'takma-ad': 'Takma ad değişiklikleri',
  yasaklar: 'Yasaklama ve yasağın kaldırılması',
  'haric-1': 'Kaydedilmeyen kanal 1',
  'haric-2': 'Kaydedilmeyen kanal 2',
  'haric-3': 'Kaydedilmeyen kanal 3',
  'haric-4': 'Kaydedilmeyen kanal 4',
  'haric-5': 'Kaydedilmeyen kanal 5',
};

/** Listeli ayarlar (masaüstü uygulamasında tek bir liste olarak görünür). */
export const listeler = {
  haric: 'Kaydedilmeyen kanallar (ör. yönetim kanalı; en fazla 5)',
};

// /ayar kayit kanal|turler (komut açıklamaları en fazla 100 karakter)
export const komut = {
  grup: 'Kayıt kanalı ve yazılacak olaylar',
  kanal: 'Kayıt kanalını seçer (boşsa şu ankini gösterir)',
  kanalSecenek: 'Kayıtların yazılacağı metin kanalı',
  kapat: 'Kaydı kapat',
  turler: 'Olay türlerini açar/kapatır (boş bırakılan değişmez)',
  turSatiri: (ad, acik) => `${acik ? '✅' : '⬜'} ${ad}`,
  kanalKaydedildi: (kanalId) => `✅ Kayıt kanalı: <#${kanalId}>`,
  kapatildi: '✅ Kayıt kapatıldı.',
  kanalYok: 'Kayıt kanalı seçilmedi; kayıt kapalı.',
  haric: 'Mesajları kaydedilmeyecek kanallar (boşsa listeler)',
  haricKanal: 'Eklenecek ya da çıkarılacak kanal',
  haricKaldir: 'Kanalı listeden çıkar',
  haricListe: (kanallar) =>
    kanallar.length
      ? `Mesajları kaydedilmeyen kanallar: ${kanallar.map((id) => `<#${id}>`).join(', ')}`
      : 'Mesajları kaydedilmeyen kanal yok.',
  haricEklendi: (kanalId) => `✅ <#${kanalId}> kanalındaki mesajlar artık kaydedilmeyecek.`,
  haricKaldirildi: (kanalId) => `✅ <#${kanalId}> yeniden kaydediliyor.`,
  haricYok: (kanalId) => `<#${kanalId}> zaten listede değil.`,
  haricDolu: (enFazla) => `En fazla ${enFazla} kanal hariç tutulabilir; önce birini çıkarın.`,
  haricGecersiz: 'Bu sunucudan bir metin kanalı seçin.',
};

/** Names of the event types in the control center's picker (at most 100 characters each). */
export const turAdlari = {
  uyeler: 'Giren / çıkan üyeler',
  silinen: 'Silinen mesajlar',
  duzenlenen: 'Düzenlenen mesajlar',
  ses: 'Ses kanalı giriş / çıkış',
  roller: 'Rol değişiklikleri',
  'takma-ad': 'Takma ad değişiklikleri',
  yasaklar: 'Yasaklama / yasak kaldırma',
};

export const kart = {
  uyeGirdi: '📥 Üye katıldı',
  uyeCikti: '📤 Üye ayrıldı',
  mesajSilindi: '🗑️ Mesaj silindi',
  topluSilindi: (sayi) => `🗑️ ${sayi} mesaj toplu silindi`,
  mesajDuzenlendi: '✏️ Mesaj düzenlendi',
  sesGirdi: '🔊 Ses kanalına girdi',
  sesCikti: '🔇 Ses kanalından çıktı',
  sesGecti: '🔀 Ses kanalı değiştirdi',
  rolDegisti: '🎭 Roller değişti',
  takmaAd: '🏷️ Takma ad değişti',
  yasaklandi: '⛔ Yasaklandı',
  yasakKalkti: '✅ Yasak kaldırıldı',
  kisi: (kisiId, etiket) => `<@${kisiId}>${etiket ? ` (${etiket})` : ''}`,
  kanal: (kanalId) => `Kanal: <#${kanalId}>`,
  yazar: (metin) => `Yazan: ${metin}`,
  yazarBilinmiyor: 'Yazan: _bilinmiyor_',
  icerik: 'İçerik',
  once: 'Önce',
  sonra: 'Sonra',
  bos: '_(boş)_',
  icerikGizli:
    '_İçerik gösterilmiyor: mesaj herkesin göremediği bir kanaldaydı, kayıt kanalını ise herkes görebiliyor._',
  icerikBilinmiyor: '_İçerik bilinmiyor: mesaj bot açılmadan önce ya da önbellek süresinden önce gönderilmiş._',
  ekler: (liste) => `Ekler: ${liste}`,
  ek: (ad, boyut) => `\`${ad}\` (${boyut})`,
  mesajaGit: (url) => `[Mesaja git](${url})`,
  hesapAcilis: (saniye) => `Hesap açılışı: <t:${saniye}:R>`,
  katilma: (saniye) => `Katılma: <t:${saniye}:R>`,
  kanallar: (eski, yeni) => `<#${eski}> → <#${yeni}>`,
  verilen: (liste) => `Verilen: ${liste}`,
  alinan: (liste) => `Alınan: ${liste}`,
  adlar: (eski, yeni) => `${eski} → ${yeni}`,
  adYok: '_(yok)_',
  sebep: (metin) => `Sebep: ${metin}`,
  bilinenler: (sayi) => `Önbellekte bulunan ${sayi} mesaj:`,
  kimlik: (id) => `-# Kimlik: ${id}`,
};

export const bolum = {
  metin: (kanalId, satirlar) =>
    [
      '### 📜 Kayıt',
      kanalId ? `Kayıt kanalı: <#${kanalId}>` : 'Kayıt kanalı: _seçilmedi_ (`/ayar kayit kanal`)',
      ...satirlar,
      '-# Aşağıdan yazılacak olayları seçin. Silinen mesajların içeriği yalnız bellekte, en fazla 24 saat tutulur.',
    ].join('\n'),
  turSec: 'Kaydedilecek olaylar',
  kapaliIntent: (tur, intent) => `⚠️ ${tur}: kapalı (Developer Portal'da ${intent} açılmalı)`,
  kaydedildi: (sayi) => `✅ Kaydedilecek olay türü: ${sayi}`,
  erisilemiyor: (saniye) =>
    `⚠️ Kayıt kanalına yazılamıyor (kanal silinmiş ya da iznim yok); <t:${saniye}:R> yeniden denenecek. Kanal izinlerini kontrol edin.`,
  yoneticiGerekli: 'Kayıt ayarlarını yalnız "Sunucuyu Yönet" izni olanlar değiştirebilir.',
};

/** Developer Portal names of the privileged intents (README, 3. adım). */
export const intentAdlari = {
  GuildMembers: 'Server Members Intent',
  MessageContent: 'Message Content Intent',
};

// Konsola yazılanlar (bot sahibine yönelik).
export const konsol = {
  intentEksik: (intentler, turler) =>
    `Kayıt: Discord ${intentler} vermedi; şu kayıt türleri kapalı: ${turler}. Açmak için Developer Portal > Bot > ` +
    'Privileged Gateway Intents (README, 3. adım), sonra botu yeniden başlatın.',
  gonderilemedi: (kanalId, hata, dakika) =>
    `Kayıt kanalına (${kanalId}) yazılamadı: ${hata}. ${dakika} dakika kayıt gönderilmeyecek. Kanalda "Kanalı ` +
    'Görüntüle", "Mesaj Gönder" ve "Bağlantı Yerleştir" iznim olmalı.',
};
