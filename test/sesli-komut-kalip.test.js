// Sesli komut kalıpları: her niyet için en az 5 farklı söyleyiş, Türkçe sayı/süre/sıra okuma, belirsizlik ve
// geniş bir oyun sohbeti korpusunda (uyandırma sözüyle başlayan ama komut olmayan cümleler dahil) 0 yanlış komut.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { degerlendir } from '../src/ozellikler/sesli-komut/kapilar.js';
import { cozumle, parseCommand, words } from '../src/ozellikler/sesli-komut/niyet.js';
import { parseDuration, parseKonum, parseNumber, parseOrdinal } from '../src/ozellikler/sesli-komut/sayilar.js';

const K = 'Kutluay bot';
const niyet = (rest, wake = K) => cozumle(`${wake}, ${rest}`, wake)?.niyet ?? null;
const kat = (text) => words(text).map((w) => w.kat);

/** Intent -> at least five ways to say it (beyond the examples in kaliplar.js), with fillers and endings. */
const SOYLEYISLER = {
  gec: [
    'atla',
    'sonrakine geç',
    'bir sonraki şarkı',
    'pas geç',
    'bunu geç',
    'şu şarkıyı geç abi',
    'başka şarkı aç',
    'lütfen geç',
    'sıradakine geç',
    'bunu atla',
    'başkasını çal',
    'başka bir şarkı çal',
    'sonrakini çal',
    'bu şarkıyı değiştir',
  ],
  onceki: [
    'önceki şarkı',
    'geri dön',
    'geri al',
    'bir önceki şarkıya dön',
    'öncekine geç',
    'önceki şarkıyı tekrar çal',
    'öncekini çal',
  ],
  kapat: [
    'müziği kapat',
    'kapat',
    'bitir',
    'müziği bitir',
    'kuyruğu temizle',
    'listeyi temizle',
    'şarkıyı kapat kanka',
    'çalma',
  ],
  duraklat: [
    'durdur',
    'dur',
    'müziği durdur',
    'şarkıyı durdur',
    'bekle',
    'bi dur',
    'bu şarkıyı durdur',
    'duraklat',
    'biraz bekle',
    'müziği duraklat',
    'mola ver',
    'bir saniye dur',
    'ara ver',
    'şarkıyı beklet',
    'sus',
    'kes',
    'müziği kes',
    'şarkıyı kes',
    'bi sus',
    'yeter',
    'yeter artık',
    'bu şarkıyı kes',
  ],
  devam: [
    'devam et',
    'devam',
    'kaldığın yerden devam et',
    'müziği aç',
    'sürdür lütfen',
    'devam ettir',
    'kaldığı yerden devam',
    'müziğe devam et',
    'şarkıyı sürdür',
  ],
  'ses-kis': [
    'sesi kıs',
    'sesi biraz kıs',
    'sesini azalt',
    'sesi düşür abi',
    'çok yüksek',
    'sesi aşağı al',
    'sesi indir',
    'sesi kısar mısın',
    'sesin çok yüksek',
  ],
  'ses-ac': [
    'sesi aç',
    'sesi biraz aç',
    'sesi artır',
    'sesini yükselt',
    'çok kısık',
    'sesi yukarı al',
    'sesi biraz yükselt',
    'sesi büyüt',
    'sesi açar mısın',
  ],
  'ses-ayarla': [
    'sesi yüzde elli yap',
    'sesi 30 yap',
    'ses seksen olsun',
    'sesi %40 yap',
    'sesi sonuna kadar aç',
    'sesi yetmişe ayarla',
    "sesi yüzde 40'a çek",
    "sesi 40'a çek",
    'sesi yüzde elliye getir',
    'sesi maksimuma çıkar',
  ],
  'sar-ileri': [
    'otuz saniye ileri sar',
    '10 saniye ileri al',
    'bir dakika ileri git',
    'yarım dakika ileri sar',
    'bir buçuk dakika ileri sar',
    '30 saniye ileri al',
    'yarım dakika ileri',
    'on saniyelik ileri',
    'ileri at',
    'ileri geç',
    'ileri atla',
    'öne al',
    'ilerlet',
    'biraz ileri al',
    'ileri al',
  ],
  sessiz: [
    'sesi kapat',
    'sesi kes',
    'sesi sustur',
    'sessize al',
    'sesi sıfırla',
    'sesi tamamen kıs',
    'sesini kapat abi',
  ],
  'sesi-geri-ac': [
    'sesi geri aç',
    'sesi aç geri',
    'sessizden çıkar',
    'sesi tekrar aç',
    'sesi eski haline getir',
    'sesini geri ver',
  ],
  'sar-konum': [
    '1 dakika 30 saniyeye git',
    "2:30'a al",
    'ikinci dakikaya git',
    'otuz saniyeye git',
    'bir buçuk dakikaya sar',
  ],
  'sar-geri': [
    '1 dakika geri al',
    'on saniye geri sar',
    'yarım dakika geri git',
    'yirmi saniye geriye sar',
    'geri sar 15 saniye',
    'geri git',
    'geriye al',
    'biraz geri sar',
    '10 saniye geri dön',
    '30 saniye geri al',
  ],
  'basa-sar': [
    'başa sar',
    'baştan al',
    'şarkıyı baştan başlat',
    'en başa dön',
    'bunu baştan çal',
    'baştan başlat',
    'şarkıyı yeniden başlat',
    'en baştan çal',
  ],
  'siraya-atla': [
    'üçüncü şarkıya geç',
    'sıradaki 2. şarkıyı çal',
    'ikinci şarkıyı çal',
    'dördüncüye atla',
    '5. şarkıya geç',
    'üçüncüsüne geç',
  ],
  'bilgi-calan': [
    'çalan şarkı ne',
    'bu şarkının adı ne',
    'şu an ne çalıyor',
    'bu hangi şarkı',
    'ne çalıyor abi',
    'şarkının adı ne',
    'bu ne şarkısı',
    'bu şarkıyı kim söylüyor',
    'şarkının adını söyle',
  ],
  'bilgi-sira': ['sırada ne var', 'sıradaki şarkı ne', 'kuyrukta ne var', 'sonraki şarkı ne', 'sonra ne çalacak'],
  'bilgi-sayi': [
    'kaç şarkı var',
    'sırada kaç şarkı var',
    'kuyrukta kaç şarkı var',
    'kaç şarkı kaldı',
    'listede kaç şarkı var',
  ],
  'kuyruga-ekle': [
    'kuyruğa Tarkan ekle',
    "Tarkan'ı sıraya ekle",
    'sıraya Barış Manço koy',
    'Sezen Aksu gülümse ekle',
    "Duman'ı kuyruğa at",
  ],
  'hemen-cal': [
    'hemen Tarkan çal',
    'şimdi dudu aç',
    "Sezen Aksu'yu hemen çal",
    'direkt Duman aç',
    'sıradaki olarak Tarkan çal',
  ],
  'liste-cal': [
    'gece listemi çal',
    'oyun listesini aç',
    'sabah listesini çal',
    'gece adlı listeyi aç',
    'parti listemi başlat',
  ],
  tekrarla: [
    'tekrarla',
    'döngüye al',
    'bu şarkıyı tekrarla',
    'tekrar et',
    'bir daha çal',
    'tekrar çal',
    'bunu bir daha çal',
    'bu şarkıyı tekrar çal',
  ],
  'tekrar-liste': [
    'listeyi tekrarla',
    'kuyruğu tekrarla',
    'sırayı döngüye al',
    'listeyi döngüye al',
    'kuyruk döngüsü aç',
  ],
  'dongu-kapat': ['döngüyü kapat', 'tekrarı kapat', 'tekrarlamayı bırak', 'döngüyü kaldır', 'tekrarlama'],
  karistir: ['karıştır', 'listeyi karıştır', 'sırayı karıştır', 'karışık çal', 'rastgele çal', 'şarkıları karıştır'],
  'otomatik-ac': [
    'otomatik çalmayı aç',
    'otomatik çal aç',
    'otomatik çalmayı başlat',
    'otomatik çalsın',
    'otomatik çalma açık',
  ],
  'otomatik-kapat': [
    'otomatik çalmayı kapat',
    'otomatik çal kapat',
    'otomatik çalmayı durdur',
    'otomatik çalmasın',
    'otomatik kapalı',
  ],
  cal: [
    'Tarkan dudu dudu aç',
    'Sezen Aksu gülümse çal',
    'Barış Manço çalar mısın',
    'bir Tarkan koy',
    'çal Duman',
    'hadi Mor ve Ötesi aç',
  ],
};

