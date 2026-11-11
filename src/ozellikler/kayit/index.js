// "Kayıt" modülü (MEE6'nın kayıt eklentisinin yerine): "/ayar kayit kanal" ile seçilen kanala sunucuda
// olanları kart olarak yazar. Her olay türü "/ayar kayit <tür>" ya da kontrol merkezinden açılıp kapatılır:
// giren/çıkan üyeler, silinen mesaj (içeriğiyle), düzenlenen mesaj (önce/sonra), ses kanalı giriş/çıkış/geçiş,
// rol değişimi, takma ad değişimi, yasaklama ve yasak kaldırma.
// Ayrıcalıklı intent'ler isteğe bağlıdır: Developer Portal'da "Server Members" kapalıysa üye, rol ve takma ad
// kayıtları; "Message Content" kapalıysa silinen/düzenlenen mesaj kayıtları kapalı kalır, bot çökmez.
// Silinen mesajın içeriği yalnız bot açıkken görülen mesajlar için bilinir (onbellek.js: bellekte, en fazla
// 24 saat ve kanal başına 500 mesaj; diske yazılmaz). Botların (bu bot dahil) mesajları ve kayıt kanalının
// kendisi kaydedilmez, böylece kayıt kartları yeni kayıt doğurmaz.
import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandSubcommandGroupBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { baseEmbed } from '../../util/embeds.js';
import { escapeMarkdown, formatBytes, truncate } from '../../util/format.js';
import { createSendGuard } from '../_gonderim.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, defineModule, ozId } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { CHANNEL_TYPES, validateValue } from '../ayarlar/sema.js';
import { createMessageCache, snapshotOf } from './onbellek.js';
import * as mesajlar from './mesajlar.js';

const { kart: T, bolum: B, konsol: L, komut: K, turAdlari, intentAdlari } = mesajlar;

export const MODUL = 'kayit';
/** Every event type and the gateway intents it needs. */
export const TURLER = Object.freeze({
  uyeler: ['GuildMembers'],
  silinen: ['GuildMessages', 'MessageContent'],
  duzenlenen: ['GuildMessages', 'MessageContent'],
  ses: ['GuildVoiceStates'],
  roller: ['GuildMembers'],
  'takma-ad': ['GuildMembers'],
  yasaklar: ['GuildModeration'],
});
const ICERIK_KARTTA = 1000;
const TOPLU_LISTE = 10;
const RENK = { giris: 0x2ecc71, cikis: 0xe67e22, silme: 0xe74c3c, duzenleme: 0xf1c40f, bilgi: 0x5865f2 };
/** Channels whose messages are never logged (/ayar kayit haric), e.g. a private staff channel. */
export const HARIC_EN_FAZLA = 5;
const HARIC_ANAHTARLARI = Array.from({ length: HARIC_EN_FAZLA }, (_, i) => `haric-${i + 1}`);
// Kicks are not logged separately: Discord only tells "left" (seeing who kicked needs the audit log and the
// "Denetim Kaydını Görüntüle" permission, which this module does not ask for).

/** The message cache and warning times of a running bot. */
const states = new WeakMap();
function stateOf(context) {
  if (!states.has(context)) {
    states.set(context, {
      cache: createMessageCache({ now: () => context.ozellikler.saat.now() }),
      // A log channel the bot cannot write to is paused for a while instead of failing on every event.
      guard: createSendGuard({ clock: context.ozellikler.saat, logger: context.logger }),
    });
  }
  return states.get(context);
}

/** The message cache of a running bot (tests look inside). */
export const cacheOf = (context) => stateOf(context).cache;

/** The intents an event type needs but the bot did not get from Discord. */
export function missingIntents(context, tur) {
  const names = context.ozellikler.intentPlan?.names ?? [];
  return (TURLER[tur] ?? []).filter((name) => !names.includes(name));
}

const logChannelId = (context, guildId) => context.ozellikler.ayarlar.get(guildId, MODUL, 'kanal');

