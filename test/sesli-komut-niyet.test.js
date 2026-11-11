// Sesli komut: metin → niyet (uyandırma sözü, Türkçe komut tablosu, tek komut kuralı) ve kapılar
// (akustik, durum, çift kanıt). Örnek metinlerin çoğu faster-whisper'ın gerçek çıktılarıdır (TTS ve canlı test).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  akustikKapi,
  ayniNiyet,
  ciftKanitGerekir,
  degerlendir,
  durumKapisi,
} from '../src/ozellikler/sesli-komut/kapilar.js';
import { HOTWORDS } from '../src/ozellikler/sesli-komut/komutlar.js';
import { KALIPLAR } from '../src/ozellikler/sesli-komut/kaliplar.js';
import {
  cozumle,
  dropFirstSyllable,
  findWake,
  fold,
  levenshtein,
  wakeOf,
  words,
} from '../src/ozellikler/sesli-komut/niyet.js';

const K = 'Kutluay bot';
const M = 'müzik bot';
const niyet = (text, wake = K) => cozumle(text, wake)?.niyet ?? null;

describe('sesli komut: normalizasyon', () => {
  it('Türkçe küçük harf, harf katlama ve noktalama', () => {
    assert.equal(fold('MÜZİĞİ'), 'muzigi');
    assert.equal(fold('Işık'), 'isik');
    assert.equal(fold('KARIŞTIR'), 'karistir');
    assert.deepEqual(
      words("Kutlay'ıp, sesi kıs!").map((w) => w.kat),
      ['kutlay', 'ip', 'sesi', 'kis'],
    );
    assert.deepEqual(
      words('a. b').map((w) => w.cumle),
      [0, 1],
    );
  });

  it('Levenshtein ve ilk hecenin düşmesi', () => {
    assert.equal(levenshtein('kutluaybot', 'kutlaybot'), 1);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(dropFirstSyllable('muzikbot'), 'zikbot');
    assert.equal(dropFirstSyllable('kutluaybot'), 'luaybot');
  });
});

describe('sesli komut: uyandırma sözü', () => {
  it("Whisper'ın gerçek yazımları eşleşir", () => {
    for (const text of [
      'Kutluay bot, geç.',
      'Kutluaybot geç',
      'Kutlu Aybot, geç',
      'kutlu ay bot geç',
      'Kutlay bot geç',
      'Kutluay bota geç',
      'Kutluay botu geç',
    ]) {
      assert.deepEqual(niyet(text), { tur: 'gec' }, text);
    }
    for (const text of ['Müzik bot, geç', 'müzikbot geç', 'Müzik botu geç', 'Muzik bot geç']) {
      assert.deepEqual(niyet(text, M), { tur: 'gec' }, text);
    }
  });

  it('ilk 3 kelimede olmalı; sonra söylenen ad yok sayılır', () => {
    assert.deepEqual(niyet('tamam müzik bot devam et', M), { tur: 'devam' });
    assert.deepEqual(niyet('o zaman müzik bot geç', M), { tur: 'gec' });
    assert.equal(cozumle('bu arada hani şey müzik bot geç', M), null);
  });

  it("konuşmanın başındaki ilk hece düşebilir (Discord'un ilk paketleri)", () => {
    const hit = cozumle('Luay bot geç', K);
    assert.deepEqual(hit.niyet, { tur: 'gec' });
    assert.equal(hit.uyandirma.dropped, true);
    assert.deepEqual(niyet('zik bot sesi kıs', M), { tur: 'ses-kis', adim: -20 });
    // Only at the very start of the sentence.
    assert.equal(cozumle('bu arada luay bot geç', K), null);
  });

  it('benzer gündelik sözler uyandırmaz', () => {
    for (const text of [
      'Müzik çok güzelmiş, kim açtı bunu?',
      'Abi şu tarafa geç arkadan geliyorlar.',
      'Tamam devam edelim bir el daha.',
      'müzik kutusu nerede',
      'İzlediğiniz için teşekkür ederim.',
    ]) {
      assert.equal(cozumle(text, M), null, text);
      assert.equal(cozumle(text, K), null, text);
    }
    assert.equal(cozumle('Kutluay bu geç!', K), null, 'an unclear last word is not "bot"');
  });

  it('kısa bir uyandırma sözünde hata payı daralır', () => {
    assert.equal(wakeOf('dj').maxDist, 0);
    assert.equal(wakeOf('bot').maxDist, 0);
    assert.equal(wakeOf('müzik bot').maxDist, 2);
    assert.equal(findWake(words('hey bot geç'), wakeOf('bot'))?.start, 1);
    assert.equal(findWake(words('hey bat geç'), wakeOf('bot')), null);
  });
});

