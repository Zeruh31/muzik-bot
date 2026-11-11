// "Seviye" modülü (MEE6'nın seviye sisteminin yerine): mesaj ve ses XP'si, seviye duyurusu, seviye rolleri,
// /seviye rank (görsel kart), /seviye liderlik (sayfalı), sağ tık > Uygulamalar > "Seviyesini göster" ve
// yöneticiler için /seviye ver, al, sifirla (onaylı), rol, haric, roller.
//
// Kurallar src/ozellikler/seviye/xp.js'te (MEE6 formülü). Kayıtlar data/xp.json'da (depo.js).
// Mesaj XP'si GuildMessages intent'iyle gelir; mesajın İÇERİĞİ okunmaz, Message Content intent'i gerekmez.
// Ses XP'si dakikada bir, botun o anki ses durumlarına bakılarak verilir: bot yeniden başladığında seste
// olanlar kendiliğinden sayılmaya devam eder (kapalıyken geçen süre sayılmaz).
//
// Değişmezler:
//   - XP verme kontrolü ve kaydı tek bir eşzamanlı adımdır (bekleme süresi iki mesajla aşılamaz).
//   - Onay düğmesi tek kullanımlıktır ve 5 dakika geçerlidir; tıklanınca yetki yeniden denetlenir.
//   - Rol verilemezse (hiyerarşi, izin) bot çökmez; rol atlanır ve konsola yazılır.
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ApplicationCommandType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  ContextMenuCommandBuilder,
  Events,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { memberRoleIds } from '../../bot/dj.js';
import { escapeMarkdown, truncate } from '../../util/format.js';
import { cardRendererOf, KartHatasi } from '../_kart.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, defineModule, ozCommand, ozDescribe, ozId } from '../_ortak.js';
import { createSendGuard } from '../_gonderim.js';
import { changeRoles, createThrottledWarn } from '../_roller.js';
import { fillTemplate } from '../_sablon.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { validateValue } from '../ayarlar/sema.js';
import { createXpStore, MAX_LEVEL_ROLES, MAX_EXCLUDED } from './depo.js';
import * as mesajlar from './mesajlar.js';
import {
  cooldownOver,
  levelRoles,
  MAX_ISLEM_XP,
  MAX_SEVIYE,
  MESAJ_BEKLEME_MS,
  progressOf,
  randomXp,
  SES_ARALIK_MS,
  voiceEarners,
} from './xp.js';

const { komutlar: K, kart: T, cevaplar: C, bolum: B } = mesajlar;
const MODUL = 'seviye';
export const SAYFA_BOYUTU = 10;
export const ONAY_SURESI_MS = 5 * 60 * 1000;
const ROLE_REASON = 'Seviye rolü';
const HARIC_KANAL_TURLERI = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildForum,
];
const SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

const fail = (text) => {
  throw new OzellikHatasi(text);
};
const fmt = (n) => Math.floor(n).toLocaleString('tr-TR');
const ayar = (context, guildId, key) => context.ozellikler.ayarlar.get(guildId, MODUL, key);
const nowOf = (context) => context.ozellikler.saat.now();

/** The XP store of a running bot (data/xp.json); its batch writes use the bot clock. */
export function storeOf(context) {
  const { ozellikler } = context;
  return ozellikler.depo('xp', (file) =>
    createXpStore({ file, timers: ozellikler.saat, logger: context.logger?.child?.('seviye') ?? context.logger }),
  );
}

const warners = new WeakMap();
function warnOf(context) {
  if (!warners.has(context)) warners.set(context, createThrottledWarn(context.logger));
  return warners.get(context);
}

/** Pauses sending to a channel the bot cannot write to (src/ozellikler/_gonderim.js), one per running bot. */
const guards = new WeakMap();
function guardOf(context) {
  if (!guards.has(context))
    guards.set(context, createSendGuard({ clock: context.ozellikler.saat, logger: context.logger }));
  return guards.get(context);
}

function requireGuild(interaction) {
  if (!interaction.guildId || !interaction.guild) fail(ortak.sunucudaKullan);
}
/**
 * Nobody gives XP to themselves except the server owner: XP buys level roles, so a self-grant would let an
 * admin skip earning them (and the owner can do anything anyway).
 */
function requireNotSelf(interaction, targetId) {
  if (targetId === interaction.user.id && interaction.guild?.ownerId !== interaction.user.id) fail(C.kendineVerme);
}