/** Whether an event type is written for a guild: a log channel, the type switched on and its intents given. */
export function isActive(context, guildId, tur) {
  if (!guildId || !logChannelId(context, guildId)) return false;
  if (!context.ozellikler.ayarlar.get(guildId, MODUL, tur)) return false;
  return missingIntents(context, tur).length === 0;
}

const guardKey = (guildId) => `${MODUL}:${guildId}`;

/** While the log channel of a guild cannot be written to: { kadar, hata }, otherwise null. */
export const logPaused = (context, guildId) => stateOf(context).guard.durum(guardKey(guildId));

/**
 * Sends a card to the guild's log channel. Mentions never ping. When the channel is gone or the bot may not
 * write there, sending stops for a while (5 minutes, then longer; src/ozellikler/_gonderim.js) with one warning.
 */
async function write(context, guild, embed) {
  const channelId = logChannelId(context, guild.id);
  if (!channelId) return;
  await stateOf(context).guard.gonder(
    guardKey(guild.id),
    async () => {
      const channel = guild.channels?.cache?.get(channelId) ?? (await context.client.channels.fetch(channelId));
      await channel.send({
        embeds: [embed.setTimestamp(context.ozellikler.saat.now())],
        allowedMentions: { parse: [] },
      });
    },
    (hata, dakika) => L.gonderilemedi(channelId, hata, dakika),
  );
}

const channelOf = (guild, id) => guild?.channels?.cache?.get(id) ?? null;
/** A thread counts as its parent channel for the exclusions and the visibility rule. */
const sourceIdsOf = (guild, channelId) => [channelId, channelOf(guild, channelId)?.parentId].filter(Boolean);

/** Whether a channel (or the channel of a thread) is excluded with /ayar kayit haric. */
export function isExcluded(context, guildId, guild, channelId) {
  const excluded = HARIC_ANAHTARLARI.map((key) => context.ozellikler.ayarlar.get(guildId, MODUL, key)).filter(Boolean);
  return sourceIdsOf(guild, channelId).some((id) => excluded.includes(id));
}

/**
 * The default rule for private channels: when @everyone can read the log channel but not the channel a
 * message was in, its content is not shown (nor cached). Unknown permissions count as visible.
 */
export function isContentHidden(context, guild, channelId) {
  const log = channelOf(guild, logChannelId(context, guild?.id));
  const source = channelOf(guild, sourceIdsOf(guild, channelId).at(-1));
  if (!log?.permissionsFor || !source?.permissionsFor) return false;
  const everyone = guild.roles?.everyone ?? guild.id;
  const sees = (channel) => Boolean(channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel));
  return sees(log) && !sees(source);
}

const card = (title, color, lines) =>
  baseEmbed().setColor(color).setTitle(title).setDescription(lines.filter(Boolean).join('\n').slice(0, 4000));

/** A message text as a code block that cannot break out of itself. */
function quoted(text) {
  if (!text) return T.bos;
  return `\`\`\`\n${truncate(String(text).replaceAll('```', 'ˋˋˋ'), ICERIK_KARTTA)}\n\`\`\``;
}

const attachmentsLine = (ekler) =>
  ekler?.length ? T.ekler(ekler.map((e) => T.ek(escapeMarkdown(e.ad), formatBytes(e.boyut))).join(', ')) : null;
const tagOf = (user) => ((user?.tag ?? user?.username) ? escapeMarkdown(user.tag ?? user.username) : null);
const seconds = (ms) => Math.floor(ms / 1000);

/**
 * Messages that are never logged nor cached: bots (this one too), webhooks, the log channel itself and the
 * channels excluded with /ayar kayit haric.
 */
function skipMessage(context, message, guildId) {
  if (!guildId) return true;
  if (message.channelId === logChannelId(context, guildId)) return true;
  if (isExcluded(context, guildId, message.guild, message.channelId)) return true;
  const author = message.author;
  if (author && (author.bot || author.id === context.client?.user?.id)) return true;
  return Boolean(message.webhookId);
}

