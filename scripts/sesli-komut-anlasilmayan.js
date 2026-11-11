// Sesli komutta anlaşılmayan cümleleri listeler (yalnız tanı modunda toplanır: .env > SESLI_KOMUT_TANI=true).
// Kullanım: npm run sesli-komut:anlasilmayan   (yeni kalıplar src/ozellikler/sesli-komut/kaliplar.js'e eklenir)
import { readUnknown, UNKNOWN_FILE } from '../src/ozellikler/sesli-komut/ogrenme.js';

const list = readUnknown();
if (!list.length) {
  console.log(`Kayıt yok (${UNKNOWN_FILE}). Tanı modu açıkken anlaşılmayan cümleler buraya yazılır.`);
} else {
  for (const { zaman, metin } of list) console.log(`${zaman.replace('T', ' ').slice(0, 19)}  ${metin}`);
  console.log(`\n${list.length} kayıt: ${UNKNOWN_FILE}`);
}