/** Ordinary game chat: none of it may become a command (wake phrase in front or not). */
const SOHBET = [
  'abi şu tarafa geç arkadan geliyorlar',
  'sağdan dolan sağdan',
  'mermim bitti bana mermi at',
  'tamam devam edelim bir el daha',
  'müzik çok güzelmiş kim açtı bunu',
  'kapıyı aç içeri gireceğim',
  'pencereyi kır',
  'arabaya bin hadi',
  'bekle beni geliyorum',
  'dur dur dur ateş etme',
  'öldüm ya yine',
  'şu adamı vur',
  'ben geri çekiliyorum',
  'haritayı aç bakayım',
  'envanteri aç',
  'sesimi duyuyor musun',
  'mikrofonum kısık mı',
  'bir saniye su içeceğim',
  'annem çağırıyor geliyorum',
  'kim kazandı',
  'skor kaç kaç',
  'bu el bizim',
  'yarın kaçta oynuyoruz',
  'yemek geldi beş dakika',
  'internetim kopuyor',
  'lag var lag',
  'oyunu kapat yeniden aç',
  'discordu yeniden başlat',
  'kamerayı aç',
  'yayını aç',
  'şarkı söyleme abi',
  'bu şarkıyı bilmiyorum',
  'şarkının sözleri ne güzel',
  'en sevdiğim şarkı bu',
  'bu şarkı kimin',
  'sesini kıs biraz kafam şişti',
  'bunu geçen hafta dinlemiştik',
  'geçen sefer daha iyiydi',
  'sonraki maçta görüşürüz',
  'önceki tur çok kötüydü',
  'tekrar deneyelim mi',
  'baştan başlayalım mı oyunu',
  'karıştırma işte',
  'sıra bende mi',
  'kaç kişiyiz',
  'yüzde yüz eminim',
  'otuz saniye kaldı',
  'bir dakika bekleyin',
  'ileri gidiyorum',
  'geri gelin geri',
  'ses yok',
  'ses geliyor mu',
  'kanalı değiştir',
  'bot gibi oynuyorsun',
  'hey bot musun sen',
  'evet bu bot geç kaldı',
  'şey ay bitti mi',
  'tamam abi',
  'hadi gidelim',
  'aç kapıyı',
  'çal kapıyı',
  'koy şuraya',
  'atla atla',
  'zıpla',
  'çömel',
  'ışığı aç',
  'çok güzel çalıyor',
  'iyi çalıyorsun',
  'gitar çalıyor musun',
  'piyano çalmayı biliyorum',
  // with the wake phrase, but not a command
  'Kutluay bot çok güzel çalıyor',
  'Kutluay bot naber',
  'Kutluay bot sen harikasın',
  'Kutluay bot nasılsın',
  'Kutluay bot teşekkürler',
  'Kutluay bot bu şarkı çok iyi',
  'Kutluay bot sesin çok güzel',
  'Kutluay bot ne zaman geldin',
  'Kutluay bot uyuyor musun',
  'Kutluay bot bizi dinliyor mu',
  'Kutluay bot bunu sevdim',
  'Kutluay bot çok yaşa',
  'Kutluay bot sen de oyna',
  'Kutluay bot kimin botu',
  'Kutluay bot hangi oyunu oynuyoruz',
  'Kutluay bot bugün hava nasıl',
  'Kutluay bot saat kaç',
  'Kutluay bot bizim takım kazanır mı',
  'Kutluay bot şaka yapıyorum',
  'Kutluay bot iyi geceler',
  'Kutluay bot günaydın',
  'Kutluay bot burada mısın',
  'Kutluay bot beni duyuyor musun',
  'Kutluay bot harika',
  'Kutluay bot sevdim seni',
  'Kutluay bot bu ne biçim şarkı',
  'Kutluay bot hiç fena değil',
  'Kutluay bot sen bir dahisin',
  'Kutluay bot neden sustun',
  'Kutluay bot bir şey söyle',
  'Kutluay bot bekle bir dakika şimdi değil',
  'Kutluay bot geçen hafta neredeydin',
  'Kutluay bot kaç yaşındasın',
  'Kutluay bot sesi çok güzel değil mi',
  'Kutluay bot bunu kim yaptı',
  'Kutluay bot kapıyı aç',
  'Kutluay bot oyunu aç',
  'Kutluay bot kamerayı aç',
  'Kutluay bot mikrofonu kapat lütfen değil şaka',
  // sound and seeking talk that is not a command
  'sesin kapalı mı abi',
  'sesi kapattın mı',
  'sesim kapalı galiba',
  'ses çok açık',
  'ileri gidelim mi',
  'geri dönelim',
  'geri dönelim mi',
  'biraz ileri git de bakalım',
  'ileriye bakalım',
  'geri çekilelim',
  'geri sayım başladı',
  'Kutluay bot sesin kapalı mı abi',
  'Kutluay bot ileri gidelim mi',
  'Kutluay bot geri dönelim',
  'Kutluay bot sesi kapattın mı',
  'Kutluay bot ses çok açık',
  'Kutluay bot ileri gitmeyelim',
  'Kutluay bot sessiz olun biraz',
  'Kutluay bot sesi kapatmayın',
  'Kutluay bot geri dönmeyelim',
  'Kutluay bot iki dakika sonra gelirim',
];

