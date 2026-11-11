// "Şans" modülünün yazıları: /oyun zar, /oyun sec, /oyun yazitura ve kontrol merkezindeki "Oyun" bölümü.
// Komut açıklamaları en fazla 100 karakter; değiştirince bir kez "npm run deploy-commands".
// ${...} ile yazılmış yerleri silme; yerlerini değiştirebilirsin.

export const baslik = 'Şans';
export const emoji = '🎲';
export const aciklama = 'Zar, rastgele seçim, yazı tura';

export const komutlar = {
  zar: 'Zar atar (ör. 2 tane 6 yüzlü)',
  sec: 'Verdiğiniz seçeneklerden birini rastgele seçer',
  yazitura: 'Yazı tura atar',
  secenekler: {
    yuz: 'Zarın yüz sayısı (2-1000, varsayılan 6)',
    adet: 'Kaç zar atılsın (1-100, varsayılan 1)',
    secenekler: 'Seçenekler, virgülle ayırarak: pizza, döner, lahmacun',
  },
};

export const cevaplar = {
  zar: (kisi, adet, yuz, sonuclar, toplam) =>
    adet === 1
      ? `🎲 ${kisi} **${adet}d${yuz}** attı: **${sonuclar[0]}**`
      : `🎲 ${kisi} **${adet}d${yuz}** attı: ${sonuclar.join(', ')}\nToplam: **${toplam}**`,
  sec: (kisi, secilen, sayi) => `🤔 ${kisi} için ${sayi} seçenek arasından: **${secilen}**`,
  yazi: (kisi) => `🪙 ${kisi} için para havada… **Yazı**!`,
  tura: (kisi) => `🪙 ${kisi} için para havada… **Tura**!`,
  azSecenek: (enAz, enFazla) => `${enAz}-${enFazla} seçenek yazın, virgülle ayırarak (ör. \`pizza, döner, lahmacun\`).`,
};

export const bolum = {
  metin: '### 🎲 Şans\nZar, yazı tura; seçim için `/oyun sec`.',
  zar: 'Zar at',
  yazitura: 'Yazı tura',
};