describe('sesli komut: kırpılmış uyandırma ve öndeki dolgular', () => {
  it('ilk kelimenin başı kesilse de (Discord ses etkinliği) "bot" tamsa ve cümle başındaysa uyanır', () => {
    for (const text of ['tluay bot geç', 'luay bot geç', 'uay bot geç', 'Luaybot, geç', 'Tluay bot geç.']) {
      const hit = cozumle(text, K);
      assert.deepEqual(hit?.niyet, { tur: 'gec' }, text);
      assert.equal(hit.uyandirma.dropped, true, text);
    }
    assert.equal(cozumle('luay bot geç', K).uyandirma.bulunan, 'luay bot');
    // Other wake phrases follow the same rule (a server setting).
    assert.deepEqual(niyet('zik bot geç', M), { tur: 'gec' });
    assert.deepEqual(niyet('ik bot geç', 'dj bot'), null);
    assert.deepEqual(cozumle('mbot geç', 'dj mbot'), null, 'too short a head');
  });

  it('kalıntı sıradan bir kelimeyse ya da 3 harften kısaysa uyanmaz ("vay bot", "kolay bot")', () => {
    for (const text of [
      'vay bot geç',
      'hay bot sus',
      'kolay bot kapat',
      'okay bot dur',
      'ay bot geç',
      'Aybot geç',
      'olay bot geç',
      'dolay bot durdur',
      'bay bot geç',
      'ay bot sesi kıs',
      'vay bot sesi kıs',
    ])
      assert.equal(cozumle(text, K), null, text);
  });

  it('kırpık eşleşme yalnız sesin baştan kesildiğine dair kanıtla (VAD başlangıcı ≤ 150 ms, yapay bölme değil)', () => {
    const utt = (text, vad) => ({ text, nsp: 0.01, cr: 1, vad });
    const cut = { onsetMs: 0, yapay: false };
    assert.equal(degerlendir(utt('luay bot geç', cut), K).niyet?.tur, 'gec');
    assert.equal(degerlendir(utt('tluay bot durdur', { onsetMs: 128 }), K).niyet?.tur, 'duraklat');
    assert.equal(
      degerlendir(utt('luay bot geç', { onsetMs: 600 }), K).neden,
      'uyandirma',
      'silence before it: not cut',
    );
    assert.equal(degerlendir(utt('luay bot geç', { onsetMs: 0, yapay: true }), K).neden, 'uyandirma', '10 s split');
    assert.equal(degerlendir(utt('luay bot geç'), K).neden, 'uyandirma', 'no evidence');
    assert.equal(degerlendir(utt('Kutluay bot geç', { onsetMs: 900 }), K).niyet?.tur, 'gec', 'the whole phrase always');
    // A cut-off match always needs the second pass, and never answers "anlamadım".
    const hit = degerlendir(utt('luay bot sırada ne var', cut), K);
    assert.equal(ciftKanitGerekir(hit.niyet, hit.uyandirma), true);
    assert.equal(degerlendir(utt('luay bot da var ne', cut), K).sonuc, 'yoksay');
  });

  it('kırpılmışta ikinci kelime tam olmalı, en az 3 harf kalmalı, yalnız cümle başında', () => {
    for (const text of [
      'luay bu geç',
      'luay but geç',
      'uy bot geç',
      'y bot geç',
      'bu arada luay bot geç',
      'çok luay bot geç',
    ])
      assert.equal(cozumle(text, K), null, text);
  });

  it('tek kelimelik sözde yalnız ilk hece düşebilir ve gerisi tam olmalı', () => {
    const W = 'kutluaybot';
    assert.equal(cozumle('luaybot geç', W)?.uyandirma?.dropped, true);
    assert.equal(cozumle('uaybot geç', W), null);
    assert.equal(cozumle('luaybat geç', W), null);
  });

  it('öndeki "hey, tamam, şey, evet, bak, abi" atlanır; ilk 3 kelime onlardan sonra sayılır', () => {
    for (const text of [
      'Hey Kutluay bot, geç',
      'Tamam, Kutluay bot geç',
      'Şey, evet, abi Kutluay bot geç',
      'hey luay bot geç',
    ])
      assert.deepEqual(niyet(text), { tur: 'gec' }, text);
    assert.equal(cozumle('Hey Kutluay bot, geç', K).uyandirma.konum, 1);
    assert.deepEqual(niyet('hey o zaman Kutluay bot geç'), { tur: 'gec' });
    assert.equal(cozumle('hey bu arada şimdi yani Kutluay bot geç', K), null);
  });

  it('gündelik cümleler kırpık eşleşmeyle de uyandırmaz', () => {
    for (const text of [
      'abi şu tarafa geç arkadan geliyorlar',
      'müzik çok güzelmiş kim açtı bunu',
      'tamam devam edelim bir el daha',
      'bot gibi oynuyorsun',
      'hey bot musun sen',
      'şey ay bitti mi',
      'evet bu bot geç kaldı',
    ]) {
      assert.equal(cozumle(text, K), null, text);
      assert.equal(cozumle(text, M), null, text);
    }
  });
});