function requireManager(interaction) {
  requireGuild(interaction);
  if (!canManageGuild(interaction)) fail(C.yetkiYok);
}

// ---------------------------------------------------------------------------------------------------------
// Earning XP

/** The channel, its parent and its grandparent (a thread in a channel in a category). */
function channelChain(channel, channelId) {
  const ids = [channelId ?? channel?.id];
  if (channel?.parentId) ids.push(channel.parentId);
  if (channel?.parent?.parentId) ids.push(channel.parent.parentId);
  return ids.filter(Boolean);
}

/** Level roles of a member brought in line with their level. Never throws. */
export async function syncLevelRoles(context, guild, userId, level, member = null) {
  const store = storeOf(context);
  const mapping = store.roller(guild.id);
  if (!mapping.size) return null;
  const who = member?.roles?.cache ? member : await guild.members?.fetch?.(userId).catch(() => null);
  if (!who) return null;
  const { ver, al } = levelRoles(mapping, level, { yalnizEnYuksek: ayar(context, guild.id, 'yalniz-en-yuksek') });
  // Each role is checked against whoever linked it to the level (src/ozellikler/_roller.js).
  return changeRoles(who, {
    add: ver,
    remove: al,
    reason: ROLE_REASON,
    warn: warnOf(context),
    setterOf: (roleId) => store.rolAyarlayan(guild.id, roleId),
  });
}

async function announce(context, guild, userId, level, member, fallbackChannel) {
  if (!ayar(context, guild.id, 'duyuru')) return;
  const channelId = ayar(context, guild.id, 'duyuru-kanal');
  const channel = channelId
    ? (guild.channels?.cache?.get(channelId) ?? (await guild.channels?.fetch?.(channelId).catch(() => null)))
    : fallbackChannel;
  if (!channel?.send) return;
  const me = guild.members?.me;
  if (me && channel.permissionsFor && !channel.permissionsFor(me)?.has(SEND)) return;
  const name = member?.displayName ?? member?.user?.globalName ?? member?.user?.username ?? '';
  const content = fillTemplate(ayar(context, guild.id, 'duyuru-metni') ?? mesajlar.varsayilanDuyuru, {
    kullanici: `<@${userId}>`,
    ad: escapeMarkdown(name),
    seviye: level,
    sunucu: escapeMarkdown(guild.name ?? ''),
  });
  // A channel that keeps refusing (403/404, 50001, 50013) is paused for a while with one warning.
  await guardOf(context).gonder(
    `${MODUL}:${guild.id}:${channel.id}`,
    () => channel.send({ content, allowedMentions: { users: [userId] } }),
    (hata, dakika) =>
      `Seviye duyurusu gönderilemedi (sunucu ${guild.id}, kanal ${channel.id}): ${hata}. ${dakika} dakika denenmeyecek; kanal izinlerini kontrol edin.`,
  );
}

async function onLevelUp(context, { guild, userId, level, member, channel }) {
  await syncLevelRoles(context, guild, userId, level, member);
  await announce(context, guild, userId, level, member, channel).catch((error) =>
    context.logger?.debug?.(`Seviye duyurusu gönderilemedi: ${error?.message ?? error}`),
  );
}

/** MessageCreate: XP for a person's message (bots, webhooks, excluded channels and roles get none). */
export async function handleMessage(context, message) {
  const guild = message.guild;
  if (!guild || !message.guildId || message.author?.bot || message.webhookId || message.system) return null;
  if (!ayar(context, message.guildId, 'acik')) return null;
  const store = storeOf(context);
  if (store.saltOkunur) return null;
  const haric = store.haric(message.guildId);
  if (channelChain(message.channel, message.channelId).some((id) => haric.kanallar.has(id))) return null;
  if (memberRoleIds(message.member).some((id) => haric.roller.has(id))) return null;
  const result = store.mesajXp(message.guildId, message.author.id, {
    now: nowOf(context),
    amount: randomXp(),
    waitMs: MESAJ_BEKLEME_MS,
    cooldownOver,
  });
  if (result && result.sonraki > result.onceki) {
    await onLevelUp(context, {
      guild,
      userId: message.author.id,
      level: result.sonraki,
      member: message.member,
      channel: message.channel,
    });
  }
  return result;
}