export async function onMessageCreate(context, message) {
  const guildId = message.guildId;
  if (!isActive(context, guildId, 'silinen') && !isActive(context, guildId, 'duzenlenen')) return;
  if (skipMessage(context, message, guildId) || !message.author || message.system) return;
  if (isContentHidden(context, message.guild, message.channelId)) return;
  cacheOf(context).ekle(message);
}

export async function onMessageDelete(context, message) {
  const { guild, guildId } = message;
  if (!guild || !isActive(context, guildId, 'silinen') || skipMessage(context, message, guildId)) return;
  const cached = cacheOf(context).cikar(message.channelId, message.id);
  // A message the library still had (not a partial) is known too, e.g. one sent before the log was switched on.
  const known = cached ?? (message.partial || !message.author ? null : snapshotOf(message, Date.now()));
  if (cached?.yazarId && cached.yazarId === context.client?.user?.id) return;
  const lines = [T.kanal(message.channelId)];
  if (known?.yazarId)
    lines.push(T.yazar(T.kisi(known.yazarId, known.yazarEtiket ? escapeMarkdown(known.yazarEtiket) : null)));
  else lines.push(T.yazarBilinmiyor);
  if (isContentHidden(context, guild, message.channelId)) lines.push(T.icerikGizli);
  else if (known) lines.push(`**${T.icerik}**`, quoted(known.icerik), attachmentsLine(known.ekler));
  else lines.push(T.icerikBilinmiyor);
  lines.push(T.kimlik(message.id));
  await write(context, guild, card(T.mesajSilindi, RENK.silme, lines));
}

export async function onMessageBulkDelete(context, messages, channel) {
  const guild = channel?.guild;
  if (!guild || !isActive(context, guild.id, 'silinen') || channel.id === logChannelId(context, guild.id)) return;
  if (isExcluded(context, guild.id, guild, channel.id)) return;
  const hidden = isContentHidden(context, guild, channel.id);
  const cache = cacheOf(context);
  const known = [];
  for (const message of messages.values()) {
    const entry = cache.cikar(channel.id, message.id) ?? (message.partial ? null : snapshotOf(message, Date.now()));
    if (entry && entry.yazarId !== context.client?.user?.id) known.push(entry);
  }
  const lines = [T.kanal(channel.id)];
  if (hidden) lines.push(T.icerikGizli);
  else if (known.length) {
    lines.push(T.bilinenler(known.length));
    for (const entry of known.slice(0, TOPLU_LISTE)) {
      lines.push(`• <@${entry.yazarId}>: ${escapeMarkdown(truncate(entry.icerik.replace(/\s+/g, ' '), 120)) || T.bos}`);
    }
  }
  await write(context, guild, card(T.topluSilindi(messages.size), RENK.silme, lines));
}

export async function onMessageUpdate(context, oldMessage, newMessage) {
  const { guild, guildId } = newMessage;
  if (!guild || !isActive(context, guildId, 'duzenlenen') || skipMessage(context, newMessage, guildId)) return;
  let message = newMessage;
  if (message.partial) message = await message.fetch().catch(() => null);
  if (!message || skipMessage(context, message, guildId)) return;
  const cache = cacheOf(context);
  const cached = cache.al(message.channelId, message.id);
  const before = cached ? cached.icerik : oldMessage?.partial ? null : (oldMessage?.content ?? null);
  const after = String(message.content ?? '');
  // Discord also sends updates for link previews and pins: only a changed text is an edit.
  if (before !== null ? before === after : !message.editedTimestamp) return;
  const hidden = isContentHidden(context, guild, message.channelId);
  if (message.author && !message.system && !hidden) cache.ekle(message);
  const lines = [T.kanal(message.channelId), T.yazar(T.kisi(message.author?.id ?? '0', tagOf(message.author)))];
  if (hidden) lines.push(T.icerikGizli);
  else {
    lines.push(`**${T.once}**`, before === null ? T.icerikBilinmiyor : quoted(before), `**${T.sonra}**`, quoted(after));
  }
  if (message.url) lines.push(T.mesajaGit(message.url));
  await write(context, guild, card(T.mesajDuzenlendi, RENK.duzenleme, lines));
}

