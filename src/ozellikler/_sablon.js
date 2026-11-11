// Mesaj şablonları: "{kullanıcı} aramıza katıldı" gibi metinlerdeki {yer tutucu}ları doldurur.
// Hem Türkçe karakterli ({kullanıcı}, {üye_sayısı}) hem karaktersiz ({kullanici}, {uye_sayisi}) yazım çalışır.
// Normalde bu dosyaya dokunmana gerek yok.

/** Discord's message content limit. */
export const MESSAGE_MAX = 2000;

/** Turkish letters folded to ASCII, so "{üye_sayısı}" and "{uye_sayisi}" are the same placeholder. */
const FOLD = { ç: 'c', ğ: 'g', ı: 'i', i̇: 'i', ö: 'o', ş: 's', ü: 'u' };

/** "Üye Sayısı" -> "uye_sayisi": lower case, Turkish letters folded, spaces and dashes as "_". */
export function placeholderKey(name) {
  return String(name)
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]|i̇/g, (ch) => FOLD[ch] ?? ch)
    .replace(/[\s-]+/g, '_');
}

/**
 * Fills {placeholders} in one pass. Values are inserted as they are and never scanned again, so a user
 * name like "{sunucu}" stays literal text. Unknown placeholders are left untouched. The result is cut to
 * Discord's 2000 characters.
 * @param {string} template
 * @param {Record<string, string|number>} values keys in placeholderKey() form (e.g. "kullanici", "uye_sayisi")
 */
export function fillTemplate(template, values, max = MESSAGE_MAX) {
  const table = new Map(Object.entries(values).map(([key, value]) => [placeholderKey(key), String(value)]));
  const text = String(template ?? '').replace(/\{([^{}\n]{1,24})\}/g, (whole, name) => {
    const value = table.get(placeholderKey(name));
    return value === undefined ? whole : value;
  });
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
