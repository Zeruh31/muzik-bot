// "Sesli komut" modülünün yazıları: ayar açıklamaları, kanala yazılan cevaplar, /muzik sesli-komut ve kontrol merkezi.
// Ayar ve komut açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Sesli komut';
export const emoji = '🎙️';
export const aciklama = 'Ses kanalında "<uyandırma sözü>, tarkan dudu aç" deyin';
export const ayarGrubu = 'Sesli komut (ses kanalında konuşarak müzik kontrolü)';

// /ayar sesli-komut <ayar> açıklamaları
export const ayarlar = {
  acik: 'Bot ses kanalındayken sesli komutları dinlesin mi (varsayılan kapalı)',
  uyandirma: 'Komuttan önce söylenecek söz (varsayılan "müzik bot")',
};

/** The default wake phrase: neutral, for any server (each server sets its own with /ayar). */
export const varsayilanUyandirma = 'müzik bot';

// Kanala yazılan cevaplar. ad = konuşanın sunucudaki adı.
export const cevap = {
  caliyor: (ad, sarki) => `🎙️ **${ad}**: ▶️ ${sarki} çalıyorum`,
  siradaki: (ad, sarki) => `🎙️ **${ad}**: ⏭️ ${sarki} sıradaki şarkı oldu`,
  listeBaslar: (ad, liste, adet) => `🎙️ **${ad}**: 📜 ${liste} listesi çalıyor (${adet} şarkı)`,
  listeYok: (ad, liste) => `🎙️ **${ad}**: ❌ "${liste}" adında bir liste bulamadım (\`/muzik liste göster\`)`,
  sesSeviye: (ad, seviye) => `🎙️ **${ad}**: 🔊 ses ${seviye}`,
  sarildi: (ad, konum) => `🎙️ **${ad}**: ⏩ ${konum} konumuna sardım`,
  basaSarildi: (ad) => `🎙️ **${ad}**: ⏮️ şarkıyı baştan başlattım`,
  sirayaAtlandi: (ad, sira, sarki) => `🎙️ **${ad}**: ⏭️ ${sira}. şarkıya geçtim: ${sarki}`,
  calan: (ad, sarki, sanatci) => `🎙️ **${ad}**: 🎵 şu an ${sarki}${sanatci ? ` — ${sanatci}` : ''} çalıyor`,
  calanYok: (ad) => `🎙️ **${ad}**: şu an bir şey çalmıyor`,
  sira: (ad, liste, kalan) =>
    `🎙️ **${ad}**: sırada ${liste.map((t, i) => `${i + 1}. ${t}`).join(', ')}${kalan ? ` ve ${kalan} şarkı daha` : ''}`,
  siraBos: (ad) => `🎙️ **${ad}**: sıra boş`,
  sayi: (ad, adet) => `🎙️ **${ad}**: sırada ${adet} şarkı var`,
  donguListe: (ad) => `🎙️ **${ad}**: 🔁 sıra tekrar ediliyor`,
  donguKapali: (ad) => `🎙️ **${ad}**: ➡️ tekrar kapalı`,
  otomatik: (ad, acik) => `🎙️ **${ad}**: 🤖 otomatik çalma ${acik ? 'açık' : 'kapalı'}`,
  anlamadimOneri: (ad, oneri) => `🎙️ **${ad}**: anlamadım — "${oneri}" mı dediniz?`,
  siraya: (ad, sarki, sira) => `🎙️ **${ad}**: ➕ ${sarki} sıraya eklendi (${sira}.)`,
  liste: (ad, liste, adet) => `🎙️ **${ad}**: ➕ ${liste} listesinden ${adet} şarkı eklendi`,
  kapat: (ad) => `🎙️ **${ad}**: ⏹️ müziği kapattım, kuyruk temizlendi`,
  gec: (ad, sarki) => `🎙️ **${ad}**: ⏭️ geçtim${sarki ? `: ${sarki}` : ''}`,
  duraklat: (ad, soz) => `🎙️ **${ad}**: ⏸️ duraklatıldı${soz ? ` — devam etmek için "Hey ${soz}, devam et"` : ''}`,
  devam: (ad) => `🎙️ **${ad}**: ▶️ devam ediyorum`,
  ses: (ad, seviye) => `🎙️ **${ad}**: 🔊 ses ${seviye}`,
  sessiz: (ad) => `🎙️ **${ad}**: 🔇 sesi kapattım`,
  sesGeriAcildi: (ad, seviye) => `🎙️ **${ad}**: 🔊 ses geri açıldı (${seviye})`,
  onceki: (ad) => `🎙️ **${ad}**: ⏮️ önceki şarkı`,
  karistir: (ad) => `🎙️ **${ad}**: 🔀 sırayı karıştırdım`,
  tekrarla: (ad, acik) => `🎙️ **${ad}**: 🔂 tekrar ${acik ? 'açık' : 'kapalı'}`,
  anlamadim: (ad) => `🎙️ **${ad}**: anlamadım`,
  hata: (ad, neden) => `🎙️ **${ad}**: ❌ ${neden}`,
  djGerekli: (ad, rolId) => `🎙️ **${ad}**: ❌ bunun için <@&${rolId}> rolü gerekiyor`,
};