describe('sesli komut kalıpları: niyetler', () => {
  for (const [tur, list] of Object.entries(SOYLEYISLER)) {
    it(`${tur}: ${list.length} söyleyiş`, () => {
      assert.ok(list.length >= 5);
      for (const rest of list) assert.equal(niyet(rest)?.tur, tur, rest);
    });
  }

  it('değerler: sorgu, liste adı, ses, süre, sıra', () => {
    assert.deepEqual(niyet("Tarkan'ı sıraya ekle"), { tur: 'kuyruga-ekle', sorgu: 'tarkan' });
    assert.deepEqual(niyet('gece listemi çal'), { tur: 'liste-cal', ad: 'gece' });
    assert.deepEqual(niyet('sesi yüzde elli yap'), { tur: 'ses-ayarla', seviye: 50 });
    assert.deepEqual(niyet('sesi sonuna kadar aç'), { tur: 'ses-ayarla', seviye: 100 });
    assert.deepEqual(niyet('bir buçuk dakika ileri sar'), { tur: 'sar-ileri', ms: 90_000 });
    assert.deepEqual(niyet('yarım dakika geri git'), { tur: 'sar-geri', ms: 30_000 });
    assert.deepEqual(niyet('sıradaki 2. şarkıyı çal'), { tur: 'siraya-atla', sira: 2 });
    assert.equal(niyet('sesi 300 yap').tur, 'anlasilmadi', 'out of range');
  });

  it('"sesi kapat" ve benzerleri KAPAT (kuyruğu temizle) olmaz: ses niyetidir', () => {
    for (const rest of ['sesi kapat', 'sesi kes', 'sesi sustur', 'sessize al', 'sesi sıfırla', 'sesi tamamen kıs']) {
      assert.deepEqual(niyet(rest), { tur: 'sessiz' }, rest);
      assert.notEqual(niyet(rest).tur, 'kapat', rest);
    }
    // "kapat" without "ses" stays what it was
    assert.equal(niyet('kapat').tur, 'kapat');
    assert.equal(niyet('müziği kapat').tur, 'kapat');
    assert.equal(niyet('müziği kes').tur, 'duraklat');
    assert.equal(niyet('sus').tur, 'duraklat');
    assert.equal(niyet('sesi geri aç').tur, 'sesi-geri-ac');
    assert.equal(niyet('sesi aç').tur, 'ses-ac');
  });

  it('sarma: süreli, süresiz (varsayılan 10 sn) ve çeşitli süre yazımları', () => {
    assert.deepEqual(niyet('30 saniye ileri al'), { tur: 'sar-ileri', ms: 30_000 });
    assert.deepEqual(niyet('otuz saniye ileri al'), { tur: 'sar-ileri', ms: 30_000 });
    assert.deepEqual(niyet('yarım dakika ileri'), { tur: 'sar-ileri', ms: 30_000 });
    assert.deepEqual(niyet('1 dakika geri al'), { tur: 'sar-geri', ms: 60_000 });
    assert.deepEqual(niyet('bir buçuk dakika ileri'), { tur: 'sar-ileri', ms: 90_000 });
    assert.deepEqual(niyet('on saniyelik ileri'), { tur: 'sar-ileri', ms: 10_000 });
    assert.deepEqual(niyet('biraz ileri al'), { tur: 'sar-ileri', ms: 10_000 });
    assert.deepEqual(niyet('ileri al'), { tur: 'sar-ileri', ms: 10_000 });
    assert.deepEqual(niyet('öne al'), { tur: 'sar-ileri', ms: 10_000 });
    assert.deepEqual(niyet('geri sar'), { tur: 'sar-geri', ms: 10_000 });
    assert.deepEqual(niyet('geri git'), { tur: 'sar-geri', ms: 10_000 });
    assert.deepEqual(niyet('geriye al'), { tur: 'sar-geri', ms: 10_000 });
    for (const verb of ['al', 'at', 'geç', 'sar', 'atla']) {
      assert.equal(niyet(`ileri ${verb}`).tur, 'sar-ileri', verb);
    }
    assert.equal(niyet('ilerlet').tur, 'sar-ileri');
  });

  it('"geri dön" belirsizliği: süre varsa sarma, yoksa önceki şarkı', () => {
    assert.deepEqual(niyet('geri dön'), { tur: 'onceki' });
    assert.deepEqual(niyet('geri al'), { tur: 'onceki' });
    assert.deepEqual(niyet('10 saniye geri dön'), { tur: 'sar-geri', ms: 10_000 });
    assert.deepEqual(niyet('geri dön 20 saniye'), { tur: 'sar-geri', ms: 20_000 });
    assert.deepEqual(niyet('yarım dakika geri al'), { tur: 'sar-geri', ms: 30_000 });
  });

  it('mutlak konuma git: değerler', () => {
    assert.deepEqual(niyet('1 dakika 30 saniyeye git'), { tur: 'sar-konum', ms: 90_000 });
    assert.deepEqual(niyet("2:30'a al"), { tur: 'sar-konum', ms: 150_000 });
    assert.deepEqual(niyet('ikinci dakikaya git'), { tur: 'sar-konum', ms: 120_000 });
    assert.deepEqual(niyet('otuz saniyeye git'), { tur: 'sar-konum', ms: 30_000 });
    assert.equal(parseKonum(kat('30 saniye')), null, 'no ending: a duration, not a position');
  });

  it('ses: yüzde ve ek yazımları', () => {
    assert.deepEqual(niyet("sesi yüzde 40'a çek"), { tur: 'ses-ayarla', seviye: 40 });
    assert.deepEqual(niyet('sesi yüzde elliye getir'), { tur: 'ses-ayarla', seviye: 50 });
    assert.deepEqual(niyet('sesi düşür'), { tur: 'ses-kis', adim: -20 });
    assert.deepEqual(niyet('sesi biraz yükselt'), { tur: 'ses-ac', adim: 20 });
  });

  it('şarkıya özgü sözcükler sorgu sayılmaz; "<sıra> şarkıyı çal" şarkı adı değildir', () => {
    assert.equal(niyet('üçüncü şarkıyı çal').tur, 'siraya-atla');
    assert.equal(niyet('şarkıyı aç').tur, 'devam');
    assert.equal(niyet('sesi aç').tur, 'ses-ac');
  });
});

