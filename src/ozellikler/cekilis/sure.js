// "30dk", "2sa", "1g12sa" gibi süreleri milisaniyeye çevirir. Yalın sayı dakika sayılır ("90" = 90 dakika).

const MINUTE = 60_000;
export const SURE_EN_AZ_MS = MINUTE;
export const SURE_EN_FAZLA_GUN = 30;
export const SURE_EN_FAZLA_MS = SURE_EN_FAZLA_GUN * 24 * 60 * MINUTE;

// Tried longest first (see PART), so "dk" is not read as "d" + "k", nor "saat" as "sa" + "at".
const UNITS = [
  ['gün', 1440],
  ['gun', 1440],
  ['g', 1440],
  ['d', 1440],
  ['saat', 60],
  ['sa', 60],
  ['h', 60],
  ['dakika', 1],
  ['dk', 1],
  ['min', 1],
  ['m', 1],
];
const SPELLINGS = UNITS.map(([u]) => u).sort((a, b) => b.length - a.length);
const PART = new RegExp(`(\\d{1,5})(${SPELLINGS.join('|')})`, 'gy');

/** @returns {number|null} milliseconds, or null when the text is not a duration in range */
export function sureCoz(text) {
  const clean = String(text ?? '')
    .toLocaleLowerCase('tr')
    .replace(/\s+/g, '');
  if (!clean) return null;
  let minutes = 0;
  if (/^\d{1,6}$/.test(clean)) {
    minutes = Number(clean);
  } else {
    PART.lastIndex = 0;
    let consumed = 0;
    for (const match of clean.matchAll(PART)) {
      minutes += Number(match[1]) * UNITS.find(([u]) => u === match[2])[1];
      consumed += match[0].length;
    }
    if (consumed !== clean.length) return null;
  }
  const ms = minutes * MINUTE;
  return ms >= SURE_EN_AZ_MS && ms <= SURE_EN_FAZLA_MS ? ms : null;
}