export async function onMemberAdd(context, member) {
  if (!isActive(context, member.guild?.id, 'uyeler')) return;
  const lines = [T.kisi(member.id, tagOf(member.user))];
  if (Number.isFinite(member.user?.createdTimestamp)) lines.push(T.hesapAcilis(seconds(member.user.createdTimestamp)));
  await write(context, member.guild, card(T.uyeGirdi, RENK.giris, lines));
}

export async function onMemberRemove(context, member) {
  if (!isActive(context, member.guild?.id, 'uyeler')) return;
  const lines = [T.kisi(member.id, tagOf(member.user))];
  if (Number.isFinite(member.joinedTimestamp)) lines.push(T.katilma(seconds(member.joinedTimestamp)));
  await write(context, member.guild, card(T.uyeCikti, RENK.cikis, lines));
}

const roleIdsOf = (member) => new Set(member?.roles?.cache?.keys?.() ?? []);

export async function onMemberUpdate(context, oldMember, newMember) {
  const guild = newMember.guild;
  if (!guild || oldMember?.partial) return; // nothing to compare with
  const who = T.kisi(newMember.id, tagOf(newMember.user));
  if (isActive(context, guild.id, 'roller')) {
    const before = roleIdsOf(oldMember);
    const after = roleIdsOf(newMember);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    if (added.length || removed.length) {
      const list = (ids) => ids.map((id) => `<@&${id}>`).join(', ');
      await write(
        context,
        guild,
        card(T.rolDegisti, RENK.bilgi, [
          who,
          added.length ? T.verilen(list(added)) : null,
          removed.length ? T.alinan(list(removed)) : null,
        ]),
      );
    }
  }
  if (isActive(context, guild.id, 'takma-ad') && (oldMember.nickname ?? null) !== (newMember.nickname ?? null)) {
    const name = (n) => (n ? escapeMarkdown(n) : T.adYok);
    await write(
      context,
      guild,
      card(T.takmaAd, RENK.bilgi, [who, T.adlar(name(oldMember.nickname), name(newMember.nickname))]),
    );
  }
}

export async function onVoiceStateUpdate(context, oldState, newState) {
  const guild = newState?.guild ?? oldState?.guild;
  if (!guild || oldState?.channelId === newState?.channelId || !isActive(context, guild.id, 'ses')) return;
  const member = newState.member ?? oldState?.member;
  const userId = newState.id ?? oldState?.id;
  if (member?.user?.bot || userId === context.client?.user?.id) return;
  const who = T.kisi(userId, tagOf(member?.user));
  if (!oldState?.channelId) {
    await write(context, guild, card(T.sesGirdi, RENK.giris, [who, T.kanal(newState.channelId)]));
  } else if (!newState.channelId) {
    await write(context, guild, card(T.sesCikti, RENK.cikis, [who, T.kanal(oldState.channelId)]));
  } else {
    await write(
      context,
      guild,
      card(T.sesGecti, RENK.bilgi, [who, T.kanallar(oldState.channelId, newState.channelId)]),
    );
  }
}

export async function onBan(context, ban, removed = false) {
  if (!isActive(context, ban.guild?.id, 'yasaklar')) return;
  const lines = [T.kisi(ban.user?.id ?? '0', tagOf(ban.user))];
  if (ban.reason) lines.push(T.sebep(escapeMarkdown(truncate(ban.reason, 300))));
  await write(
    context,
    ban.guild,
    card(removed ? T.yasakKalkti : T.yasaklandi, removed ? RENK.giris : RENK.silme, lines),
  );
}

/** Types switched off because Discord did not give their intent, as "tür (intent)" for messages. */
function offTypes(context) {
  return Object.keys(TURLER)
    .map((tur) => ({ tur, missing: missingIntents(context, tur) }))
    .filter((t) => t.missing.length);
}

