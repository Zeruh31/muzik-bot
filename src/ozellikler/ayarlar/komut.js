// /ayar: sunucu ayarları. Alt komutlar modüllerin ayar şemalarından kendiliğinden üretilir:
//   /ayar goster                       bütün ayarları listeler
//   /ayar panel kanal:#kanal           sabit "Kontrol Merkezi" mesajını kurar (kaldir:True kaldırır)
//   /ayar <modül> <ayar> deger:...     bir ayarı değiştirir; deger boşsa şu anki değeri söyler
//   /ayar <grup> <alt komut> ...       bir modülün kendi ayar komutları (tanımındaki ayarKomutlari)
// Yalnız "Sunucuyu Yönet" izni olanlar kullanabilir. Modüller bu dosyaya dokunmaz.

import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { genel } from '../../mesajlar.js';
import { replyError, replySuccess } from '../../commands/_helpers.js';
import { baseEmbed } from '../../util/embeds.js';
import { ozCommand, own } from '../_ortak.js';
import { whyNotAssignable, whyNotAssignableCached } from '../_roller.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { cevaplar, komut as M } from './mesajlar.js';
import { addValueOption, CHANNEL_TYPES, formatValue, readValueOption, validateValue } from './sema.js';

const MAX_SUBCOMMANDS = 25;
const PANEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

/** Modules that have settings, in menu order. */
const withSettings = (modules) => modules.filter((m) => Object.keys(m.ayarlar ?? {}).length > 0);
/** Settings that get an /ayar subcommand ("gizli" ones are changed by the module's own commands or menu). */
const commandFields = (module) => Object.entries(module.ayarlar ?? {}).filter(([, alan]) => !alan.gizli);

/** [{ module, extra }] for the subcommand groups modules add with `ayarKomutlari`. */
const extraGroups = (modules) =>
  modules.flatMap((module) => (module.ayarKomutlari ?? []).map((extra) => ({ module, extra })));

/** Builds /ayar from every module's schema; throws when Discord's limits would be exceeded. */
export function buildAyarData(modules) {
  const data = ozCommand('ayar', M.aciklama)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('goster').setDescription(M.goster))
    .addSubcommand((s) =>
      s
        .setName('panel')
        .setDescription(M.panel)
        .addChannelOption((o) =>
          o
            .setName('kanal')
            .setDescription(M.secenekler.kanal)
            .addChannelTypes(...CHANNEL_TYPES.metin),
        )
        .addBooleanOption((o) => o.setName('kaldir').setDescription(M.secenekler.kaldir)),
    );
  const groups = modules.filter((m) => commandFields(m).length > 0);
  const extras = extraGroups(modules);
  if (groups.length + extras.length + 2 > MAX_SUBCOMMANDS)
    throw new Error(`/ayar en fazla ${MAX_SUBCOMMANDS - 2} modül grubu alabilir.`);
  const taken = new Set(['goster', 'panel', ...groups.map((m) => m.ad)]);
  for (const { module, extra } of extras) {
    if (taken.has(extra.data.name))
      throw new Error(`src/ozellikler/${module.ad}: /ayar ${extra.data.name} başka bir grupla çakışıyor.`);
    taken.add(extra.data.name);
  }
  for (const module of groups) {
    data.addSubcommandGroup((group) => {
      group
        .setName(module.ad)
        .setDescription(module.mesajlar.ayarGrubu ?? M.grupAciklamasi(module.mesajlar.baslik).slice(0, 100));
      for (const [key, alan] of commandFields(module)) {
        group.addSubcommand((sub) => {
          const aciklama = module.mesajlar.ayarlar[key];
          sub.setName(key).setDescription(aciklama);
          addValueOption(sub, alan, M.secenekler.deger);
          return sub.addBooleanOption((o) => o.setName('sifirla').setDescription(M.secenekler.sifirla));
        });
      }
      return group;
    });
  }
  for (const { extra } of extras) data.addSubcommandGroup(extra.data);
  return data;
}

/** The role settings a feature hands out: [{ modul, anahtar, rolId, kim }] with a value set. */
function handedOutRoles(guildId, ozellikler) {
  const list = [];
  for (const module of withSettings([...ozellikler.moduller.values()])) {
    for (const [key, alan] of Object.entries(module.ayarlar)) {
      if (alan.tur !== 'rol' || !alan.verilebilir) continue;
      const rolId = ozellikler.ayarlar.get(guildId, module.ad, key);
      if (rolId)
        list.push({ modul: module.ad, anahtar: key, rolId, kim: ozellikler.ayarlar.setBy(guildId, module.ad, key) });
    }
  }
  return list;
}

/**
 * Why each handed-out role setting is not given right now (e.g. whoever set it left or lost "Sunucuyu Yönet"),
 * checked like the giving itself: Map("modul.anahtar" -> Turkish reason).
 */
