// Niyet çözücü: Whisper'ın yazdığı metinden uyandırma sözünü ve komutu çıkarır. Saf işlevler; ses ya da Discord
// bilmez (test/sesli-komut-niyet.test.js). Komut tablosu komutlar.js'te. Normalde bu dosyaya dokunmana gerek yok.
//
// Kurallar (karar.md, 6. madde):
//   konum      uyandırma sözü ilk 3 kelimede başlar; normalize metinde Levenshtein ≤ 2 (kısa sözde daha az);
//              konuşmanın başındaki ilk hecenin düşmesi (Discord'un ilk paketleri) tolere edilir
//   sözdizimi  kontrol komutunda kalan ≤ 3 kelime; çalma komutunda fiil sonda, sorgu ≥ 2 harf ve yalnız kontrol
//              kelimelerinden oluşmaz
//   tek komut  bir cümlede birden fazla uyandırma sözü varsa yalnız ilk komut alınır (ikinci söze ya da ilk
//              cümle sonuna kadar)

import { AD_EKLERI, AD_OLAMAZ, DOLGU, KALIPLAR } from './kaliplar.js';
import { SARMA_ADIMI, SES_ADIMI } from './komutlar.js';
import { parseDuration, parseKonum, parseNumber, parseOrdinal } from './sayilar.js';

const TR_LOWER = { I: 'ı', İ: 'i' };
const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
const VOWELS = new Set('aeiou');
const SENTENCE_END = /[.!?…;]+/;

/** Turkish lower case (I → ı, İ → i), whatever the runtime locale. */
export const trLower = (text) =>
  String(text ?? '')
    .replace(/[Iİ]/g, (c) => TR_LOWER[c])
    .toLowerCase();

