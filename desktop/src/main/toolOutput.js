'use strict';

// Turns the text output of the bot's helper scripts into something the UI can list.

/**
 * scripts/kontrol.js prints "  [TAMAM] ...", "  [UYARI] ...", "  [SORUN] ..." lines and
 * a summary at the end.
 * @returns {{ items: Array<{ status: 'ok'|'warn'|'bad', text: string }>, summary: string, problems: number }}
 */
function parseKontrolOutput(text) {
  const items = [];
  const map = { TAMAM: 'ok', UYARI: 'warn', SORUN: 'bad' };
  let summary = '';
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^\[(TAMAM|UYARI|SORUN)\]\s*(.*)$/.exec(line);
    if (match) items.push({ status: map[match[1]], text: match[2] });
    else if (/sorun bulundu|hazır görünüyor/i.test(line)) summary = line;
  }
  return { items, summary, problems: items.filter((i) => i.status === 'bad').length };
}

/**
 * Picks the message lines of a helper script: "Tamam: ..." / "HATA: ..." / "Komut tanımları ...".
 * @returns {{ ok: boolean, message: string }}
 */
function summarizeScript(code, stdout, stderr) {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const error = lines.find((l) => l.startsWith('HATA:'));
  if (code !== 0) {
    return { ok: false, message: error ? error.replace(/^HATA:\s*/, '') : (lines.at(-1) ?? `Çıkış kodu ${code}`) };
  }
  const done = lines.filter((l) => /^Tamam:|^Komut tanımları/.test(l));
  return { ok: true, message: done.join('\n') || lines.at(-1) || 'Tamamlandı.' };
}

module.exports = { parseKontrolOutput, summarizeScript };