// /ayar kayit kanal|turler|haric instead of one subcommand per setting, to keep /ayar small (Discord allows
// 8000 characters per command): the settings are "gizli" (no subcommand of their own) and changed here.
const bayrak = { tur: 'bayrak', varsayilan: true, gizli: true };

function kayitGroup() {
  return new SlashCommandSubcommandGroupBuilder()
    .setName(MODUL)
    .setDescription(K.grup)
    .addSubcommand((s) =>
      s
        .setName('kanal')
        .setDescription(K.kanal)
        .addChannelOption((o) =>
          o
            .setName('kanal')
            .setDescription(K.kanalSecenek)
            .addChannelTypes(...CHANNEL_TYPES.metin),
        )
        .addBooleanOption((o) => o.setName('kapat').setDescription(K.kapat)),
    )
    .addSubcommand((s) => {
      s.setName('turler').setDescription(K.turler);
      for (const tur of Object.keys(TURLER)) s.addBooleanOption((o) => o.setName(tur).setDescription(turAdlari[tur]));
      return s;
    })
    .addSubcommand((s) =>
      s
        .setName('haric')
        .setDescription(K.haric)
        .addChannelOption((o) =>
          o
            .setName('kanal')
            .setDescription(K.haricKanal)
            .addChannelTypes(...CHANNEL_TYPES.metin),
        )
        .addBooleanOption((o) => o.setName('kaldir').setDescription(K.haricKaldir)),
    );
}

/** An excluded channel must be a text channel of this server (/ayar kayit haric and the desktop app). */
function checkExcludedChannel(channel, guild) {
  const channelGuildId = channel?.guildId ?? channel?.guild?.id;
  if (!channel || !CHANNEL_TYPES.metin.includes(channel.type) || (channelGuildId && channelGuildId !== guild?.id))
    throw new OzellikHatasi(K.haricGecersiz);
}

const excludedIds = (context, guildId) =>
  HARIC_ANAHTARLARI.map((key) => context.ozellikler.ayarlar.get(guildId, MODUL, key)).filter(Boolean);

/** The desktop app's "Kaydedilmeyen kanallar" list: replaces the whole list (same check as /ayar kayit haric). */
function setExcluded(context, guild, ids) {
  const channels = [...new Set(ids)].map((id) => guild.channels?.cache?.get(id) ?? null);
  if (channels.length > HARIC_EN_FAZLA) throw new OzellikHatasi(K.haricDolu(HARIC_EN_FAZLA));
  for (const channel of channels) checkExcludedChannel(channel, guild);
  const { ayarlar } = context.ozellikler;
  HARIC_ANAHTARLARI.forEach((key, i) => ayarlar.set(guild.id, MODUL, key, channels[i]?.id ?? null));
  for (const channel of channels) cacheOf(context).kanaliUnut(channel.id);
  return excludedIds(context, guild.id);
}

/** A new log channel: its own messages are never logged, and a pause from the old channel ends. */
function logChannelChanged(context, guildId, id) {
  if (id) cacheOf(context).kanaliUnut(id);
  stateOf(context).guard.sifirla(guardKey(guildId));
}

/** /ayar kayit haric: lists, adds or removes an excluded channel (at most HARIC_EN_FAZLA). */
function changeExcluded(context, guildId, guild, channel, remove) {
  const { ayarlar } = context.ozellikler;
  const current = HARIC_ANAHTARLARI.map((key) => ({ key, id: ayarlar.get(guildId, MODUL, key) }));
  const list = () => K.haricListe(current.filter((c) => c.id).map((c) => c.id));
  if (!channel) return list();
  const found = current.find((c) => c.id === channel.id);
  if (remove) {
    if (!found) return K.haricYok(channel.id);
    ayarlar.set(guildId, MODUL, found.key, null);
    found.id = null;
    return [K.haricKaldirildi(channel.id), list()].join('\n');
  }
  if (found) return list();
  checkExcludedChannel(channel, guild);
  const free = current.find((c) => !c.id);
  if (!free) throw new OzellikHatasi(K.haricDolu(HARIC_EN_FAZLA));
  ayarlar.set(guildId, MODUL, free.key, channel.id);
  free.id = channel.id;
  cacheOf(context).kanaliUnut(channel.id);
  return [K.haricEklendi(channel.id), list()].join('\n');
}