describe('sesli komut: komut tablosu', () => {
  it('kontrol komutları ve dolgu kelimeleri', () => {
    const cases = {
      'müziği durdur': { tur: 'duraklat' },
      'lütfen durdur': { tur: 'duraklat' },
      durdur: { tur: 'duraklat' },
      'bi dur': { tur: 'duraklat' },
      'müziği kapat': { tur: 'kapat' },
      kapat: { tur: 'kapat' },
      sus: { tur: 'duraklat' },
      kes: { tur: 'duraklat' },
      'müziği bitir': { tur: 'kapat' },
      'kuyruğu temizle': { tur: 'kapat' },
      'şarkıyı geç': { tur: 'gec' },
      atla: { tur: 'gec' },
      'sonraki şarkı': { tur: 'gec' },
      duraklat: { tur: 'duraklat' },
      'devam et': { tur: 'devam' },
      'müziği aç': { tur: 'devam' },
      'sesi kıs': { tur: 'ses-kis', adim: -20 },
      'sesi biraz kıs': { tur: 'ses-kis', adim: -20 },
      'sesi aç': { tur: 'ses-ac', adim: 20 },
      'sesi artır': { tur: 'ses-ac', adim: 20 },
      'önceki şarkı': { tur: 'onceki' },
      karıştır: { tur: 'karistir' },
      'listeyi karıştır': { tur: 'karistir' },
      tekrarla: { tur: 'tekrarla' },
      karıştr: { tur: 'karistir' }, // one letter lost in a long word
    };
    for (const [rest, expected] of Object.entries(cases)) assert.deepEqual(niyet(`${K}, ${rest}`), expected, rest);
  });

  it('kontrol komutunda kalan en fazla 3 kelime', () => {
    assert.deepEqual(niyet(`${K}, şu müziği bir durdur lütfen`), { tur: 'duraklat' });
    assert.equal(niyet(`${K}, şarkıyı geç çünkü çok kötü`).tur, 'anlasilmadi');
  });

  it('çalma: fiil sonda, sorgu yazıldığı gibi (Türkçe harfleriyle)', () => {
    assert.deepEqual(niyet('Kutluay bot, Tarkan dudu dudu aç.'), { tur: 'cal', sorgu: 'tarkan dudu dudu' });
    assert.deepEqual(niyet('Kutluay bot Sezen Aksu gülümse çal'), { tur: 'cal', sorgu: 'sezen aksu gülümse' });
    assert.deepEqual(niyet('Müzik bot, Barış Manço çalar mısın', M), { tur: 'cal', sorgu: 'barış manço' });
    assert.deepEqual(niyet('Müzik bot, hadi bir Tarkan koy', M), { tur: 'cal', sorgu: 'tarkan' });
  });

  it('çalma sorgusu kontrol kelimelerinden ayrık ve en az 2 harf', () => {
    assert.deepEqual(
      niyet(`${K}, şarkıyı aç`),
      { tur: 'devam' },
      '"şarkıyı aç" is resume, not a song called "şarkıyı"',
    );
    assert.equal(niyet(`${K}, bunu aç`).tur, 'anlasilmadi');
    assert.equal(niyet(`${K}, a aç`).tur, 'anlasilmadi');
    assert.equal(niyet(`${K}, aç`).tur, 'anlasilmadi');
    assert.equal(niyet(`${K}, çok güzel`).tur, 'anlasilmadi');
  });

  it("tek cümlede birden çok uyandırma sözü: yalnız ilk komut (canlı testteki 9,6 sn'lik cümle)", () => {
    const canli =
      'Kutluay bot, Tarkan dudu dudu aç. Kutluay bot, müziği durdur. Kutluay bot, geç. Kutluay bot, sesi kıs.';
    assert.deepEqual(niyet(canli), { tur: 'cal', sorgu: 'tarkan dudu dudu' });
    // Without punctuation (as Whisper also writes it) and with a mangled second wake phrase.
    assert.deepEqual(niyet('Kutluay bot Tarkan dudu dudu aç Kutluay bot müziği durdur Kutluay bot geç'), {
      tur: 'cal',
      sorgu: 'tarkan dudu dudu',
    });
    assert.deepEqual(niyet('Kutluay bot tarkan dudududu aç, Kutluay bot müziği durdur, Kutlu ay bot geç'), {
      tur: 'cal',
      sorgu: 'tarkan dudududu',
    });
    assert.deepEqual(niyet('Kutluay bot geç. Kutluay bot sesi kıs.'), { tur: 'gec' });
    // A sentence end closes the command even without a second wake phrase.
    assert.deepEqual(niyet('Kutluay bot, duraklat. Sonra bakarız.'), { tur: 'duraklat' });
  });

  it('kalıp tablosundaki her örnek kendi niyetini verir ve hotwords komut cümlesi içermez', () => {
    for (const { niyet: tur, ornekler } of KALIPLAR) {
      assert.ok(ornekler.length >= 5, `${tur}: en az 5 örnek`);
      const expected = tur === 'ses-tam' ? 'ses-ayarla' : tur;
      for (const ornek of ornekler) assert.equal(niyet(`müzik bot ${ornek}`, M)?.tur, expected, ornek);
    }
    assert.ok(!HOTWORDS.includes(','), 'only single verbs');
    assert.ok(HOTWORDS.split(' ').length <= 16);
  });
});