/** One word without Turkish letters and marks: "Müziği" → "muzigi". */
export function fold(word) {
  return trLower(word)
    .replace(/[çğıöşüâîû]/g, (c) => FOLD[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

/**
 * Words of a text, each { soz: as written (lower case, for search queries), kat: folded (for matching),
 * cumle: sentence index }. Punctuation splits words ("Kutlay'ıp" → "kutlay", "ıp").
 */
export function words(text) {
  const out = [];
  String(text ?? '')
    .replace(/(\d)\.(?=\s|$)/g, '$1 ') // "3. şarkı" is an ordinal, not the end of a sentence
    .split(SENTENCE_END)
    .forEach((sentence, cumle) => {
      for (const raw of trLower(sentence).split(/[^\p{L}\p{N}]+/u)) {
        if (raw) out.push({ soz: raw, kat: fold(raw), cumle });
      }
    });
  return out;
}

/** Edit distance (insert, delete, substitute; each 1). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The wake phrase without its first syllable ("muzikbot" → "zikbot", "kutluaybot" → "luaybot"). */
export function dropFirstSyllable(word) {
  let v = 0;
  while (v < word.length && !VOWELS.has(word[v])) v++;
  if (v >= word.length - 1) return '';
  const next = word[v + 1];
  const after = word[v + 2];
  // CV + consonant-vowel → the syllable ends after the vowel; a consonant cluster keeps one consonant.
  const end = !VOWELS.has(next) && after !== undefined && VOWELS.has(after) ? v + 1 : v + 2;
  return word.slice(end);
}

/** What the matcher needs of a wake phrase ("Müzik bot" → full "muzikbot", last "bot"). */
export function wakeOf(phrase) {
  const parts = words(phrase).map((w) => w.kat);
  const full = parts.join('');
  return {
    full,
    parts,
    last: parts.length > 1 ? parts.at(-1) : null,
    dropped: dropFirstSyllable(full),
    maxDist: Math.min(2, Math.floor(full.length / 4)),
  };
}

/**
 * Words people (or Whisper) put before the wake phrase: "hey kutluay bot", "tamam, müzik bot". They are skipped
 * at the start of the sentence; the "first 3 words" rule counts after them.
 */
export const UYANDIRMA_ONCESI = Object.freeze(['hey', 'ey', 'hop', 'sey', 'evet', 'tamam', 'bak', 'abi']);
const BEFORE_WAKE = new Set(UYANDIRMA_ONCESI);

/**
 * Ordinary Turkish words (and English ones heard in games) that may look like the end of a wake word: a cut-off
 * wake phrase is never accepted when the remnant is one of them ("vay bot geç", "kolay bot kapat").
 */
export const SIRADAN_KELIMELER = Object.freeze([
  'vay',
  'hay',
  'bay',
  'tay',
  'say',
  'yay',
  'kay',
  'pay',
  'cay',
  'lay',
  'may',
  'nay',
  'ray',
  'way',
  'hey',
  'okay',
  'kolay',
  'olay',
  'dolay',
  'alay',
  'kalay',
  'bilay',
  'aday',
  'oday',
  'kuray',
  'turay',
  'sinay',
  'kanay',
  'bot',
  'botu',
  'bota',
  'abi',
  'aga',
  'kanka',
  'dur',
  'gel',
  'git',
  'bak',
  'ver',
  'tut',
  'vur',
  'kac',
  'cik',
  'iyi',
  'kotu',
  'tamam',
  'evet',
  'hayir',
  'yok',
  'var',
  'cok',
  'az',
  'ben',
  'sen',
  'biz',
  'siz',
  'onlar',
  'bunu',
  'sunu',
  'onu',
  'neden',
  'nasil',
  'niye',
  'hangi',
  'kim',
  'kimi',
  'zik',
  'mizik',
  'tik',
  'lik',
  'ik',
  'ilk',
  'son',
  'yeni',
  'eski',
  'buyuk',
  'kucuk',
  'uzun',
  'kisa',
  'hizli',
  'yavas',
  'oyun',
  'maci',
  'mac',
  'tur',
  'el',
  'set',
  'ses',
  'sesi',
  'muzik',
  'sarki',
  'radyo',
  'play',
  'stay',
  'today',
  'friday',
  'bayram',
  'yarim',
  'tam',
]);
const ORDINARY_WORDS = new Set(SIRADAN_KELIMELER);

/** For a multi-word wake phrase the candidate must end like its last word ("bot", "bota", "botu"). */
function tailOk(candidate, last) {
  if (!last || last.length < 3) return true;
  for (let suffix = 0; suffix <= 2; suffix++) {
    const end = candidate.length - suffix;
    if (end < last.length) break;
    if (levenshtein(candidate.slice(end - last.length, end), last) <= 1) return true;
  }
  return false;
}

/**
 * The start of the wake phrase cut off: Discord's voice activity opens the microphone late and swallows the
 * first syllable(s) ("kutluay bot" heard as "tluay bot", "luay bot", "uay bot"). Only at the very start of the
 * sentence, and against false wake-ups:
 *   - several words: the first word may lose its start down to its last 2 letters (measured: Whisper writes a
 *     cut "Kutluay bot" as "tluay bot", "luay bot", "ay bot"; one typo allowed when 4+ letters stay), the other
 *     words must match exactly ("bot", not "bu");
 *   - one word: only the first syllable, and the rest exactly.
 * @returns {number|null} the distance (1 = cut only, 2 = cut and one typo) or null
 */
function truncatedMatch(list, start, end, wake) {
  const got = list.slice(start, end).map((w) => w.kat);
  const { parts } = wake;
  if (parts.length === 1) {
    return got.length === 1 && wake.dropped.length >= 4 && got[0] === wake.dropped ? 1 : null;
  }
  // The other words exactly, as separate words ("luay bot") or glued to the cut first word ("luaybot").
  let head;
  if (got.length === parts.length && got.slice(1).every((w, k) => w === parts[k + 1])) head = got[0];
  else if (got.length === 1 && got[0].endsWith(parts.slice(1).join('')))
    head = got[0].slice(0, got[0].length - parts.slice(1).join('').length);
  else return null;
  const first = parts[0];
  // At least 3 letters of the first word stay, exactly its ending ("luay", "tluay", "uay"; one typo only when 5+
  // letters stay), and the remnant is not an ordinary word ("ay", "vay", "hay", "kolay", "okay": people say
  // "<word> bot" to each other in games).
  if (!head || head.length < 3 || head.length >= first.length || first.length < 4) return null;
  if (ORDINARY_WORDS.has(head)) return null;
  const kept = first.slice(first.length - head.length);
  if (head === kept) return 1;
  if (head.length >= 5 && levenshtein(head, kept) <= 1) return 2;
  return null;
}

/**
 * Finds the wake phrase in a list of words.
 * @param {{kat: string}[]} list from words()
 * @param {ReturnType<typeof wakeOf>} wake
 * @param {{ from?: number, maxStart?: number, allowDrop?: boolean, skipFillers?: boolean }} options maxStart: last
 *   index it may start at (counted after the skipped words before the wake phrase)
 * @returns {{ start: number, end: number, dist: number, dropped: boolean } | null} end is exclusive
 */
export function findWake(list, wake, { from = 0, maxStart, allowDrop = from === 0, skipFillers = from === 0 } = {}) {
  if (!wake?.full) return null;
  let begin = from;
  if (skipFillers) while (begin < list.length && BEFORE_WAKE.has(list[begin].kat)) begin++;
  const last = Math.min(list.length - 1, maxStart ?? begin + 2);
  // The closest match wins ("aç kutluay bot" must not take "aç" as part of the wake phrase); ties: the earliest.
  let best = null;
  for (let i = begin; i <= last; i++) {
    let candidate = '';
    for (let j = i + 1; j <= Math.min(list.length, i + 4); j++) {
      candidate += list[j - 1].kat;
      if (candidate.length > wake.full.length + 3) break;
      if (tailOk(candidate, wake.last)) {
        const dist = levenshtein(candidate, wake.full);
        if (dist <= wake.maxDist && (!best || dist < best.dist)) best = { start: i, end: j, dist, dropped: false };
      }
      // A cut-off start only at the start of the sentence (after the words before the wake phrase).
      if (allowDrop && i === begin) {
        const cut = truncatedMatch(list, i, j, wake);
        if (cut !== null && (!best || cut < best.dist)) best = { start: i, end: j, dist: cut, dropped: true };
      }
    }
    if (best?.dist === 0) break;
  }
  return best;
}

const DOLGU_SET = new Set(DOLGU);
const SUFFIX_WORDS = new Set(AD_EKLERI);
const NOT_A_NAME = new Set(AD_OLAMAZ);
const MAX_LITERAL_WORDS = 6;

/** Same word, allowing one typo in long words ("karistir" / "karistr"); only on the second (fuzzy) pass. */
const sameWord = (a, b, fuzzy) => a === b || (fuzzy && a.length >= 6 && b.length >= 6 && levenshtein(a, b) <= 1);

/** "sesi|ses [yuzde] {sayi} yap" → [{ alts, opt } | { slot }] */
function compile(pattern) {
  return pattern.split(' ').map((raw) => {
    const slot = /^\{(\w+)\}$/.exec(raw);
    if (slot) return { slot: slot[1] };
    const opt = raw.startsWith('[') && raw.endsWith(']');
    return { alts: (opt ? raw.slice(1, -1) : raw).split('|'), opt };
  });
}

/** Every intent with its compiled patterns and folded examples, in priority order. */
export const NIYETLER = KALIPLAR.map((k) => ({
  ...k,
  derli: k.kaliplar.map(compile),
  katli: k.ornekler.map((o) =>
    words(o)
      .map((w) => w.kat)
      .join(' '),
  ),
}));

/** A song or list name: what is left after Whisper's split-off endings, with at least one real word. */
function nameOf(list, { listName = false } = {}) {
  let end = list.length;
  while (end > 1 && SUFFIX_WORDS.has(list[end - 1].kat)) end--;
  let start = 0;
  while (start < end - 1 && DOLGU_SET.has(list[start].kat)) start++;
  const name = list.slice(start, end);
  // A list may be called "oyun"; a song query of only such words is not a song ("oyunu aç").
  const blocked = (w) => DOLGU_SET.has(w.kat) || (!listName && NOT_A_NAME.has(w.kat));
  if (!name.length || name.every(blocked)) return null;
  const text = name.map((w) => w.soz).join(' ');
  return text.replace(/\P{L}/gu, '').length >= 2 ? text : null;
}

const SLOT_PARSERS = {
  sorgu: (list) => nameOf(list),
  ad: (list) => nameOf(list, { listName: true }),
  sayi: (list) => parseNumber(list.map((w) => w.kat)),
  sure: (list) => parseDuration(list.map((w) => w.kat)),
  sira: (list) => parseOrdinal(list.map((w) => w.kat)),
  konum: (list) => parseKonum(list.map((w) => w.kat)),
};
const SLOT_MAX = { sorgu: 12, ad: 6, sayi: 4, sure: 7, sira: 2, konum: 7 };

/**
 * Matches the whole list against one compiled pattern. Fillers may be skipped between tokens (never inside a
 * name). Returns the slot values, or null.
 */
function matchPattern(tokens, list, fuzzy) {
  let literals = 0;
  const walk = (ti, wi, slots) => {
    if (ti === tokens.length) {
      for (let k = wi; k < list.length; k++) if (!DOLGU_SET.has(list[k].kat)) return null;
      return slots;
    }
    const token = tokens[ti];
    if (token.slot) {
      const max = Math.min(list.length - wi, SLOT_MAX[token.slot]);
      for (let len = 1; len <= max; len++) {
        const value = SLOT_PARSERS[token.slot](list.slice(wi, wi + len));
        if (value === null || value === undefined) continue;
        const found = walk(ti + 1, wi + len, { ...slots, [token.slot]: value });
        if (found) return found;
      }
    } else {
      if (wi < list.length && token.alts.some((alt) => sameWord(list[wi].kat, alt, fuzzy))) {
        literals++;
        const found = walk(ti + 1, wi + 1, slots);
        if (found) return found;
      }
      if (token.opt) {
        const found = walk(ti + 1, wi, slots);
        if (found) return found;
      }
    }
    if (wi < list.length && DOLGU_SET.has(list[wi].kat)) return walk(ti, wi + 1, slots);
    return null;
  };
  const slots = walk(0, 0, {});
  return slots && literals <= MAX_LITERAL_WORDS * 4 ? slots : null;
}

/** The command an intent and its slot values stand for, or null when a value is out of range. */
function commandOf(niyet, slots) {
  switch (niyet) {
    case 'cal':
    case 'kuyruga-ekle':
    case 'hemen-cal':
      return { tur: niyet, sorgu: slots.sorgu };
    case 'liste-cal':
      return { tur: niyet, ad: slots.ad };
    case 'ses-ayarla':
      return slots.sayi >= 1 && slots.sayi <= 150 ? { tur: niyet, seviye: slots.sayi } : null;
    case 'ses-tam':
      return { tur: 'ses-ayarla', seviye: 100 };
    case 'ses-kis':
      return { tur: niyet, adim: -SES_ADIMI };
    case 'ses-ac':
      return { tur: niyet, adim: SES_ADIMI };
    case 'sar-ileri':
    case 'sar-geri': {
      // No duration said ("ileri al", "biraz geri sar"): the default step.
      const ms = slots.sure ?? SARMA_ADIMI;
      return ms > 0 && ms <= 6 * 3_600_000 ? { tur: niyet, ms } : null;
    }
    case 'sar-konum':
      return slots.konum > 0 && slots.konum <= 6 * 3_600_000 ? { tur: niyet, ms: slots.konum } : null;
    case 'siraya-atla':
      return slots.sira >= 1 ? { tur: niyet, sira: slots.sira } : null;
    default:
      return { tur: niyet };
  }
}

/** All intents (one result each) whose patterns match the list. */
function matches(list, { fuzzy, yedek }) {
  const found = [];
  for (const n of NIYETLER) {
    if (Boolean(n.yedek) !== yedek) continue;
    for (const tokens of n.derli) {
      const slots = matchPattern(tokens, list, fuzzy);
      const command = slots && commandOf(n.niyet, slots);
      if (command) {
        found.push(command);
        break;
      }
    }
  }
  return found;
}

/** Word pairs that mean opposite things: one is never suggested for the other ("sustur" is not "sürdür"). */
const KARSIT_KELIMELER = [
  ['sustur', 'surdur'],
  ['durdur', 'surdur'],
  ['duraklat', 'surdur'],
  ['sus', 'surdur'],
];

function karsitMi(said, example) {
  const a = said.split(' ');
  const b = example.split(' ');
  return KARSIT_KELIMELER.some(
    ([x, y]) =>
      (a.includes(x) && b.includes(y) && !b.includes(x)) || (a.includes(y) && b.includes(x) && !b.includes(y)),
  );
}

/** The example closest to what was said, when it is close enough to ask "did you mean ...?". */
export function suggestion(list) {
  const said = list
    .filter((w) => !DOLGU_SET.has(w.kat))
    .map((w) => w.kat)
    .join(' ');
  if (!said) return null;
  let best = null;
  for (const n of NIYETLER) {
    if (n.yedek) continue;
    n.katli.forEach((example, i) => {
      if (karsitMi(said, example)) return;
      const dist = levenshtein(said, example);
      if (dist <= Math.max(2, Math.floor(example.length * 0.3)) && (!best || dist < best.dist))
        best = { dist, text: n.ornekler[i], niyet: n.niyet };
    });
  }
  return best ? best.text : null;
}

/**
 * The command in the words after the wake phrase: the whole sentence must match one intent's pattern.
 * Two different intents matching (or a typo that fits two) is ambiguous: nothing is done.
 * @returns {{ tur: string, ... } | { tur: 'anlasilmadi', belirsiz?: boolean, oneri: string|null }}
 */
export function parseCommand(list) {
  if (!list.length) return { tur: 'anlasilmadi', oneri: null };
  for (const fuzzy of [false, true]) {
    const found = matches(list, { fuzzy, yedek: false });
    const kinds = new Set(found.map((c) => c.tur));
    if (kinds.size > 1) return { tur: 'anlasilmadi', belirsiz: true, oneri: suggestion(list) };
    if (found.length) return found[0];
    if (!fuzzy) {
      const backup = matches(list, { fuzzy: false, yedek: true });
      if (backup.length) return backup[0];
    }
  }
  return { tur: 'anlasilmadi', oneri: suggestion(list) };
}

/**
 * Text → the first command after the wake phrase.
 * @param {string} text what Whisper wrote
 * @param {string|ReturnType<typeof wakeOf>} wakePhrase the server's wake phrase (or wakeOf() of it)
 * @param {{ kirpik?: boolean }} options kirpik: a cut-off start may be accepted (only with evidence, kapilar.js)
 * @returns {null | { uyandirma: { dist: number, dropped: boolean }, niyet: object, kelimeSayisi: number }}
 *   null when there is no wake phrase where it must be (the text is ignored, never logged)
 */
export function cozumle(text, wakePhrase, { kirpik = true } = {}) {
  const wake = typeof wakePhrase === 'string' ? wakeOf(wakePhrase) : wakePhrase;
  const list = words(text);
  const hit = findWake(list, wake, { allowDrop: kirpik });
  if (!hit) return null;
  let rest = list.slice(hit.end);
  // Only the first command: up to the next wake phrase ...
  const second = findWake(rest, wake, { from: 0, maxStart: rest.length, allowDrop: false });
  if (second) rest = rest.slice(0, second.start);
  // ... and up to the end of the first sentence that has words of the command.
  if (rest.length) rest = rest.filter((w) => w.cumle === rest[0].cumle);
  const uyandirma = {
    dist: hit.dist,
    dropped: hit.dropped,
    konum: hit.start,
    bulunan: list
      .slice(hit.start, hit.end)
      .map((w) => w.soz)
      .join(' '),
  };
  return { uyandirma, niyet: parseCommand(rest), kelimeSayisi: rest.length };
}
