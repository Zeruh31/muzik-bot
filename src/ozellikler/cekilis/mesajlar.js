// "Çekiliş" modülünün yazıları: /oyun cekilis, çekiliş mesajı, sonuç duyurusu ve kontrol merkezi formu.
// Komut açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Çekiliş';
export const emoji = '🎉';
export const aciklama = 'Düğmeyle katılınan çekilişler (yöneticiler başlatır)';

export const komutlar = {
  cekilis: 'Çekiliş başlatır (yalnız "Sunucuyu Yönet" izni olanlar)',
  secenekler: {
    odul: 'Ne çekiliyor (ör. Steam hediye kartı)',
    sure: 'Ne kadar sürsün: 30dk, 2sa, 1g, 1g12sa (en az 1 dakika, en çok 30 gün)',
    kazanan: 'Kaç kazanan (1-20, varsayılan 1)',
    rol: 'Yalnız bu role sahip olanlar katılabilsin (isteğe bağlı)',
  },
};

export const kart = {
  acikBaslik: '## 🎉 Çekiliş',
  bittiBaslik: '## 🎉 Çekiliş bitti',
  odul: (odul) => `**${odul}**`,
  bitis: (saniye) => `Bitiş: <t:${saniye}:R> (<t:${saniye}:f>)`,
  bitti: (saniye) => `Bitti: <t:${saniye}:R>`,
  sayilar: (kazanan, katilimci) => `Kazanan sayısı: ${kazanan} • Katılımcı: ${katilimci}`,
  katilimci: (sayi) => `Katılımcı: ${sayi}`,
  rol: (rolId) => `Gerekli rol: <@&${rolId}>`,
  baslatan: (kisiId) => `-# Başlatan: <@${kisiId}>`,
  kazananlar: (liste) => `Kazananlar: ${liste}`,
  kazananYok: 'Kimse katılmadığı için kazanan yok.',
  saklamaNotu: (saat) =>
    `-# Katılımcı listesi ${saat} saat sonra silinir; o zamana kadar "Yeniden çek" ile yeni kazanan seçilebilir.`,
  katil: 'Katıl',
  ayril: 'Ayrıl',
  erkenBitir: 'Şimdi bitir',
  yenidenCek: 'Yeniden çek',
};

export const duyuru = {
  kazandi: (liste, odul) => `🎉 Tebrikler ${liste}! **${odul}** kazandınız.`,
  kimseYok: (odul) => `🎉 **${odul}** çekilişi bitti ama kimse katılmadı.`,
  yeniden: (liste, odul) => `🔁 Yeniden çekildi: ${liste} **${odul}** kazandı!`,
};

export const cevaplar = {
  yetkiYok: 'Çekilişi yalnız "Sunucuyu Yönet" izni olanlar bitirebilir ya da yeniden çekebilir.',
  baslatmaYetkisi: 'Çekiliş başlatmak için "Sunucuyu Yönet" izni gerekli.',
  sureGecersiz: (enFazlaGun) =>
    `Süreyi \`30dk\`, \`2sa\`, \`1g\` ya da \`1g12sa\` gibi yazın (en az 1 dakika, en çok ${enFazlaGun} gün).`,
  bulunamadi: 'Bu çekiliş artık yok (bitişinin üstünden uzun zaman geçti).',
  bittiZaten: 'Bu çekiliş bitti.',
  bitmediHenuz: 'Çekiliş henüz bitmedi.',
  rolGerekli: (rolId) => `Bu çekilişe yalnız <@&${rolId}> rolü olanlar katılabilir.`,
  katildin: (odul) => `🎉 **${odul}** çekilişine katıldınız. Bol şans!`,
  zatenKatildin: 'Bu çekilişe zaten katıldınız. Ayrılmak için **Ayrıl**.',
  ayrildin: 'Çekilişten ayrıldınız.',
  katilmamissin: 'Bu çekilişe katılmamıştınız.',
  dolu: (enFazla) => `Bu çekiliş dolu (en fazla ${enFazla} katılımcı).`,
  kalanYok: 'Yeniden çekmek için kazanmamış katılımcı kalmadı.',
  bitirildi: 'Çekiliş bitirildi; sonuç kanala yazıldı.',
  kaydedilemedi:
    'Çekiliş kaydedilemedi (data/cekilisler.json yazılamadı; dosya başka bir programda açık olabilir). Biraz sonra tekrar deneyin.',
  yeniSurum:
    'Çekilişler şu an değiştirilemiyor: data/cekilisler.json daha yeni bir bot sürümüne ait. Botu güncelleyin.',
};

export const form = {
  baslik: 'Çekiliş başlat',
  odul: 'Ödül',
  sure: 'Süre (ör. 30dk, 2sa, 1g)',
  kazanan: 'Kazanan sayısı (1-20)',
  kazananIpucu: 'Boş bırakılırsa 1',
};

export const bolum = {
  metin: '### 🎉 Çekiliş\nDüğmeyle katılınır; süre dolunca kazananlar duyurulur. Gerekli rol için `/oyun cekilis`.',
  baslat: 'Çekiliş başlat',
};
