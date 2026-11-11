// Kontrol merkezini çizer: modüllerin "menü bölümü" kayıtlarından Components V2 mesajı kurar
// (Container, TextDisplay, Separator, Section). Bölümler görünürlüğe göre süzülür:
//   herkes   herkese görünür
//   dj       DJ rolü olanlara (rol ayarlı değilse herkese) ve yöneticilere
//   yonetici yalnız "Sunucuyu Yönet" izni olanlara
// Boş bölüm (ciz() hiçbir şey döndürmeyen ya da gorunur() false olan) gösterilmez. Aynı `menu.kategori`
// değerini veren modüllerin bölümleri menüde tek başlık altında alt alta çizilir (ör. "Oyun").

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { memberRoleIds } from '../../bot/dj.js';
import { menuKategorileri } from '../_mesajlar.js';
import { own, ozId } from '../_ortak.js';
import { merkez as M } from './mesajlar.js';

/** Discord's limit on all components (nested ones included) in a Components V2 message. */
export const MAX_COMPONENTS = 40;
const MAX_OPTIONS = 25;

/** Who is looking at the menu; decides which sections are shown. */
export function viewerOf(interaction, context) {
  const guildId = interaction.guildId ?? null;
  const canManageGuild = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  const djRoleId = guildId ? context.settings?.getDjRole(guildId) : null;
  const isDj = !djRoleId || canManageGuild || memberRoleIds(interaction.member).includes(djRoleId);
  return { guildId, guild: interaction.guild ?? null, userId: interaction.user?.id ?? null, canManageGuild, isDj };
}

/** A viewer for the fixed panel: everyone in the channel sees it, so only "herkes" sections. */
export const publicViewer = (guildId, guild = null) => ({
  guildId,
  guild,
  userId: null,
  canManageGuild: false,
  isDj: false,
  herkes: true,
});

export function isVisible(menu, viewer) {
  const visibility = menu.gorunurluk ?? 'herkes';
  if (visibility === 'herkes') return true;
  if (viewer.herkes) return false;
  if (visibility === 'dj') return viewer.isDj;
  return viewer.canManageGuild;
}

/**
 * The sections a viewer sees, in menu order, each with its drawn components.
 * @param {Iterable<object>} modules
 * @returns {{ module: object, components: object[] }[]}
 */
export function visibleSections(modules, viewer, context, { disabledReason = () => null, yer = 'menu' } = {}) {
  const sections = [];
  // A module gives one section, or several (`menu: [...]`, e.g. one under "Oyun" and one under "Ayarlar").
  const ordered = [...modules]
    .flatMap((module) => menusOf(module).map((menu) => ({ module, menu })))
    .sort((a, b) => (a.menu.sira ?? 50) - (b.menu.sira ?? 50));
  for (const { module, menu } of ordered) {
    if (!isVisible(menu, viewer) || disabledReason(module.ad)) continue;
    const ctx = { context, guildId: viewer.guildId, guild: viewer.guild, viewer, yer };
    if (menu.gorunur && !menu.gorunur(ctx)) continue;
    sections.push({ module, menu, ctx });
  }
  return sections;
}

/** The menu sections of a module as a list. */
export const menusOf = (module) => (Array.isArray(module.menu) ? module.menu : module.menu ? [module.menu] : []);

/** Adds one builder to a container with the method its type needs. */
function addTo(container, component) {
  if (component instanceof TextDisplayBuilder) container.addTextDisplayComponents(component);
  else if (component instanceof SectionBuilder) container.addSectionComponents(component);
  else if (component instanceof ActionRowBuilder) container.addActionRowComponents(component);
  else if (component instanceof SeparatorBuilder) container.addSeparatorComponents(component);
  else throw new Error('Menü bölümü desteklenmeyen bir bileşen döndürdü.');
}

/** Counts every component of a message (Discord counts nested ones too). */
export function countComponents(list) {
  let total = 0;
  for (const component of list ?? []) {
    total += 1;
    total += countComponents(component.components);
    if (component.accessory) total += 1;
  }
  return total;
}

function finish(container, flags) {
  const payload = { components: [container], flags, allowedMentions: { parse: [] } };
  const count = countComponents(payload.components.map((c) => c.toJSON()));
  if (count > MAX_COMPONENTS)
    throw new Error(`Kontrol merkezi ${count} bileşen içeriyor (en fazla ${MAX_COMPONENTS}).`);
  return payload;
}

/**
 * Sections grouped into menu entries: modules with the same `menu.kategori` share one entry
 * (e.g. "Oyun": takım, zar, anket, çekiliş); the others are an entry of their own, named by the module.
 * @returns {{ key: string, label: object, sections: object[] }[]}
 */
export function groupSections(sections) {
  const groups = new Map();
  for (const section of sections) {
    const key = section.menu.kategori ?? section.module.ad;
    if (!groups.has(key)) {
      const shared = section.menu.kategori ? own(menuKategorileri, key) : null;
      const { baslik, emoji, aciklama } = shared ?? section.module.mesajlar;
      groups.set(key, { key, label: { baslik, emoji, aciklama }, sections: [] });
    }
    groups.get(key).sections.push(section);
  }
  return [...groups.values()];
}

/**
 * The ephemeral /menu message for a viewer, showing entry `bolum` (the first one when unknown).
 * @returns {{ payload: object, shown: string|null, sections: string[] }}
 */
export function buildMenu(context, viewer, { bolum = null, hedefId = null } = {}) {
  const { ozellikler } = context;
  const groups = groupSections(
    visibleSections(ozellikler.moduller.values(), viewer, context, {
      disabledReason: ozellikler.disabledReason,
    }),
  );
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(M.baslik));
  if (hedefId) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(M.hedefKisi(hedefId)));
  const selected = groups.find((g) => g.key === bolum) ?? groups[0] ?? null;
  if (!selected) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(M.bosMenu));
  } else {
    if (groups.length > 1) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(ozId('menu', 'bolum'))
        .setPlaceholder(M.bolumSec)
        .addOptions(
          groups.slice(0, MAX_OPTIONS).map(({ key, label }) => ({
            label: label.baslik,
            value: key,
            ...(label.emoji ? { emoji: label.emoji } : {}),
            default: key === selected.key,
            ...(label.aciklama ? { description: label.aciklama.slice(0, 100) } : {}),
          })),
        );
      container.addActionRowComponents(new ActionRowBuilder().addComponents(select));
    }
    for (const { menu, ctx } of selected.sections) {
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
      for (const component of menu.ciz(ctx) ?? []) addTo(container, component);
    }
  }
  return {
    payload: finish(container, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral),
    shown: selected?.key ?? null,
    sections: groups.map((g) => g.key),
  };
}

/** The fixed "Kontrol Merkezi" message: every public section and a button that opens /menu. */
export function buildPanel(context, guildId, guild = null) {
  const { ozellikler } = context;
  const viewer = publicViewer(guildId, guild);
  const sections = visibleSections(ozellikler.moduller.values(), viewer, context, {
    disabledReason: ozellikler.disabledReason,
    yer: 'panel',
  });
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(M.panelBasligi),
  );
  for (const { menu, ctx } of sections) {
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small));
    for (const component of menu.ciz(ctx) ?? []) addTo(container, component);
  }
  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(M.panelAltBilgi))
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(ozId('menu', 'ac'))
            .setEmoji('🎛️')
            .setLabel(M.menuyuAc)
            .setStyle(ButtonStyle.Primary),
        ),
    );
  return finish(container, MessageFlags.IsComponentsV2);
}