/** One voice minute for every guild. @returns {number} how many people got XP */
export function voiceTick(context) {
  const { client } = context;
  const store = storeOf(context);
  if (store.saltOkunur) return 0;
  let given = 0;
  for (const guild of client?.guilds?.cache?.values?.() ?? []) {
    if (!ayar(context, guild.id, 'acik') || !ayar(context, guild.id, 'ses')) continue;
    const haric = store.haric(guild.id);
    const botId = client.user?.id ?? guild.members?.me?.id;
    const states = [];
    const byUser = new Map();
    for (const [userId, state] of guild.voiceStates?.cache ?? []) {
      const channel = guild.channels?.cache?.get(state.channelId) ?? null;
      const excluded = channelChain(channel, state.channelId).some((id) => haric.kanallar.has(id));
      byUser.set(userId, { state, channel });
      states.push({
        userId,
        channelId: excluded ? null : state.channelId,
        bot: userId === botId || Boolean(state.member?.user?.bot ?? client.users?.cache?.get(userId)?.bot),
        selfDeaf: Boolean(state.selfDeaf),
        serverDeaf: Boolean(state.serverDeaf),
        selfMute: Boolean(state.selfMute),
        serverMute: Boolean(state.serverMute),
        roleIds: memberRoleIds(state.member),
      });
    }
    const earners = voiceEarners(states, {
      afkChannelId: guild.afkChannelId ?? null,
      haricRoller: haric.roller,
    });
    for (const userId of earners) {
      const result = store.sesXp(guild.id, userId, randomXp());
      given += 1;
      if (result && result.sonraki > result.onceki) {
        const { state, channel } = byUser.get(userId);
        onLevelUp(context, { guild, userId, level: result.sonraki, member: state.member, channel }).catch((error) =>
          context.logger?.warn?.(`Seviye atlama işlenemedi: ${error?.message ?? error}`),
        );
      }
    }
  }
  return given;
}

/** A member left (raw GUILD_MEMBER_REMOVE): their record goes when the guild says so. */
export function handleLeave(context, data) {
  const guildId = data?.guild_id;
  const userId = data?.user?.id;
  if (!guildId || !userId || data.user.bot) return false;
  if (!ayar(context, guildId, 'ayrilinca-sil')) return false;
  return storeOf(context).sil(guildId, userId, { hemen: false });
}

// ---------------------------------------------------------------------------------------------------------
// Cards and pages

function avatarUrlOf(user, member) {
  const options = { extension: 'png', size: 256, forceStatic: true };
  return member?.displayAvatarURL?.(options) ?? user?.displayAvatarURL?.(options) ?? null;
}

/** Replies with someone's rank card (text only when the card cannot be drawn). */
export async function showRank(interaction, context, user, member, { ephemeral = false } = {}) {
  requireGuild(interaction);
  if (!user || user.bot) fail(C.botOlmaz);
  const store = storeOf(context);
  const record = store.kayit(interaction.guildId, user.id);
  const progress = progressOf(record?.xp ?? 0);
  const sira = store.sira(interaction.guildId, user.id);
  await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  const content = T.rankMetni(user.id, progress.seviye, fmt(progress.toplamXp), sira);
  try {
    const png = await cardRendererOf(context).rankKarti({
      ad: member?.displayName ?? user.globalName ?? user.username,
      kullaniciAdi: user.username,
      avatarUrl: avatarUrlOf(user, member),
      ...progress,
      sira,
      renk: ayar(context, interaction.guildId, 'kart-renk'),
    });
    await interaction.editReply({
      content,
      files: [new AttachmentBuilder(png, { name: T.dosyaAdi })],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (!(error instanceof KartHatasi)) context.logger?.warn?.(`Seviye kartı çizilemedi: ${error?.message ?? error}`);
    const note = error?.code === 'mesgul' ? C.mesgul : T.gorselYok;
    await interaction.editReply({ content: `${content}\n${note}`, allowedMentions: { parse: [] } });
  }
}

/** The leaderboard page `sayfa` (1-based) as a Components V2 message. */
export function renderLeaderboard(context, guildId, guildName, sayfa) {
  const store = storeOf(context);
  const { toplam } = store.liderlik(guildId, 0, 0);
  const pages = Math.max(1, Math.ceil(toplam / SAYFA_BOYUTU));
  const page = Math.min(Math.max(1, Math.floor(sayfa) || 1), pages);
  const { satirlar } = store.liderlik(guildId, page - 1, SAYFA_BOYUTU);
  const lines = satirlar.map((r) => T.liderlikSatiri(r.sira, r.userId, r.level, fmt(r.xp)));
  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(T.liderlikBaslik(escapeMarkdown(truncate(guildName ?? '', 80)))),
      new TextDisplayBuilder().setContent(lines.length ? lines.join('\n') : T.liderlikBos),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(T.liderlikAlt(page, pages, toplam)))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(ozId(MODUL, 'sayfa', String(page - 1)))
          .setEmoji('◀️')
          .setLabel(T.onceki)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page <= 1),
        new ButtonBuilder()
          .setCustomId(ozId(MODUL, 'sayfa', String(page + 1)))
          .setEmoji('▶️')
          .setLabel(T.sonraki)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page >= pages),
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

