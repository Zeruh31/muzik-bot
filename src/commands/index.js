// Bu klasördeki her komut dosyasını ve src/ozellikler/ modüllerinin komutlarını otomatik yükler. Yeni bir
// komut için yeni bir dosya eklemen yeterli (README > Kendin düzenlemek istersen). Bir dosya
// `export const ust = 'muzik'` diyorsa üst düzey komut olmaz, /muzik altına alt komut olarak girer
// (src/commands/muzik.js). Bu dosyaya dokunmana gerek yok.
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadModules, moduleCommands } from '../ozellikler/index.js';

const COMMANDS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Loads every command module in this folder (except index.js and files starting with "_").
 * Each module must export `data` (a SlashCommandBuilder) and `execute(interaction, context)`;
 * optionally `autocomplete`, `kategori` (for /help; default "muzik") and `ust` (parent command).
 * With `ozellikler` (default) the feature modules' commands are added too.
 * @returns {Promise<Map<string, { data: object, execute: Function, file: string }>>}
 */
export async function loadCommands({ ozellikler = true } = {}) {
  const files = (await readdir(COMMANDS_DIR))
    .filter((file) => file.endsWith('.js') && file !== 'index.js' && !file.startsWith('_'))
    .sort();

  const commands = new Map();
  /** parent name -> Map(subcommand name -> command) */
  const children = new Map();
  for (const file of files) {
    const module = await import(pathToFileURL(join(COMMANDS_DIR, file)).href);
    if (!module.data || typeof module.execute !== 'function') {
      throw new Error(`${file}: "data" ve "execute" dışa aktarılmalı.`);
    }
    const { name } = module.data;
    const entry = {
      data: module.data,
      execute: module.execute,
      autocomplete: module.autocomplete,
      kategori: module.kategori ?? 'muzik',
      file,
    };
    const target = module.ust
      ? (children.get(module.ust) ?? children.set(module.ust, new Map()).get(module.ust))
      : commands;
    if (target.has(name))
      throw new Error(`${file}: "/${module.ust ? `${module.ust} ` : ''}${name}" komut adı iki kez tanımlanmış.`);
    target.set(name, module.ust ? entry : { ...entry, altKomutlar: module.altKomutlar });
  }

  for (const [parentName, subs] of children) {
    const parent = commands.get(parentName);
    if (typeof parent?.altKomutlar !== 'function') {
      throw new Error(`"/${parentName}" alt komutları için ${parentName}.js içinde altKomutlar() olmalı.`);
    }
    const { altKomutlar, ...rest } = parent;
    commands.set(parentName, { ...rest, ...altKomutlar(subs) });
  }

  if (ozellikler) {
    for (const command of moduleCommands(await loadModules())) {
      const { name } = command.data;
      if (commands.has(name))
        throw new Error(`src/ozellikler/${command.modul}: "/${name}" komut adı iki kez tanımlanmış.`);
      // A parent such as /oyun has no single module: it is named after itself.
      commands.set(name, { ...command, file: `ozellikler/${command.modul ?? name}` });
    }
  }
  return commands;
}