describe('sesli komut: kapılar', () => {
  const utt = (text, extra = {}) => ({ text, nsp: 0.01, cr: 0.9, ...extra });

  it('akustik kapı: konuşma yok olasılığı ve sıkıştırma oranı', () => {
    assert.equal(akustikKapi({ nsp: 0.1, cr: 1.2 }), true);
    assert.equal(akustikKapi({ nsp: 0.35, cr: 1.2 }), false);
    assert.equal(akustikKapi({ nsp: 0.1, cr: 2.0 }), false);
    assert.equal(akustikKapi({}), false);
    assert.equal(degerlendir(utt('Kutluay bot geç', { nsp: 0.6 }), K).neden, 'akustik');
    assert.equal(degerlendir(utt('Kutluay bot geç geç geç geç geç geç', { cr: 2.6 }), K).neden, 'akustik');
    // Optional: the second pass is judged without it.
    assert.equal(degerlendir(utt('Kutluay bot geç', { nsp: 0.6 }), K, { akustik: false }).sonuc, 'niyet');
  });

  it('uyandırma yoksa yok sayılır; açık uyandırmada anlaşılmayan komut "anlamadım"', () => {
    assert.deepEqual(degerlendir(utt('müzik çok güzelmiş'), M), { sonuc: 'yoksay', neden: 'uyandirma' });
    assert.equal(degerlendir(utt('Kutluay bot da var ne?'), K).sonuc, 'anlamadim');
    // A loose match (two letters off, or a dropped syllable) stays silent rather than answering.
    assert.equal(degerlendir(utt('Kutlay ot, da var ne?'), K).sonuc, 'yoksay');
    // A cut-off start stays silent when no command follows (and without evidence it is no wake phrase at all).
    assert.equal(degerlendir(utt('Luay bot da var ne'), K).sonuc, 'yoksay');
    assert.deepEqual(degerlendir(utt('Kutluay bot geç'), K).niyet, { tur: 'gec' });
  });

  it('durum kapısı: oynatıcının durumuna uymayan komut', () => {
    const playing = { current: { title: 'a' }, paused: false, volume: 100, hasPrevious: false, queue: [] };
    const paused = { ...playing, paused: true };
    assert.equal(durumKapisi({ tur: 'kapat' }, null), false);
    assert.equal(durumKapisi({ tur: 'gec' }, null), false);
    assert.equal(durumKapisi({ tur: 'cal', sorgu: 'x' }, null), true);
    assert.equal(durumKapisi({ tur: 'kapat' }, playing), true);
    assert.equal(durumKapisi({ tur: 'kapat' }, paused), true);
    assert.equal(durumKapisi({ tur: 'duraklat' }, null), false);
    assert.equal(durumKapisi({ tur: 'duraklat' }, playing), true);
    assert.equal(durumKapisi({ tur: 'duraklat' }, paused), false);
    assert.equal(durumKapisi({ tur: 'devam' }, playing), false);
    assert.equal(durumKapisi({ tur: 'devam' }, paused), true);
    assert.equal(durumKapisi({ tur: 'onceki' }, playing), false);
    assert.equal(durumKapisi({ tur: 'karistir' }, { ...playing, queue: [1, 2] }), true);
    assert.equal(durumKapisi({ tur: 'ses-ac' }, { ...playing, volume: 150 }), false);
    assert.equal(durumKapisi({ tur: 'ses-kis' }, { ...playing, volume: 1 }), false);
    assert.equal(durumKapisi({ tur: 'bilinmeyen' }, playing), false);
  });

  it('çift kanıt: yalnız çalanı değiştiren komutlar; aynı niyet şart', () => {
    for (const tur of [
      'kapat',
      'gec',
      'duraklat',
      'ses-kis',
      'ses-ayarla',
      'sar-ileri',
      'sar-geri',
      'basa-sar',
      'siraya-atla',
      'tekrarla',
      'tekrar-liste',
      'dongu-kapat',
      'karistir',
      'otomatik-ac',
      'otomatik-kapat',
    ])
      assert.equal(ciftKanitGerekir({ tur }), true, tur);
    for (const tur of [
      'cal',
      'devam',
      'ses-ac',
      'onceki',
      'bilgi-calan',
      'bilgi-sira',
      'bilgi-sayi',
      'kuyruga-ekle',
      'hemen-cal',
      'liste-cal',
    ])
      assert.equal(ciftKanitGerekir({ tur }), false, tur);
    assert.equal(ayniNiyet({ tur: 'ses-ayarla', seviye: 30 }, { tur: 'ses-ayarla', seviye: 40 }), false, 'values too');
    assert.equal(ayniNiyet({ tur: 'sar-ileri', ms: 30000 }, { tur: 'sar-ileri', ms: 30000 }), true);
    assert.equal(ayniNiyet({ tur: 'gec' }, { tur: 'gec' }), true);
    assert.equal(ayniNiyet({ tur: 'gec' }, { tur: 'kapat' }), false);
    assert.equal(ayniNiyet({ tur: 'ses-kis', adim: -20 }, { tur: 'ses-kis', adim: -20 }), true);
    assert.equal(ayniNiyet({ tur: 'gec' }, null), false);
    // Real case: the second pass heard "kısıt" - the command is not applied.
    const second = degerlendir(utt('Kutluay bot sesi kısıt.'), K, { akustik: false });
    assert.equal(ayniNiyet({ tur: 'ses-kis', adim: -20 }, second.niyet), false);
  });
});