// Bot kanala girince ve başka kanala taşınınca (her kanalda 10 dakikada en çok bir kez; kapatılamaz: Discord politikası)
export const bildirim = {
  acik: (soz) =>
    `🎙️ **Sesli komut açık** — kendini hariç tutmak için \`/muzik sesli-komut beni-dinleme\`. Bu kanaldaki herkes "**${soz}**, tarkan dudu aç" ya da "**${soz}**, müziği duraklat" diyebilir; ses bu bilgisayarda işlenir, kaydedilmez.`,
  kuruluDegil:
    '🎙️ Sesli komut bu sunucuda açık ama bileşeni kurulu değil; bot dinlemiyor. Bot sahibi masaüstü uygulamasından (Araçlar > "Sesli komut bileşenini kur") kurmalı.',
  hata: '🎙️ Sesli komut şu an çalışmıyor (konuşma tanıma başlatılamadı). Bot sahibi kayıtlara bakmalı.',
};

// /muzik sesli-komut
export const komut = {
  aciklama: 'Sesli komut: kendi sesinizi dinlemeden çıkarın ya da geri alın',
  benidinleme: 'Bu sunucuda sesiniz sesli komut için hiç işlenmez',
  benidinle: 'Sesiniz yeniden sesli komut için dinlenir',
  durum: 'Sesli komutun bu sunucudaki durumu',
};

export const cevaplar = {
  haricTutuldu:
    '🔇 Bu sunucuda sesiniz artık sesli komut için işlenmeyecek (paketleriniz çözülmeden atılır). Geri almak için `/muzik sesli-komut beni-dinle`.',
  zatenHaric: '🔇 Sesiniz zaten dinlenmiyor. Geri almak için `/muzik sesli-komut beni-dinle`.',
  dinleniyor: '🎙️ Sesiniz yeniden sesli komut için dinlenecek.',
  zatenDinleniyor: '🎙️ Sesiniz zaten hariç tutulmuyor.',
  kaydedilemedi: 'Tercihiniz kaydedilemedi (data/sesli-komut.json yazılamadı). Biraz sonra tekrar deneyin.',
  yeniSurum: 'data/sesli-komut.json daha yeni bir bot sürümüne ait; bot güncellenene kadar değiştirilemez.',
  durum: ({ acik, soz, kurulu, isci, haric }) =>
    [
      `🎙️ **Sesli komut:** ${acik ? 'açık' : 'kapalı'} (yönetici: \`/ayar sesli-komut acik\`)`,
      `Uyandırma sözü: **${soz}**`,
      `Bileşen: ${kurulu ? 'kurulu' : 'kurulu değil'} · Tanıma: ${isci}`,
      haric ? '🔇 Sizin sesiniz dinlenmiyor.' : 'Sizin sesiniz dinlenebilir (`/muzik sesli-komut beni-dinleme`).',
    ].join('\n'),
};

/** How the worker state is shown. */
export const isciDurumu = {
  kapali: 'kapalı',
  basliyor: 'başlıyor',
  hazir: (cihaz, model) => `çalışıyor (${cihaz === 'cuda' ? 'GPU' : 'CPU'}, ${model})`,
  hata: 'hata',
};

// Kontrol merkezi bölümü
export const bolum = {
  metin: ({ acik, soz, haric }) =>
    [
      `### 🎙️ Sesli komut: ${acik ? 'açık' : 'kapalı'}`,
      acik
        ? `Ses kanalında "**${soz}**, <şarkı> aç", "**${soz}**, geç", "**${soz}**, sesi kıs" deyin.`
        : 'Yönetici `/ayar sesli-komut acik deger:True` ile açabilir.',
      haric ? '🔇 Sizin sesiniz dinlenmiyor.' : '-# Dinlenmek istemezseniz aşağıdaki düğme.',
    ].join('\n'),
  benidinleme: 'Beni dinleme',
  benidinle: 'Beni dinle',
};

// Konsol (bot sahibi için; konuşma metni hiçbir zaman yazılmaz)
export const konsol = {
  kuruluDegil: (dizin) => `Sesli komut açık ama bileşen kurulu değil (${dizin}); bot sağır kalıyor.`,
};
