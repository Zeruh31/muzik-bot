// Rol panelleri: kurma ("/ayar rol-menusu" ya da kontrol merkezindeki form), çizme ve tıklanınca rol verme.
// Bir rol panele ancak şu koşullarla girer: @everyone değil, bir bota/takviyeye ait (managed) değil, yasaklı
// izinlerden (src/ozellikler/_roller.js > FORBIDDEN_ROLE_PERMISSIONS) birini taşımıyor, botun en yüksek rolünden
// aşağıda; paneli kuran kişinin en yüksek rolünden de aşağıda (sunucu sahibi hariç). Her rol kuranıyla
// ({ id, kim }) saklanır ve her tıklamada _roller.js aynı kuralları kuranla birlikte yeniden denetler.
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { memberRoleIds } from '../../bot/dj.js';
import { escapeMarkdown } from '../../util/format.js';
import { ozId } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { changeRoles, createThrottledWarn, forbiddenPermissionText, hasForbiddenPermission } from '../_roller.js';
import { validateValue } from '../ayarlar/sema.js';
import { PANEL_ID, PANEL_ROL_EN_FAZLA } from './depo.js';
import { cevaplar as C, panel as T } from './mesajlar.js';

export const MODUL = 'roller-ve-ara';
/** Panels per guild; keeps data/roller-ve-ara.json and the /ayar autocomplete small. */
export const PANEL_EN_FAZLA = 25;
const BUTTONS_PER_ROW = 5;

const fail = (text) => {
  throw new OzellikHatasi(text);
};

const positionOf = (role) => Number(role?.position ?? 0);

/**
 * Why a role cannot be on a role panel, or null when it can.
 * @param {object} role a Role (or the raw role Discord sends)
 * @param {object} guild
 * @param {object|null} [byMember] the admin setting up the panel (their own hierarchy is checked too)
 */
export function roleProblem(role, guild, byMember = null) {
  if (!role || role.id === guild?.id) return C.rolHerkes;
  if (role.managed) return C.rolYonetilen(role.id);
  if (hasForbiddenPermission(role)) return forbiddenPermissionText(role, `<@&${role.id}> rolünde`);
  const me = guild?.members?.me;
  if (me?.permissions?.has && !me.permissions.has(PermissionFlagsBits.ManageRoles)) return C.botRolVeremez;
  const botTop = me?.roles?.highest;
  if (!botTop || positionOf(role) >= positionOf(botTop)) return C.rolBotAltinda(role.id);
  if (byMember && guild.ownerId !== byMember.id) {
    const top = byMember.roles?.highest;
    if (!top || positionOf(role) >= positionOf(top)) return C.rolSiziAsiyor(role.id);
  }
  return null;
}

/** Throws the Turkish reason when a role cannot be on a panel. */
export function requireAssignable(role, guild, byMember) {
  const problem = roleProblem(role, guild, byMember);
  if (problem) fail(problem);
}

const roleLabel = (guild, entry) => guild?.roles?.cache?.get(entry.id)?.name ?? entry.ad;

/** A role panel message (Components V2). */
export function renderPanel(panel, guild = null) {
  const lines = [T.baslik(escapeMarkdown(panel.baslik))];
  if (!panel.roller.length) lines.push(T.bos);
  for (const entry of panel.roller) lines.push(T.satir(entry.emoji, entry.id));
  lines.push(panel.coklu ? T.ipucuCoklu : T.ipucuTek);
  const container = new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 3800)));
  if (panel.roller.length && panel.stil === 'menu') {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(ozId(MODUL, 'sec', panel.id))
          .setPlaceholder(T.menuYer)
          .setMinValues(0)
          .setMaxValues(panel.coklu ? panel.roller.length : 1)
          .addOptions(
            panel.roller.map((entry) => ({
              label: roleLabel(guild, entry).slice(0, 100),
              value: entry.id,
              ...(entry.emoji ? { emoji: entry.emoji } : {}),
            })),
          ),
      ),
    );
  } else {
    for (let i = 0; i < panel.roller.length; i += BUTTONS_PER_ROW) {
      container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          panel.roller.slice(i, i + BUTTONS_PER_ROW).map((entry) => {
            const button = new ButtonBuilder()
              .setCustomId(ozId(MODUL, 'rol', panel.id, entry.id))
              .setLabel(roleLabel(guild, entry).slice(0, 80))
              .setStyle(ButtonStyle.Secondary);
            if (entry.emoji) button.setEmoji(entry.emoji);
            return button;
          }),
        ),
      );
    }
  }
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

