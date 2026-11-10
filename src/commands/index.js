// Bu klasördeki her komut dosyasını otomatik yükler. Yeni bir komut için yeni bir dosya eklemen
// yeterli (README > Kendin düzenlemek istersen). Bu dosyaya dokunmana gerek yok.
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Loads every command module in this folder (except index.js and files starting with "_").
 * Each module must export `data` (a SlashCommandBuilder) and `execute(interaction, context)`.
 * @returns {Promise<Map<string, { data: object, execute: Function }>>}
 */
export async function loadCommands() {
  const files = (await readdir(COMMANDS_DIR))
    .filter((file) => file.endsWith('.js') && file !== 'index.js' && !file.startsWith('_'))
    .sort();

  const commands = new Map();
  for (const file of files) {
    const module = await import(pathToFileURL(join(COMMANDS_DIR, file)).href);
    if (!module.data || typeof module.execute !== 'function') {
      throw new Error(`${file}: "data" ve "execute" dışa aktarılmalı.`);
    }
    const { name } = module.data;
    if (commands.has(name)) throw new Error(`${file}: "/${name}" komut adı iki kez tanımlanmış.`);
    commands.set(name, { data: module.data, execute: module.execute, file });
  }
  return commands;
}