describe('sesli komut: sessiz ve konum kapıları', () => {
  const playing = { current: { title: 'a', duration: 200_000 }, queue: [], volume: 80 };
  it('sessiz: yalnız çalarken ve sessizde değilken; geri açma yalnız sessizdeyken; çift kanıt sessiz için', () => {
    assert.equal(durumKapisi({ tur: 'sessiz' }, playing), true);
    assert.equal(durumKapisi({ tur: 'sessiz' }, { ...playing, muted: true, volume: 0 }), false);
    assert.equal(durumKapisi({ tur: 'sessiz' }, null), false);
    assert.equal(durumKapisi({ tur: 'sesi-geri-ac' }, playing), false);
    assert.equal(durumKapisi({ tur: 'sesi-geri-ac' }, { ...playing, muted: true, volume: 0 }), true);
    assert.equal(ciftKanitGerekir({ tur: 'sessiz' }), true);
    assert.equal(ciftKanitGerekir({ tur: 'sar-konum' }), true);
    // sessizde "sesi aç" geçer (geri açma)
    assert.equal(durumKapisi({ tur: 'ses-ac' }, { ...playing, muted: true, volume: 0 }), true);
  });

  it('konuma git: şarkı süresinin dışı ve canlı yayın reddedilir', () => {
    assert.equal(durumKapisi({ tur: 'sar-konum', ms: 90_000 }, playing), true);
    assert.equal(durumKapisi({ tur: 'sar-konum', ms: 250_000 }, playing), false);
    assert.equal(durumKapisi({ tur: 'sar-konum', ms: 90_000 }, { ...playing, current: { isStream: true } }), false);
  });
});
