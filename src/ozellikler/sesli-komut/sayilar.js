// Türkçe sayı, süre ve sıra sayısı okuma (katlanmış kelimelerle: "uc", "yuz", "birinci"). Saf işlevler.
//   sayı   "elli", "yüz elli", "yirmi beş", "30", "yüzde 50" ("yüzde" kalıpta), "%50" (yüzde işareti kelimeye girmez)
//   süre   "otuz saniye", "1 dakika", "yarım dakika", "bir buçuk dakika", "90 sn", "iki dakika on saniye"
//   sıra   "birinci"/"ilk", "üçüncü", "üçüncüsü", "üçüncüye", "on ikinci", "3" ve "3." (nokta kelimeye girmez)

const UNITS = { sifir: 0, bir: 1, iki: 2, uc: 3, dort: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8, dokuz: 9 };
const TENS = { on: 10, yirmi: 20, otuz: 30, kirk: 40, elli: 50, altmis: 60, yetmis: 70, seksen: 80, doksan: 90 };
const ORDINAL_UNITS = {
  birinci: 1,
  ilk: 1,
  ikinci: 2,
  ucuncu: 3,
  dorduncu: 4,
  besinci: 5,
  altinci: 6,
  yedinci: 7,
  sekizinci: 8,
  dokuzuncu: 9,
};
const ORDINAL_TENS = { onuncu: 10, yirminci: 20, otuzuncu: 30, kirkinci: 40, ellinci: 50 };
/** Case endings Whisper glues to a number ("elliye", "yetmişe", "üçüncüsü", "üçüncüye"). */
const SUFFIXES = ['sune', 'sine', 'suna', 'sina', 'ye', 'ya', 'yi', 'yu', 'su', 'si', 'ne', 'na', 'e', 'a', 'i', 'u'];
const MAX = 1000;

/** A word as a number word, or with one case ending removed. */
function stripped(word, table) {
  if (Object.hasOwn(table, word)) return table[word];
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length + 1 && word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (Object.hasOwn(table, stem)) return table[stem];
    }
  }
  return undefined;
}

const digits = (word) => {
  const m = /^(\d{1,4})(?:ye|ya|e|a|yi|i|u|yu|ncu|nci|nci|uncu)?$/.exec(word);
  return m ? Number(m[1]) : undefined;
};

/** Words → a whole number (0..1000), or null when they are not exactly one number. */
export function parseNumber(words) {
  if (!words.length || words.length > 4) return null;
  if (words.length === 1) {
    const d = digits(words[0]);
    if (d !== undefined) return d <= MAX ? d : null;
  }
  let total = 0;
  let stage = 0; // 0: hundreds may come, 1: tens may come, 2: units may come, 3: done
  for (const [i, word] of words.entries()) {
    const last = i === words.length - 1;
    const table = { ...UNITS, ...TENS, yuz: 100 };
    const value = last ? stripped(word, table) : Object.hasOwn(table, word) ? table[word] : undefined;
    if (value === undefined) return null;
    if (value === 100) {
      if (stage > 0) return null;
      total += 100;
      stage = 1;
    } else if (value >= 10) {
      if (stage > 1) return null;
      total += value;
      stage = 2;
    } else {
      if (stage > 2 || (value === 0 && words.length > 1)) return null;
      total += value;
      stage = 3;
    }
  }
  return total;
}

const SECOND = /^(saniye|saniyelik|sn|saniyeyi)$/;
const MINUTE = /^(dakika|dakikalik|dk|dakikayi)$/;

/** Words → milliseconds, or null. Every word must belong to the duration. */
export function parseDuration(words) {
  if (!words.length || words.length > 7) return null;
  let total = 0;
  let i = 0;
  let parts = 0;
  while (i < words.length) {
    let amount = null;
    let j = i;
    if (words[i] === 'yarim') {
      amount = 0.5;
      j = i + 1;
    } else {
      // the longest number before a unit word
      for (let k = Math.min(words.length - 1, i + 4); k > i; k--) {
        const n = parseNumber(words.slice(i, k));
        if (n !== null) {
          amount = n;
          j = k;
          break;
        }
      }
    }
    if (amount === null) return null;
    if (words[j] === 'bucuk') {
      amount += 0.5;
      j++;
    }
    const unit = words[j];
    if (unit === undefined) return null;
    if (SECOND.test(unit)) total += amount * 1000;
    else if (MINUTE.test(unit)) total += amount * 60_000;
    else return null;
    i = j + 1;
    parts++;
  }
  return parts && total > 0 ? Math.round(total) : null;
}

/** Words → a position (1..100), or null. */
export function parseOrdinal(words) {
  if (!words.length || words.length > 2) return null;
  if (words.length === 1) {
    const d = digits(words[0]);
    if (d !== undefined) return d >= 1 && d <= 100 ? d : null;
    const unit = stripped(words[0], ORDINAL_UNITS);
    if (unit !== undefined) return unit;
    const ten = stripped(words[0], ORDINAL_TENS);
    return ten ?? null;
  }
  // "on ikinci", "yirmi üçüncü"
  const ten = TENS[words[0]];
  const unit = stripped(words[1], ORDINAL_UNITS);
  return ten && unit && words[1] !== 'ilk' ? ten + unit : null;
}

const DATIVE_UNIT = /^(saniye|dakika|sn|dk)(ye|ya|e|a)$/;
const CLOCK_ENDING = new Set(['a', 'e', 'ya', 'ye']);

/**
 * Words → an absolute position in ms, or null: "2:30'a" (words "2", "30", "a"), "1 dakika 30 saniyeye",
 * "ikinci dakikaya" (the 2nd minute = 2:00). A duration without the "-e/-a" ending is not a position.
 */
export function parseKonum(words) {
  if (!words.length || words.length > 7) return null;
  const clock = CLOCK_ENDING.has(words.at(-1)) ? words.slice(0, -1) : words;
  if (clock.length === 2 && /^\d{1,3}$/.test(clock[0]) && /^\d{2}$/.test(clock[1]) && Number(clock[1]) < 60) {
    const ms = (Number(clock[0]) * 60 + Number(clock[1])) * 1000;
    return ms > 0 ? ms : null;
  }
  const m = DATIVE_UNIT.exec(words.at(-1));
  if (!m) return null;
  const head = words.slice(0, -1);
  const byDuration = parseDuration([...head, m[1]]);
  if (byDuration !== null) return byDuration;
  if (m[1] === 'dakika' || m[1] === 'dk') {
    const nth = parseOrdinal(head);
    if (nth !== null) return nth * 60_000;
  }
  return null;
}
