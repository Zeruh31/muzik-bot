// Adil rastgelelik: takım bölme, zar, seçim ve çekiliş hep buradaki işlevleri kullanır. Math.random yerine
// node:crypto kullanılır (tahmin edilemez ve eşit dağılımlı). Testler kendi sayı üretecini verebilir.
// Normalde bu dosyaya dokunmana gerek yok.

import { randomInt } from 'node:crypto';

/** (max) => a whole number in [0, max), evenly spread. */
export const cryptoRandom = (max) => randomInt(max);

/** A shuffled copy (Fisher-Yates). */
export function shuffle(list, random = cryptoRandom) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = random(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** `count` different items picked at random (fewer when the list is shorter). */
export function pickSome(list, count, random = cryptoRandom) {
  return shuffle(list, random).slice(0, Math.max(0, count));
}