describe('sesli komut kalıpları: Türkçe sayılar', () => {
  it('sayılar', () => {
    const cases = {
      bir: 1,
      on: 10,
      'on beş': 15,
      'yirmi beş': 25,
      elli: 50,
      yüz: 100,
      'yüz elli': 150,
      30: 30,
      elliye: 50,
      yetmişe: 70,
    };
    for (const [text, value] of Object.entries(cases)) assert.equal(parseNumber(kat(String(text))), value, text);
    assert.equal(parseNumber(kat('%50')), 50);
    for (const bad of ['beş on', 'elli yüz', 'şarkı', '', 'bir iki']) assert.equal(parseNumber(kat(bad)), null, bad);
  });

  it('süreler', () => {
    const cases = {
      'otuz saniye': 30_000,
      '1 dakika': 60_000,
      'yarım dakika': 30_000,
      'bir buçuk dakika': 90_000,
      '90 sn': 90_000,
      'iki dakika on saniye': 130_000,
      'on beş saniye': 15_000,
    };
    for (const [text, ms] of Object.entries(cases)) assert.equal(parseDuration(kat(text)), ms, text);
    for (const bad of ['otuz', 'dakika', 'iki saat', 'çok saniye']) assert.equal(parseDuration(kat(bad)), null, bad);
  });

  it('sıra sayıları', () => {
    const cases = {
      birinci: 1,
      ilk: 1,
      ikinci: 2,
      üçüncü: 3,
      üçüncüsü: 3,
      üçüncüye: 3,
      dördüncüsüne: 4,
      onuncu: 10,
      'on ikinci': 12,
      3: 3,
    };
    for (const [text, n] of Object.entries(cases)) assert.equal(parseOrdinal(kat(String(text))), n, text);
    assert.equal(parseOrdinal(kat('3.')), 3);
    for (const bad of ['şarkı', '0', 'yüzüncü yüzüncü']) assert.equal(parseOrdinal(kat(bad)), null, bad);
  });
});

