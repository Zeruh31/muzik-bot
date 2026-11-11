// Müzik dışı özelliklerin kaydı. src/ozellikler/ altındaki her klasör (adı "_" ile başlamayan) bir
// modüldür ve kendi index.js dosyasında tanımını verir (src/ozellikler/_ortak.js başındaki açıklama).
// Bu dosya modülleri yükler, ayarlarını, zamanlanmış işlerini, menü bölümlerini ve bileşenlerini bağlar.
// Yeni bir özellik için yeni bir klasör eklemen yeterli; bu dosyaya dokunmana gerek yok.

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageFlags } from 'discord.js';
import { ortak, ustKomutlar } from './_mesajlar.js';
import { NAME_PATTERN, own, ozCommand } from './_ortak.js';
import { planIntents } from './_intentler.js';
import { createRouter, OzellikHatasi } from './_yonlendirici.js';
import { createScheduler, systemClock } from './_zamanlayici.js';
import { createFeatureSettings } from './ayarlar/depo.js';
import { checkSchema } from './ayarlar/sema.js';
import { buildMenu, viewerOf } from './menu/merkez.js';
import { createPanelService } from './menu/panel.js';

const OZELLIKLER_DIR = dirname(fileURLToPath(import.meta.url));

/** Loads every module folder, sorted by name. Each must export its definition as default. */
export async function loadModules(dir = OZELLIKLER_DIR) {
  const entries = await readdir(dir, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && existsSync(join(dir, e.name, 'index.js')))
    .map((e) => e.name)
    .sort();
  const modules = [];
  for (const folder of folders) {
    const { default: module } = await import(pathToFileURL(join(dir, folder, 'index.js')).href);
    if (!module?.ad) throw new Error(`src/ozellikler/${folder}/index.js: modül tanımı (export default) yok.`);
    if (module.ad !== folder) throw new Error(`src/ozellikler/${folder}: modül adı klasör adıyla aynı olmalı.`);
    checkSchema(module.ad, module.ayarlar, module.mesajlar);
    modules.push(module);
  }
  return modules;
}

/**
 * A parent command (e.g. /oyun) built from the subcommands several modules give with `ust`.
 * Each subcommand still belongs to its module: a module that is off answers with its own reason.
 */
function parentCommand(name, subs) {
  const aciklama = own(ustKomutlar, name);
  if (!aciklama)
    throw new Error(`"/${name}" üst komutunun açıklaması src/ozellikler/_mesajlar.js > ustKomutlar içinde yok.`);
  const base = ozCommand(name, aciklama);
  const pick = (interaction) => subs.get(interaction.options.getSubcommand(false) ?? '');
  return {
    data: {
      name,
      description: aciklama,
      toJSON: () => ({ ...base.toJSON(), options: [...subs.values()].map((s) => s.data.toJSON()) }),
    },
    kategori: name,
    subcommands: subs,
    /** Usage counters and the DJ rule see "/oyun zar" as "zar". */
    statName: (interaction) => interaction.options.getSubcommand(false) ?? name,
    djName: (interaction) => interaction.options.getSubcommand(false) ?? name,
    async execute(interaction, context) {
      const sub = pick(interaction);
      if (!sub) throw new Error(`/${name}: bilinmeyen alt komut`);
      const off = context.ozellikler?.disabledReason(sub.modul);
      if (off) throw new OzellikHatasi(off);
      await sub.execute(interaction, context);
    },
    async autocomplete(interaction, context) {
      const sub = pick(interaction);
      if (sub?.autocomplete) await sub.autocomplete(interaction, context);
      else await interaction.respond([]);
    },
  };
}

/** The slash and context menu commands of the modules, tagged with their module. */
export function moduleCommands(modules) {
  const commands = [];
  /** parent name -> Map(subcommand name -> command) */
  const children = new Map();
  for (const module of modules) {
    const list = typeof module.komutlar === 'function' ? module.komutlar(modules) : (module.komutlar ?? []);
    for (const command of list) {
      if (!command?.data || typeof command.execute !== 'function') {
        throw new Error(`src/ozellikler/${module.ad}: her komutun "data" ve "execute" alanı olmalı.`);
      }
      const entry = { ...command, kategori: command.kategori ?? module.ad, modul: module.ad };
      if (!command.ust) {
        commands.push(entry);
        continue;
      }
      const subs = children.get(command.ust) ?? children.set(command.ust, new Map()).get(command.ust);
      if (subs.has(command.data.name)) {
        throw new Error(`src/ozellikler/${module.ad}: "/${command.ust} ${command.data.name}" iki kez tanımlanmış.`);
      }
      subs.set(command.data.name, entry);
    }
  }
  for (const [name, subs] of children) commands.push(parentCommand(name, subs));
  return commands;
}