const CUSTOM_EMOJI = /^<a?:\w{2,32}:\d{17,20}>$/;
const UNICODE_EMOJI =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣)[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}‍️⃣]*$/u;

/** A checked emoji for a button, or null when none was given. */
export function readEmoji(value) {
  const emoji = String(value ?? '').trim();
  if (!emoji) return null;
  if (emoji.length > 64 || !(CUSTOM_EMOJI.test(emoji) || UNICODE_EMOJI.test(emoji))) fail(C.emojiGecersiz);
  return emoji;
}

const roleOf = (guild, role) => guild?.roles?.cache?.get(role?.id) ?? role;

/** Sends or edits a panel's message; a deleted message is sent again. @returns {object} the stored panel */
async function publish(context, store, panel, guild) {
  const channel = await context.client.channels.fetch(panel.kanalId).catch(() => null);
  if (!channel?.send) fail(C.gonderilemedi(panel.kanalId));
  const payload = renderPanel(panel, guild);
  if (panel.mesajId) {
    const message = await channel.messages?.fetch(panel.mesajId).catch(() => null);
    if (message) {
      await message.edit(payload);
      return panel;
    }
  }
  let message;
  try {
    message = await channel.send(payload);
  } catch (error) {
    if (error?.code === RESTJSONErrorCodes.MissingPermissions || error?.code === RESTJSONErrorCodes.MissingAccess)
      fail(C.gonderilemedi(panel.kanalId));
    throw error;
  }
  return store.setPanel(panel.id, { ...panel, mesajId: message.id });
}

/**
 * Sets up a new panel. Every role is checked first; nothing is posted when one is refused.
 * @param {{ kanal: object, baslik: string, roller: object[], stil: 'dugme'|'menu', coklu: boolean }} options
 */
export async function createPanel(interaction, context, store, { kanal, baslik, roller, stil, coklu }) {
  const { guild } = interaction;
  if (store.panelsOf(guild.id).length >= PANEL_EN_FAZLA) fail(C.panelSiniri(PANEL_EN_FAZLA));
  const kanalId = validateValue({ tur: 'kanal', kanalTurleri: ['metin'] }, kanal, { guild });
  const unique = [...new Map(roller.filter(Boolean).map((r) => [r.id, roleOf(guild, r)])).values()];
  if (unique.length > PANEL_ROL_EN_FAZLA) fail(C.panelDolu(PANEL_ROL_EN_FAZLA));
  for (const role of unique) requireAssignable(role, guild, interaction.member);
  const id = randomBytes(4).toString('hex');
  const panel = store.setPanel(id, {
    guildId: guild.id,
    kanalId,
    mesajId: null,
    baslik: String(baslik ?? '').trim(),
    stil,
    coklu,
    roller: unique.map((role) => ({ id: role.id, ad: role.name ?? role.id, emoji: null, kim: interaction.user.id })),
  });
  try {
    return await publish(context, store, panel, guild);
  } catch (error) {
    store.setPanel(id, null);
    throw error;
  }
}

/** The panel of an /ayar option or a customId, only from the interaction's own guild. */
export function panelOf(store, guildId, id) {
  const panel = PANEL_ID.test(String(id ?? '')) ? store.panel(id) : null;
  if (!panel || panel.guildId !== guildId) fail(C.panelYok);
  return panel;
}

const EMOJI_PART = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}‍️⃣]/gu;

/** A panel title as compared: no emoji, Turkish and plain i/ı/I/İ alike, case and spacing ignored. */
export const panelKey = (title) =>
  String(title ?? '')
    .replace(EMOJI_PART, '')
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The panel an /ayar option names: the id (what autocomplete sends), else the exact title, else the one
 * panel whose title contains the text. Several matches at one step are refused, never guessed.
 */
export function findPanel(store, guildId, typed) {
  const text = String(typed ?? '').trim();
  const byId = PANEL_ID.test(text) ? store.panel(text) : null;
  if (byId && byId.guildId === guildId) return byId;
  const key = panelKey(text);
  if (!key) fail(C.panelBulunamadi);
  const panels = store.panelsOf(guildId);
  for (const found of [
    panels.filter((p) => panelKey(p.baslik) === key),
    panels.filter((p) => panelKey(p.baslik).includes(key)),
  ]) {
    if (found.length === 1) return found[0];
    if (found.length > 1) fail(C.panelCokluEslesme);
  }
  fail(C.panelBulunamadi);
}