/** The state of every type, with the ones switched off for a missing intent. */
function typesSummary(context, guildId) {
  const { ayarlar } = context.ozellikler;
  return Object.keys(TURLER).map((tur) => {
    const missing = missingIntents(context, tur);
    if (missing.length) return B.kapaliIntent(turAdlari[tur], missing.map((n) => intentAdlari[n] ?? n).join(', '));
    return K.turSatiri(turAdlari[tur], Boolean(ayarlar.get(guildId, MODUL, tur)));
  });
}

async function kayitCommand(interaction, context) {
  const { options, guildId } = interaction;
  const { ayarlar } = context.ozellikler;
  const reply = (content) =>
    interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (options.getSubcommand() === 'kanal') {
    if (options.getBoolean('kapat')) {
      ayarlar.set(guildId, MODUL, 'kanal', null);
      await reply(K.kapatildi);
      return;
    }
    const channel = options.getChannel('kanal');
    if (!channel) {
      const current = logChannelId(context, guildId);
      await reply(current ? K.kanalKaydedildi(current) : K.kanalYok);
      return;
    }
    const id = validateValue({ tur: 'kanal', kanalTurleri: ['metin'] }, channel, { guild: interaction.guild });
    ayarlar.set(guildId, MODUL, 'kanal', id);
    logChannelChanged(context, guildId, id);
    await reply([K.kanalKaydedildi(id), ...typesSummary(context, guildId)].join('\n'));
    return;
  }
  if (options.getSubcommand() === 'haric') {
    await reply(
      changeExcluded(context, guildId, interaction.guild, options.getChannel('kanal'), options.getBoolean('kaldir')),
    );
    return;
  }
  for (const tur of Object.keys(TURLER)) {
    const value = options.getBoolean(tur);
    if (value !== null && value !== undefined) ayarlar.set(guildId, MODUL, tur, value);
  }
  await reply(typesSummary(context, guildId).join('\n'));
}