export async function roleWarnings(guild, ozellikler) {
  const warnings = new Map();
  if (!guild) return warnings;
  for (const { modul, anahtar, rolId, kim } of handedOutRoles(guild.id, ozellikler)) {
    const neden = await whyNotAssignable(guild, rolId, { setterId: kim });
    if (neden) warnings.set(`${modul}.${anahtar}`, neden);
  }
  return warnings;
}

/**
 * Lines for /ayar goster and the menu's settings section.
 * @param {string} guildId
 * @param {object} ozellikler the registry (context.ozellikler)
 * @param {{ guild?: object, warnings?: Map<string, string> }} [options] warnings from roleWarnings(); without
 *   them the guild's cached members are used (the menu is drawn synchronously)
 */
export function settingsSummary(guildId, ozellikler, { guild = null, warnings = null } = {}) {
  const cached = new Map();
  if (!warnings && guild) {
    for (const { modul, anahtar, rolId, kim } of handedOutRoles(guildId, ozellikler)) {
      const neden = whyNotAssignableCached(guild, rolId, { setterId: kim });
      if (neden) cached.set(`${modul}.${anahtar}`, neden);
    }
  }
  const stopped = warnings ?? cached;
  const sections = [];
  for (const module of withSettings([...ozellikler.moduller.values()])) {
    const off = ozellikler.disabledIntents(module.ad);
    const title = cevaplar.bolumBasligi(module.mesajlar.emoji ?? '•', module.mesajlar.baslik);
    if (off) {
      sections.push({ title, lines: [cevaplar.kapaliOzellik(module.mesajlar.baslik, off.join(', '))] });
      continue;
    }
    const lines = Object.entries(module.ayarlar).map(([key, alan]) => {
      const line = cevaplar.ayarSatiri(
        key,
        formatValue(alan, ozellikler.ayarlar.get(guildId, module.ad, key)),
        !ozellikler.ayarlar.isSet(guildId, module.ad, key),
      );
      const neden = stopped.get(`${module.ad}.${key}`);
      return neden ? `${line} ${cevaplar.rolDurdu(neden)}` : line;
    });
    sections.push({ title, lines });
  }
  return sections;
}