// ---------------------------------------------------------------------------------------------------------
// Admin changes with a confirmation button

/** Single-use confirmation tokens: nonce -> expiry. In memory; a restart makes old buttons invalid. */
const usedOrOpen = new Map();
function newNonce(context) {
  const now = nowOf(context);
  for (const [nonce, until] of usedOrOpen) if (until <= now) usedOrOpen.delete(nonce);
  const nonce = randomBytes(4).toString('hex');
  usedOrOpen.set(nonce, now + ONAY_SURESI_MS);
  return nonce;
}
/** Takes the token if it is still open; false when expired, unknown or already used. */
function takeNonce(context, nonce) {
  const until = usedOrOpen.get(nonce);
  usedOrOpen.delete(nonce);
  return until !== undefined && until > nowOf(context);
}

async function askConfirm(interaction, context, islem, hedefId, miktar, text) {
  const nonce = newNonce(context);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ozId(MODUL, 'onay', islem, hedefId ?? '-', String(miktar), nonce))
      .setLabel(C.onayla)
      .setStyle(islem === 'ver' ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(ozId(MODUL, 'iptal', nonce))
      .setLabel(C.vazgec)
      .setStyle(ButtonStyle.Secondary),
  );
  await interaction.reply({
    content: text,
    components: [row],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

async function doConfirmed(interaction, context, [islem, hedef, miktarText, nonce]) {
  requireManager(interaction);
  if (!takeNonce(context, nonce)) fail(C.onayEski);
  const store = storeOf(context);
  const guildId = interaction.guildId;
  const miktar = Number(miktarText);
  const hedefId = /^\d{17,20}$/.test(hedef ?? '') ? hedef : null;
  let text;
  let level = null;
  if (islem === 'ver' && hedefId) requireNotSelf(interaction, hedefId);
  if (
    (islem === 'ver' || islem === 'al') &&
    hedefId &&
    Number.isInteger(miktar) &&
    miktar > 0 &&
    miktar <= MAX_ISLEM_XP
  ) {
    const result = store.xpDegistir(guildId, hedefId, islem === 'ver' ? miktar : -miktar);
    level = result.sonraki;
    text = (islem === 'ver' ? C.verildi : C.alindi)(hedefId, fmt(miktar), result.sonraki);
  } else if (islem === 'sifirla' && hedefId) {
    text = store.sil(guildId, hedefId) ? C.silindi(hedefId) : C.kayitYok(hedefId);
    level = 0;
  } else if (islem === 'hepsi') {
    text = C.hepsiSilindi(store.sunucuyuSifirla(guildId));
  } else {
    fail(ortak.eskiDugme);
  }
  await interaction.update({ content: text, components: [], allowedMentions: { parse: [] } });
  if (hedefId && level !== null) await syncLevelRoles(context, interaction.guild, hedefId, level);
}

// ---------------------------------------------------------------------------------------------------------
// Commands

function seviyeData() {
  return ozCommand('seviye', K.seviye)
    .addSubcommand((s) =>
      s
        .setName('rank')
        .setDescription(K.alt.rank)
        .addUserOption((o) => ozDescribe(o, 'kullanici', K.secenekler.kullanici)),
    )
    .addSubcommand((s) =>
      s
        .setName('liderlik')
        .setDescription(K.alt.liderlik)
        .addIntegerOption((o) => ozDescribe(o, 'sayfa', K.secenekler.sayfa).setMinValue(1).setMaxValue(1000)),
    )
    .addSubcommand((s) =>
      s
        .setName('ver')
        .setDescription(K.alt.ver)
        .addUserOption((o) => ozDescribe(o, 'kullanici', K.secenekler.hedef).setRequired(true))
        .addIntegerOption((o) =>
          ozDescribe(o, 'xp', K.secenekler.xp).setRequired(true).setMinValue(1).setMaxValue(MAX_ISLEM_XP),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('al')
        .setDescription(K.alt.al)
        .addUserOption((o) => ozDescribe(o, 'kullanici', K.secenekler.hedef).setRequired(true))
        .addIntegerOption((o) =>
          ozDescribe(o, 'xp', K.secenekler.xp).setRequired(true).setMinValue(1).setMaxValue(MAX_ISLEM_XP),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('sifirla')
        .setDescription(K.alt.sifirla)
        .addUserOption((o) => ozDescribe(o, 'kullanici', K.secenekler.sifirlaKullanici)),
    )
    .addSubcommand((s) =>
      s
        .setName('rol')
        .setDescription(K.alt.rol)
        .addIntegerOption((o) =>
          ozDescribe(o, 'seviye', K.secenekler.seviye).setRequired(true).setMinValue(1).setMaxValue(MAX_SEVIYE),
        )
        .addRoleOption((o) => ozDescribe(o, 'rol', K.secenekler.rol)),
    )
    .addSubcommand((s) =>
      s
        .setName('haric')
        .setDescription(K.alt.haric)
        .addChannelOption((o) => ozDescribe(o, 'kanal', K.secenekler.kanal).addChannelTypes(...HARIC_KANAL_TURLERI))
        .addRoleOption((o) => ozDescribe(o, 'rol', K.secenekler.haricRol)),
    )
    .addSubcommand((s) => s.setName('roller').setDescription(K.alt.roller));
}

/** What /seviye haric (and the desktop app's lists) accept: a channel of this server that can earn XP, a role but @everyone. */
function checkHaric(tur, target, guild) {
  if (tur === 'rol') {
    if (!target?.id || target.id === guild?.id) fail(C.haricSec);
    return;
  }
  const channelGuildId = target?.guildId ?? target?.guild?.id;
  if (!target?.id || !HARIC_KANAL_TURLERI.includes(target.type) || (channelGuildId && channelGuildId !== guild?.id))
    fail(C.haricSec);
}

/** The desktop app's excluded channel or role list: replaces the whole list, checked like /seviye haric. */
const setHaric = (tur) => (context, guild, ids) => {
  requireWritable(context);
  const unique = [...new Set(ids)];
  if (unique.length > MAX_EXCLUDED) fail(C.haricDurum.dolu(tur === 'kanal' ? 'Kanallar' : 'Roller', MAX_EXCLUDED));
  const cache = tur === 'kanal' ? guild.channels?.cache : guild.roles?.cache;
  for (const id of unique) checkHaric(tur, cache?.get(id) ?? null, guild);
  const store = storeOf(context);
  const current = tur === 'kanal' ? store.haric(guild.id).kanallar : store.haric(guild.id).roller;
  // Removals first, so a full list can be swapped in one go.
  for (const id of current) if (!unique.includes(id)) store.haricDegistir(guild.id, tur, id);
  for (const id of unique) if (!current.has(id)) store.haricDegistir(guild.id, tur, id);
  return haricOf(context, guild.id, tur);
};

const haricOf = (context, guildId, tur) => {
  const haric = storeOf(context).haric(guildId);
  return [...(tur === 'kanal' ? haric.kanallar : haric.roller)];
};

function requireWritable(context) {
  if (storeOf(context).saltOkunur) fail(C.saltOkunur);
}

const subcommands = {
  rank: (interaction, context) =>
    showRank(
      interaction,
      context,
      interaction.options.getUser('kullanici') ?? interaction.user,
      interaction.options.getUser('kullanici') ? interaction.options.getMember('kullanici') : interaction.member,
    ),

  async liderlik(interaction, context) {
    requireGuild(interaction);
    await interaction.reply(
      renderLeaderboard(
        context,
        interaction.guildId,
        interaction.guild.name,
        interaction.options.getInteger('sayfa') ?? 1,
      ),
    );
  },

  async ver(interaction, context) {
    requireManager(interaction);
    requireWritable(context);
    const user = interaction.options.getUser('kullanici', true);
    if (user.bot) fail(C.botOlmaz);
    requireNotSelf(interaction, user.id);
    const xp = interaction.options.getInteger('xp', true);
    await askConfirm(interaction, context, 'ver', user.id, xp, C.onaySor.ver(user.id, fmt(xp)));
  },

  async al(interaction, context) {
    requireManager(interaction);
    requireWritable(context);
    const user = interaction.options.getUser('kullanici', true);
    if (user.bot) fail(C.botOlmaz);
    const xp = interaction.options.getInteger('xp', true);
    await askConfirm(interaction, context, 'al', user.id, xp, C.onaySor.al(user.id, fmt(xp)));
  },

  async sifirla(interaction, context) {
    requireManager(interaction);
    requireWritable(context);
    const user = interaction.options.getUser('kullanici');
    if (user) await askConfirm(interaction, context, 'sifirla', user.id, 0, C.onaySor.sifirla(user.id));
    else await askConfirm(interaction, context, 'hepsi', null, 0, C.onaySor.hepsi);
  },

  async rol(interaction, context) {
    requireManager(interaction);
    requireWritable(context);
    const seviye = interaction.options.getInteger('seviye', true);
    const role = interaction.options.getRole('rol');
    const store = storeOf(context);
    let text;
    if (!role) {
      text = store.rolAyarla(interaction.guildId, seviye, null) ? C.rolKaldirildi(seviye) : C.rolYoktu(seviye);
    } else {
      // Same checks as /ayar: not @everyone, not managed, no admin rights, below the bot's highest role.
      // ... and below the highest role of whoever links it (the owner excepted); checked again when given.
      const roleId = validateValue({ tur: 'rol', verilebilir: true }, role, {
        guild: interaction.guild,
        member: interaction.member,
      });
      if (!store.rolAyarla(interaction.guildId, seviye, roleId, interaction.user.id)) fail(C.rolDolu(MAX_LEVEL_ROLES));
      text = C.rolBaglandi(seviye, roleId);
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },

  async haric(interaction, context) {
    requireManager(interaction);
    requireWritable(context);
    const channel = interaction.options.getChannel('kanal');
    const role = interaction.options.getRole('rol');
    if (!channel && !role) fail(C.haricSec);
    const store = storeOf(context);
    const lines = [];
    for (const [tur, id, ne] of [
      ['kanal', channel?.id, channel ? `<#${channel.id}>` : null],
      ['rol', role?.id, role ? `<@&${role.id}>` : null],
    ]) {
      if (!id) continue;
      checkHaric(tur, tur === 'kanal' ? channel : role, interaction.guild ?? { id: interaction.guildId });
      const result = store.haricDegistir(interaction.guildId, tur, id);
      lines.push(result === 'dolu' ? C.haricDurum.dolu(ne, MAX_EXCLUDED) : C.haricDurum[result](ne));
    }
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },

  async roller(interaction, context) {
    requireGuild(interaction);
    await interaction.reply({
      content: settingsText(context, interaction.guildId),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  },
};

/** Level roles, role mode and excluded lists of a guild, as text. */
export function settingsText(context, guildId) {
  const store = storeOf(context);
  const roles = [...store.roller(guildId)].map(([level, roleId]) => C.rollerSatiri(level, roleId));
  const haric = store.haric(guildId);
  return [
    C.rollerBaslik,
    ...(roles.length ? roles : [C.rollerYok]),
    C.rolModu(ayar(context, guildId, 'yalniz-en-yuksek')),
    C.haricKanallar([...haric.kanallar].map((id) => `<#${id}>`).join(', ')),
    C.haricRoller([...haric.roller].map((id) => `<@&${id}>`).join(', ')),
  ].join('\n');
}

export default defineModule({
  ad: MODUL,
  mesajlar,
  // Message XP counts messages (author, channel, time); their text is never read.
  intentler: ['GuildMessages'],
  izinler: ['ManageRoles', 'AttachFiles'],
  ayarlar: {
    acik: { tur: 'bayrak', varsayilan: true },
    ses: { tur: 'bayrak', varsayilan: true },
    duyuru: { tur: 'bayrak', varsayilan: true },
    'duyuru-kanal': { tur: 'kanal', kanalTurleri: ['metin'] },
    'duyuru-metni': { tur: 'metin', enAz: 1, enFazla: 300, varsayilan: mesajlar.varsayilanDuyuru },
    'yalniz-en-yuksek': { tur: 'bayrak', varsayilan: false },
    'ayrilinca-sil': { tur: 'bayrak', varsayilan: false },
    'kart-renk': { tur: 'metin', enAz: 7, enFazla: 7, varsayilan: '#5865f2' },
  },
  ayarListeleri: {
    'haric-kanallar': {
      tur: 'kanal-listesi',
      aciklama: mesajlar.listeler.haricKanallar,
      kanalTurleri: ['metin', 'ses', 'kategori', 'forum'],
      enFazla: MAX_EXCLUDED,
      oku: (context, guildId) => haricOf(context, guildId, 'kanal'),
      uygula: setHaric('kanal'),
    },
    'haric-roller': {
      tur: 'rol-listesi',
      aciklama: mesajlar.listeler.haricRoller,
      enFazla: MAX_EXCLUDED,
      oku: (context, guildId) => haricOf(context, guildId, 'rol'),
      uygula: setHaric('rol'),
    },
    roller: {
      tur: 'ozel',
      aciklama: mesajlar.listeler.roller,
      yalnizDiscord: '/seviye rol',
      oku: (context, guildId) =>
        [...storeOf(context).roller(guildId)].map(([level, roleId]) => C.rollerSatiri(level, roleId)),
    },
  },
  komutlar: [
    {
      data: seviyeData(),
      kategori: MODUL,
      async execute(interaction, context) {
        const handler = subcommands[interaction.options.getSubcommand()];
        if (!handler) throw new Error('/seviye: bilinmeyen alt komut');
        await handler(interaction, context);
      },
    },
    {
      data: new ContextMenuCommandBuilder()
        .setName(K.seviyesiniGoster)
        .setType(ApplicationCommandType.User)
        .setContexts(InteractionContextType.Guild),
      kategori: MODUL,
      execute: (interaction, context) =>
        showRank(interaction, context, interaction.targetUser, interaction.targetMember, { ephemeral: true }),
    },
  ],
  menu: {
    sira: 60,
    gorunurluk: 'herkes',
    // The fixed panel is for music; its 40-component budget is kept for that.
    gorunur: ({ yer }) => yer !== 'panel',
    ciz: () => [
      new TextDisplayBuilder().setContent(B.metin),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(ozId(MODUL, 'kart'))
          .setEmoji('🪪')
          .setLabel(B.kart)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(ozId(MODUL, 'liderlik'))
          .setEmoji('🏆')
          .setLabel(B.liderlik)
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  },
  bilesenler: {
    kart: (interaction, context) =>
      showRank(interaction, context, interaction.user, interaction.member, { ephemeral: true }),

    async liderlik(interaction, context) {
      requireGuild(interaction);
      const payload = renderLeaderboard(context, interaction.guildId, interaction.guild.name, 1);
      await interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
    },

    async sayfa(interaction, context, [n]) {
      requireGuild(interaction);
      await interaction.update(renderLeaderboard(context, interaction.guildId, interaction.guild.name, Number(n)));
    },

    onay: (interaction, context, args) => doConfirmed(interaction, context, args),

    async iptal(interaction, context, [nonce]) {
      usedOrOpen.delete(nonce);
      await interaction.update({ content: C.vazgecildi, components: [] });
    },
  },
  olaylar(context) {
    const { client } = context;
    const store = storeOf(context);
    const saat = context.ozellikler.saat;
    const offs = [];
    if (typeof client?.on === 'function') {
      const onMessage = (message) =>
        handleMessage(context, message).catch((error) =>
          context.logger?.warn?.(`Mesaj XP'si işlenemedi: ${error?.message ?? error}`),
        );
      // Only the leave packet is needed; it comes when the Server Members Intent is on (karşılama modülü).
      const onRaw = (packet) => {
        if (packet?.t !== 'GUILD_MEMBER_REMOVE') return;
        try {
          handleLeave(context, packet.d);
        } catch (error) {
          context.logger?.warn?.(`Ayrılan üyenin XP kaydı silinemedi: ${error?.message ?? error}`);
        }
      };
      client.on(Events.MessageCreate, onMessage);
      client.on(Events.Raw, onRaw);
      offs.push(
        () => client.off(Events.MessageCreate, onMessage),
        () => client.off(Events.Raw, onRaw),
      );
    }
    let timer = null;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      timer = saat.setTimeout(() => {
        try {
          voiceTick(context);
        } catch (error) {
          context.logger?.warn?.(`Ses XP'si işlenemedi: ${error?.message ?? error}`);
        } finally {
          loop();
        }
      }, SES_ARALIK_MS);
    };
    loop();
    return () => {
      stopped = true;
      if (timer !== null) saat.clearTimeout(timer);
      for (const off of offs) off();
      store.kapat();
    };
  },
});