export default defineModule({
  ad: MODUL,
  mesajlar,
  // Non-privileged: message events and bans. Optional (privileged): members and message texts; without them
  // only the types that need them are off (the module itself stays on).
  intentler: ['GuildMessages', 'GuildModeration'],
  istegeBagliIntentler: ['GuildMembers', 'MessageContent'],
  // Deleted or edited messages the library never cached, and members who leave while not cached, still come.
  partials: ['Message', 'Channel', 'GuildMember'],
  ayarlar: {
    kanal: { tur: 'kanal', kanalTurleri: ['metin'], gizli: true },
    uyeler: bayrak,
    silinen: bayrak,
    duzenlenen: bayrak,
    ses: bayrak,
    roller: bayrak,
    'takma-ad': bayrak,
    yasaklar: bayrak,
    ...Object.fromEntries(
      HARIC_ANAHTARLARI.map((key) => [key, { tur: 'kanal', kanalTurleri: ['metin'], gizli: true }]),
    ),
  },
  ayarKomutlari: [{ data: kayitGroup(), execute: kayitCommand }],
  ayarListeleri: {
    haric: {
      tur: 'kanal-listesi',
      aciklama: mesajlar.listeler.haric,
      kanalTurleri: ['metin'],
      enFazla: HARIC_EN_FAZLA,
      kapsar: HARIC_ANAHTARLARI,
      oku: (context, guildId) => excludedIds(context, guildId),
      uygula: setExcluded,
    },
  },
  ayarDegisti(context, guildId, anahtar, deger) {
    if (anahtar === 'kanal') logChannelChanged(context, guildId, deger);
  },
  olaylar(context) {
    const { client } = context;
    if (!client?.on) return undefined;
    const safe =
      (handler) =>
      (...args) =>
        handler(context, ...args).catch((error) => context.logger?.debug?.(`Kayıt: ${error?.message ?? error}`));
    const listeners = [
      [Events.MessageCreate, safe(onMessageCreate)],
      [Events.MessageDelete, safe(onMessageDelete)],
      [Events.MessageBulkDelete, safe(onMessageBulkDelete)],
      [Events.MessageUpdate, safe(onMessageUpdate)],
      [Events.GuildMemberAdd, safe(onMemberAdd)],
      [Events.GuildMemberRemove, safe(onMemberRemove)],
      [Events.GuildMemberUpdate, safe(onMemberUpdate)],
      [Events.VoiceStateUpdate, safe(onVoiceStateUpdate)],
      [Events.GuildBanAdd, safe((ctx, ban) => onBan(ctx, ban, false))],
      [Events.GuildBanRemove, safe((ctx, ban) => onBan(ctx, ban, true))],
    ];
    // Told once on login, and only when some guild has a log channel: the owner then knows what is off.
    const onReady = () => {
      const off = offTypes(context);
      const used = [...(client.guilds?.cache?.keys?.() ?? [])].some((id) => logChannelId(context, id));
      if (!off.length || !used) return;
      const intents = [...new Set(off.flatMap((t) => t.missing))].map((n) => intentAdlari[n] ?? n).join(', ');
      context.logger?.warn?.(L.intentEksik(intents, off.map((t) => turAdlari[t.tur]).join(', ')));
    };
    for (const [event, listener] of listeners) client.on(event, listener);
    client.once(Events.ClientReady, onReady);
    return () => {
      for (const [event, listener] of listeners) client.off?.(event, listener);
      client.off?.(Events.ClientReady, onReady);
      states.get(context)?.cache.temizle();
    };
  },
  menu: {
    sira: 93,
    kategori: 'ayarlar',
    gorunurluk: 'yonetici',
    gorunur: ({ yer }) => yer !== 'panel',
    ciz({ context, guildId }) {
      const { ayarlar } = context.ozellikler;
      const warnings = offTypes(context).map((t) =>
        B.kapaliIntent(turAdlari[t.tur], t.missing.map((n) => intentAdlari[n] ?? n).join(', ')),
      );
      const paused = logPaused(context, guildId);
      if (paused) warnings.unshift(B.erisilemiyor(Math.floor(paused.kadar / 1000)));
      const turler = Object.keys(TURLER);
      return [
        new TextDisplayBuilder().setContent(B.metin(logChannelId(context, guildId), warnings)),
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(ozId(MODUL, 'turler'))
            .setPlaceholder(B.turSec)
            .setMinValues(0)
            .setMaxValues(turler.length)
            .addOptions(
              turler.map((tur) => ({
                label: turAdlari[tur],
                value: tur,
                default: Boolean(ayarlar.get(guildId, MODUL, tur)),
              })),
            ),
        ),
      ];
    },
  },
  bilesenler: {
    /** The event type picker of the control center: the picked types are on, the others off. */
    async turler(interaction, context) {
      if (!interaction.guildId) throw new OzellikHatasi(ortak.sunucudaKullan);
      if (!canManageGuild(interaction)) throw new OzellikHatasi(B.yoneticiGerekli);
      const picked = new Set(interaction.values ?? []);
      const { ayarlar } = context.ozellikler;
      for (const tur of Object.keys(TURLER)) {
        const on = picked.has(tur);
        if (ayarlar.get(interaction.guildId, MODUL, tur) !== on) ayarlar.set(interaction.guildId, MODUL, tur, on);
      }
      await interaction.update(context.ozellikler.menu.payloadFor(interaction, 'ayarlar'));
      await interaction.followUp({
        content: B.kaydedildi(picked.size),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    },
  },
});