/**
 * Wires the modules into a running bot.
 * @param {object} deps
 * @param {object} deps.context the bot context; gets `ozellikler` (this registry)
 * @param {object[]} deps.modules from loadModules()
 * @param {ReturnType<typeof planIntents>} [deps.intentPlan] which modules are off for missing intents
 * @param {{ ayarlar: string, zamanlayici: string, paneller: string }} deps.files data/ files; a module's
 *   own data file (registry.depo) goes into the same folder as `ayarlar`
 */
export function createOzellikler({ context, modules, intentPlan = planIntents(modules), files, clock, logger }) {
  const moduller = new Map(modules.map((m) => [m.ad, m]));
  const disabledIntents = (name) => intentPlan.disabled.get(name) ?? null;
  const disabledReason = (name) => {
    const missing = disabledIntents(name);
    return missing ? ortak.ozellikKapali(moduller.get(name)?.mesajlar?.baslik ?? name, missing.join(', ')) : null;
  };

  const schemas = new Map(modules.filter((m) => m.ayarlar).map((m) => [m.ad, m.ayarlar]));
  const ayarlar = createFeatureSettings({ file: files.ayarlar, schemas, logger: logger?.child?.('ayarlar') ?? logger });
  const zamanlayici = createScheduler({
    file: files.zamanlayici,
    clock,
    logger: logger?.child?.('zamanlayıcı') ?? logger,
  });
  for (const module of modules) {
    if (disabledReason(module.ad)) continue;
    for (const [tur, handler] of Object.entries(module.isler ?? {}))
      zamanlayici.turKaydet(`${module.ad}.${tur}`, handler);
  }
  const router = createRouter(moduller, { disabledReason, logger });
  const panel = moduller.has('menu')
    ? createPanelService({
        file: files.paneller,
        context,
        clock,
        logger: logger?.child?.('panel') ?? logger,
        intervalOf: (guildId) => ayarlar.get(guildId, 'menu', 'panel-aralik'),
      })
    : null;

  /** What each module's olaylar() returned: functions that remove its listeners. */
  const offs = [];
  const dataDir = dirname(files.ayarlar);
  /** name -> a module's store, created on first use */
  const stores = new Map();
  const registry = {
    moduller,
    intentPlan,
    ayarlar,
    zamanlayici,
    router,
    panel,
    disabledIntents,
    disabledReason,
    /** The clock of the scheduler (a fake one in tests). */
    saat: clock ?? systemClock,
    /**
     * A module's own data store, created once: `create(file)` gets data/<name>.json (next to
     * data/ozellikler.json). Created on first use, so a module that is never used writes nothing.
     */
    depo(name, create) {
      if (!NAME_PATTERN.test(name) || basename(name) !== name) throw new Error(`Geçersiz depo adı: ${name}`);
      if (!stores.has(name)) stores.set(name, create(join(dataDir, `${name}.json`)));
      return stores.get(name);
    },
    menu: {
      /** The menu for an interaction's user, for editing an open (ephemeral) menu message. */
      payloadFor(interaction, bolum) {
        const { payload } = buildMenu(context, viewerOf(interaction, context), { bolum });
        return { ...payload, flags: MessageFlags.IsComponentsV2 };
      },
    },
    /** On login: catch up on due jobs, reconnect the fixed panels. */
    async baslat() {
      // In parallel: reconnecting the panels does not wait for the catch-up jobs (which may be slow).
      const jobs = zamanlayici
        .baslat(context)
        .catch((error) => logger?.error('Zamanlayıcı başlatılamadı:', error?.message ?? error));
      const panels = panel
        ? panel.baglan().then((results) => {
            const count = Object.values(results).filter((r) => r === 'baglandi' || r === 'yeniden-olusturuldu').length;
            if (count) logger?.info(`Kontrol paneli: ${count} sunucuda yeniden bağlandı.`);
          })
        : null;
      await Promise.all([jobs, panels]);
    },
    kapat() {
      zamanlayici.durdur();
      panel?.durdur();
      for (const off of offs.splice(0)) off?.();
      for (const module of modules) module.kapat?.();
    },
  };
  context.ozellikler = registry;

  for (const module of modules) {
    if (disabledReason(module.ad) || typeof module.olaylar !== 'function') continue;
    offs.push(module.olaylar(context));
  }
  return registry;
}