/** True unless the panel's message is known to be gone (a failed lookup of the channel counts as gone). */
export async function panelMessageExists(context, panel) {
  if (!panel.mesajId) return true;
  const channel = await context.client.channels.fetch(panel.kanalId).catch(() => null);
  const message = await channel?.messages?.fetch(panel.mesajId).catch(() => null);
  return Boolean(message);
}

export async function addRole(interaction, context, store, panel, role, emoji) {
  const { guild } = interaction;
  const full = roleOf(guild, role);
  if (panel.roller.some((r) => r.id === full.id)) fail(C.rolZatenVar(full.id));
  if (panel.roller.length >= PANEL_ROL_EN_FAZLA) fail(C.panelDolu(PANEL_ROL_EN_FAZLA));
  requireAssignable(full, guild, interaction.member);
  const updated = store.setPanel(panel.id, {
    ...panel,
    roller: [...panel.roller, { id: full.id, ad: full.name ?? full.id, emoji, kim: interaction.user.id }],
  });
  return publish(context, store, updated, guild);
}

export async function removeRole(interaction, context, store, panel, roleId) {
  if (!panel.roller.some((r) => r.id === roleId)) fail(C.rolPanelde(roleId));
  const updated = store.setPanel(panel.id, { ...panel, roller: panel.roller.filter((r) => r.id !== roleId) });
  return publish(context, store, updated, interaction.guild);
}

export async function deletePanel(context, store, panel) {
  store.setPanel(panel.id, null);
  if (!panel.mesajId) return;
  const channel = await context.client.channels.fetch(panel.kanalId).catch(() => null);
  const message = await channel?.messages?.fetch(panel.mesajId).catch(() => null);
  await message?.delete().catch(() => {});
}

/** Throttled console warnings for roles that could not be handled (one per role and hour). */
const warns = new WeakMap();
const warnOf = (context) => {
  if (!warns.has(context)) warns.set(context, createThrottledWarn(context?.logger));
  return warns.get(context);
};

/**
 * Who set up each role of a panel, for src/ozellikler/_roller.js: the setter is checked on every click (still
 * in the server, still "Sunucuyu Yönet", role below their top role). A role from before setters were stored
 * (no `kim`) is never given; /ayar goster asks to set the panel up again.
 */
export const setterOfPanel = (panel) => (roleId) => panel.roller.find((r) => r.id === roleId)?.kim ?? null;

/** Panel roles without a stored setter (made before setters were kept). */
export const legacyRoles = (panel) => panel.roller.filter((r) => !r.kim).map((r) => r.id);

/**
 * Gives and takes a member's panel roles so they match `wanted` (role ids of the panel), through
 * _roller.js changeRoles (hierarchy, forbidden permissions and the setter checked again on every click).
 * With a single-choice panel only the first wanted role is kept. A role without a stored setter (an old
 * panel) is never given (`eski` is then true); taking roles away still works with the bot's own hierarchy.
 * @returns {Promise<{ eklenen: string[], kaldirilan: string[], atlanan: { rolId: string, neden: string }[],
 *   eski: boolean }>}
 */
export async function applyRoles(interaction, panel, wanted, context = null) {
  const { member } = interaction;
  const panelIds = panel.roller.map((r) => r.id);
  let target = [...new Set(wanted)].filter((id) => panelIds.includes(id));
  if (!panel.coklu) target = target.slice(0, 1);
  const has = new Set(memberRoleIds(member));
  const legacy = new Set(legacyRoles(panel));
  const wantedNew = target.filter((id) => !has.has(id));
  const add = wantedNew.filter((id) => !legacy.has(id));
  const remove = panelIds.filter((id) => has.has(id) && !target.includes(id));
  const result = await changeRoles(member, {
    add,
    remove,
    reason: panel.baslik.slice(0, 60),
    warn: warnOf(context),
    setterOf: setterOfPanel(panel),
  });
  return {
    eklenen: result.verilen,
    kaldirilan: result.alinan,
    atlanan: result.atlanan,
    eski: wantedNew.length > add.length,
  };
}

/** What a button click wants: the role toggled, the others kept (or dropped on a single-choice panel). */
export function wantedAfterClick(panel, member, roleId) {
  const panelIds = panel.roller.map((r) => r.id);
  const current = memberRoleIds(member).filter((id) => panelIds.includes(id));
  if (current.includes(roleId)) return current.filter((id) => id !== roleId);
  return panel.coklu ? [...current, roleId] : [roleId];
}