describe('sesli komut kalıpları: belirsizlik ve öneri', () => {
  it('iki niyete uyan bir yazım hatası uygulanmaz: "anlamadım" ve öneri', () => {
    const result = parseCommand(words('tekrarlam'));
    assert.equal(result.tur, 'anlasilmadi');
    assert.equal(result.belirsiz, true);
  });

  it('yakın ama tutmayan bir cümlede "... mı dediniz?" önerisi', () => {
    const utt = (text) => ({ text, nsp: 0.01, cr: 1 });
    assert.deepEqual(degerlendir(utt('Kutluay bot, sesi kıss'), K).oneri, 'sesi kıs');
    assert.equal(degerlendir(utt('Kutluay bot, döngüyü kapatt'), K).oneri, 'döngüyü kapat');
    assert.equal(degerlendir(utt('Kutluay bot, naber'), K).oneri, null);
    // opposite intents are never suggested for each other
    assert.notEqual(degerlendir(utt('Kutluay bot, sustur'), K).oneri, 'sürdür');
    assert.notEqual(degerlendir(utt('Kutluay bot, durdurr'), K).oneri, 'sürdür');
  });
});

describe('sesli komut kalıpları: sohbet korpusu', () => {
  it(`${SOHBET.length} oyun sohbeti cümlesinde 0 yanlış komut (uyandırma sözüyle başlayanlar dahil)`, () => {
    assert.ok(SOHBET.length >= 100);
    const wrong = [];
    for (const text of SOHBET) {
      for (const wake of [K, 'müzik bot']) {
        const found = cozumle(text, wake);
        if (found && found.niyet.tur !== 'anlasilmadi') wrong.push(`${text} => ${JSON.stringify(found.niyet)}`);
      }
    }
    assert.deepEqual(wrong, []);
  });
});