async function show(interaction, { ozellikler }) {
  const sections = settingsSummary(interaction.guildId, ozellikler, {
    guild: interaction.guild,
    warnings: await roleWarnings(interaction.guild, ozellikler),
  });
  const embed = baseEmbed()
    .setTitle(cevaplar.gosterBaslik)
    .setDescription(cevaplar.panelSatiri(ozellikler.panel?.kanalOf(interaction.guildId) ?? null));
  if (!sections.length) embed.addFields({ name: '​', value: cevaplar.ayarYok });
  // Modules with stored data beyond the schema (e.g. role panels) add their own warnings.
  for (const module of ozellikler.moduller.values()) {
    if (typeof module.ayarUyarilari !== 'function' || ozellikler.disabledReason(module.ad)) continue;
    const lines = await module.ayarUyarilari(interaction.guild, { ozellikler, logger: null }).catch(() => []);
    if (lines.length)
      sections.push({ title: cevaplar.bolumBasligi(module.mesajlar.emoji ?? '•', module.mesajlar.baslik), lines });
  }
  for (const { title, lines } of sections.slice(0, 25)) {
    embed.addFields({ name: title, value: lines.join('\n').slice(0, 1024) || cevaplar.bos });
  }
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function panel(interaction, { ozellikler }) {
  if (interaction.options.getBoolean('kaldir')) {
    await ozellikler.panel.kaldir(interaction.guildId);
    await replySuccess(interaction, ozellikler.panel.mesajlar.kaldirildi, { ephemeral: true });
    return;
  }
  const channel = interaction.options.getChannel('kanal');
  if (!channel) {
    const current = ozellikler.panel.kanalOf(interaction.guildId);
    await replySuccess(interaction, cevaplar.panelSatiri(current), { ephemeral: true });
    return;
  }
  validateValue({ tur: 'kanal', kanalTurleri: ['metin'] }, channel, { guild: interaction.guild });
  // The panel is posted, edited and found again after a restart: all three are needed up front.
  const me = interaction.guild?.members?.me;
  if (me && typeof channel.permissionsFor === 'function') {
    const allowed = channel.permissionsFor(me)?.has(PANEL_PERMISSIONS);
    if (!allowed) throw new OzellikHatasi(ozellikler.panel.mesajlar.gonderilemedi(channel.id));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ozellikler.panel.kur(interaction.guildId, channel.id);
  await interaction.editReply({ embeds: [baseEmbed().setDescription(ozellikler.panel.mesajlar.kuruldu(channel.id))] });
}

/** Whether a (hidden) setting is stored by one of the module's list settings (ayarListeleri.kapsar). */
const coveredByList = (module, key) =>
  Object.values(module?.ayarListeleri ?? {}).some((list) => (list.kapsar ?? []).includes(key));

/**
 * Validates and stores one setting. The only path for both /ayar and the desktop app
 * (src/ozellikler/_masaustu/istekler.js): same validator (sema.js validateValue), same store, same hook.
 * @param {object} context the bot context
 * @param {object} input
 * @param {object} input.guild the guild the setting belongs to (channel, role and hierarchy checks)
 * @param {object|null} input.member who sets it; a role to hand out must be below their highest role
 * @param {string|null} input.kim the user id recorded for a role setting (checked again when it is given)
 * @param {*} input.raw a channel or role object, a string, a number or a boolean
 * @param {boolean} [input.sifirla] back to the default
 * @param {boolean} [input.gizliDahil] also "gizli" settings (no subcommand of their own), not list-covered ones
 * @returns {{ alan: object, value: * }} the field and the value in effect now
 */
export function applySetting(
  context,
  {
    guild,
    guildId = guild?.id,
    member = null,
    kim = null,
    modul,
    anahtar,
    raw = null,
    sifirla = false,
    gizliDahil = false,
  },
) {
  const { ozellikler } = context;
  const module = ozellikler.moduller.get(modul);
  const alan = own(module?.ayarlar, anahtar);
  if (!alan || (alan.gizli && !gizliDahil) || coveredByList(module, anahtar))
    throw new OzellikHatasi(cevaplar.bilinmeyenAyar);
  const off = ozellikler.disabledReason(modul);
  if (off) throw new OzellikHatasi(off);
  const store = ozellikler.ayarlar;
  if (sifirla) {
    store.set(guildId, modul, anahtar, null);
  } else {
    const value = validateValue(alan, raw, { guild, member });
    // A role to hand out remembers who set it: it is checked against them again whenever it is given.
    store.set(guildId, modul, anahtar, value, { kim: alan.tur === 'rol' ? kim : null });
  }
  const value = store.get(guildId, modul, anahtar);
  module.ayarDegisti?.(context, guildId, anahtar, value);
  return { alan, value };
}

async function change(interaction, context, moduleName, key) {
  const module = context.ozellikler.moduller.get(moduleName);
  const alan = own(module?.ayarlar, key);
  if (!alan || alan.gizli) throw new OzellikHatasi(cevaplar.bilinmeyenAyar);
  const off = context.ozellikler.disabledReason(moduleName);
  if (off) throw new OzellikHatasi(off);
  const name = `${moduleName} ${key}`;
  const store = context.ozellikler.ayarlar;
  const guildId = interaction.guildId;
  const where = { guild: interaction.guild, guildId, modul: moduleName, anahtar: key };

  if (interaction.options.getBoolean('sifirla')) {
    const { value } = applySetting(context, { ...where, sifirla: true });
    await replySuccess(interaction, cevaplar.sifirlandi(name, formatValue(alan, value)), { ephemeral: true });
    return;
  }
  const raw = readValueOption(interaction, alan);
  if (raw === null || raw === undefined) {
    const value = store.get(guildId, moduleName, key);
    await replySuccess(
      interaction,
      cevaplar.simdiki(name, formatValue(alan, value), !store.isSet(guildId, moduleName, key)),
      {
        ephemeral: true,
      },
    );
    return;
  }
  const { value } = applySetting(context, {
    ...where,
    raw,
    member: interaction.member,
    kim: interaction.user?.id ?? null,
  });
  await replySuccess(interaction, cevaplar.kaydedildi(name, formatValue(alan, value)), { ephemeral: true });
}

/** The /ayar command object for the module's `komutlar`. */
export function createAyarCommand(modules) {
  const extras = new Map(extraGroups(modules).map((entry) => [entry.extra.data.name, entry]));
  return {
    data: buildAyarData(modules),
    kategori: 'ayarlar',
    async autocomplete(interaction, context) {
      const entry = extras.get(interaction.options.getSubcommandGroup(false) ?? '');
      if (!entry?.extra.autocomplete || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.respond([]);
        return;
      }
      await entry.extra.autocomplete(interaction, context);
    },
    async execute(interaction, context) {
      // The default permission only hides the command; server admins can change that, so check here too.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await replyError(interaction, genel.yetkiYok);
        return;
      }
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      if (!group && sub === 'goster') return show(interaction, context);
      if (!group && sub === 'panel') return panel(interaction, context);
      const entry = group ? extras.get(group) : null;
      if (entry) {
        const off = context.ozellikler.disabledReason(entry.module.ad);
        if (off) throw new OzellikHatasi(off);
        return entry.extra.execute(interaction, context);
      }
      return change(interaction, context, group, sub);
    },
  };
}
