// Takım arama (LFG) ilanları: "/oyun ara oyun:PUBG kisi:4 not:..." ya da kontrol merkezindeki "Takım ara"
// formu "1/4 aranıyor" kartı açar. "Katıl" ve "Ayrıl" düğmeleriyle dolar; dolunca katılanlar etiketlenir ve
// ilan kapanır, dolmazsa "/ayar roller-ve-ara ara-sure" saat sonra kalıcı zamanlayıcıyla kapanır (bot kapalıyken
// süresi dolan ilan açılışta kapanır). Kapanış İKİ KEZ ÇALIŞMAYA DAYANIKLIDIR: kayıt yoksa hiçbir şey yapmaz.
// Oyunun rolü "/ayar takim-ara oyun-rolu" ile ayarlandıysa ilan açılınca o rol bir kez etiketlenir.
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  RESTJSONErrorCodes,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputStyle,
} from 'discord.js';
import { escapeMarkdown } from '../../util/format.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, ozId } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { ILAN_ID, KISI_EN_AZ, KISI_EN_FAZLA } from './depo.js';
import { cevaplar as C, form as F, ilan as T } from './mesajlar.js';
import { MODUL } from './roller.js';

export const ILAN_KAPAT = `${MODUL}.ilan-kapat`;
/** One person opens at most one posting this often. */
export const ACMA_BEKLEMESI_MS = 5 * 60_000;
/** A game's role is pinged at most this often per server (later postings in that time ping nobody). */
export const ETIKET_BEKLEMESI_MS = 15 * 60_000;
export const jobIdOf = (id) => `${MODUL}.ilan.${id}`;
const OYUN_EN_FAZLA = 50;
const NOT_EN_FAZLA = 200;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const GONE = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
]);
/** Suggested in the autocomplete next to the guild's own game roles. */
export const BILINEN_OYUNLAR = Object.freeze([
  'PUBG',
  'League of Legends',
  'Valorant',
  'Counter-Strike 2',
  'Dota 2',
  'Fortnite',
  'Apex Legends',
  'Rocket League',
  'Overwatch 2',
  'Minecraft',
  'Rainbow Six Siege',
  'Call of Duty',
]);

/** When people opened postings and game roles were pinged; in memory, one set per running bot. */
const cooldowns = new WeakMap();
function cooldownsOf(context) {
  if (!cooldowns.has(context)) cooldowns.set(context, { acma: new Map(), etiket: new Map() });
  return cooldowns.get(context);
}

/** Drops entries older than `ms` and tells whether `key` is still waiting (and how long, in seconds). */
function waiting(map, key, now, ms) {
  for (const [k, at] of map) if (now - at >= ms) map.delete(k);
  return map.has(key) ? Math.ceil((ms - (now - map.get(key))) / 1000) : 0;
}

const fail = (text) => {
  throw new OzellikHatasi(text);
};

/** The key a game is stored and found by: "  League  of Legends " -> "league of legends". */
export const gameKey = (name) =>
  String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('tr');

/** A cleaned game name, or throws. */
export function readGame(value) {
  const name = String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!name || name.length > OYUN_EN_FAZLA || !/^[\p{L}\p{N} .:+'-]+$/u.test(name)) fail(C.oyunGecersiz);
  return name;
}

const mentionList = (ids) => ids.map((id) => `<@${id}>`).join(', ');

/** The posting card (Components V2). `ping` adds the game role's mention (only when the card is first sent). */
export function renderIlan(entry, { ping = false } = {}) {
  const oyun = escapeMarkdown(entry.oyun);
  const open = entry.durum === 'acik';
  const lines = [
    open
      ? T.baslik(oyun, entry.katilanlar.length, entry.kisi)
      : entry.durum === 'dolu'
        ? T.dolu(oyun, entry.kisi)
        : T.kapandi(oyun),
  ];
  if (entry.not) lines.push(T.not(escapeMarkdown(entry.not)));
  lines.push(T.katilanlar(mentionList(entry.katilanlar)));
  if (open) lines.push(T.kapanis(Math.floor(entry.bitis / 1000)));
  if (ping && entry.rolId) lines.push(T.rol(entry.rolId));
  lines.push(T.sahip(entry.sahipId));
  const container = new ContainerBuilder()
    .setAccentColor(open ? 0x2ecc71 : 0x95a5a6)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  if (open) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'katil', entry.id))
            .setEmoji('🎮')
            .setLabel(T.katil)
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'ayril', entry.id))
            .setLabel(T.ayril)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'kapat', entry.id))
            .setLabel(T.kapat)
            .setStyle(ButtonStyle.Danger),
        ),
      );
  }
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: ping && entry.rolId ? { roles: [entry.rolId] } : { parse: [] },
  };
}

/** The "Takım ara" form of the control center. */
export function ilanFormu() {
  return new ModalBuilder()
    .setCustomId(ozId(MODUL, 'ara-gonder'))
    .setTitle(F.araBaslik)
    .addLabelComponents(
      (l) =>
        l
          .setLabel(F.oyun)
          .setTextInputComponent((i) =>
            i.setCustomId('oyun').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(OYUN_EN_FAZLA),
          ),
      (l) =>
        l
          .setLabel(F.kisi)
          .setTextInputComponent((i) =>
            i.setCustomId('kisi').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(2),
          ),
      (l) =>
        l
          .setLabel(F.not)
          .setTextInputComponent((i) =>
            i.setCustomId('not').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(NOT_EN_FAZLA),
          ),
    );
}

/**
 * Opens a posting in the interaction's channel.
 * @param {{ oyun: string, kisi: number, not?: string|null }} options
 */
export async function ilanAc(interaction, context, store, { oyun, kisi, not = null }) {
  if (!interaction.guildId) fail(ortak.sunucudaKullan);
  const name = readGame(oyun);
  if (!Number.isInteger(kisi) || kisi < KISI_EN_AZ || kisi > KISI_EN_FAZLA) fail(C.kisiGecersiz);
  const userId = interaction.user.id;
  if (store.ilanlar().some((e) => e.guildId === interaction.guildId && e.sahipId === userId && e.durum === 'acik'))
    fail(C.zatenIlanVar);
  const { ayarlar, zamanlayici, saat } = context.ozellikler;
  const now = saat.now();
  const { acma, etiket } = cooldownsOf(context);
  const userKey = `${interaction.guildId}:${userId}`;
  const left = waiting(acma, userKey, now, ACMA_BEKLEMESI_MS);
  if (left) fail(C.acmaBeklemesi(Math.ceil(left / 60)));
  const game = store.gameRoles(interaction.guildId)[gameKey(name)];
  const gameKeyOf = `${interaction.guildId}:${gameKey(name)}`;
  const canPing = !waiting(etiket, gameKeyOf, now, ETIKET_BEKLEMESI_MS);
  const rolId = ayarlar.get(interaction.guildId, MODUL, 'ara-etiket') && canPing ? (game?.rolId ?? null) : null;
  const id = randomBytes(5).toString('hex');
  const note = String(not ?? '')
    .replace(CONTROL_CHARS, ' ')
    .trim()
    .slice(0, NOT_EN_FAZLA);
  const entry = store.setIlan(id, {
    guildId: interaction.guildId,
    kanalId: interaction.channelId,
    mesajId: null,
    sahipId: userId,
    oyun: game?.ad ?? name,
    kisi,
    not: note || null,
    rolId,
    katilanlar: [userId],
    olusma: now,
    bitis: now + ayarlar.get(interaction.guildId, MODUL, 'ara-sure') * 3_600_000,
    durum: 'acik',
  });
  let response;
  try {
    zamanlayici.planla({ id: jobIdOf(id), zaman: entry.bitis, tur: ILAN_KAPAT, veri: { id } });
    response = await interaction.reply({ ...renderIlan(entry, { ping: true }), withResponse: true });
  } catch (error) {
    try {
      zamanlayici.iptal(jobIdOf(id));
    } catch {
      // the job finds no posting and does nothing
    }
    store.setIlan(id, null);
    throw error;
  }
  acma.set(userKey, now);
  if (rolId) etiket.set(gameKeyOf, now);
  const mesajId = response?.resource?.message?.id ?? null;
  if (mesajId) {
    try {
      store.updateIlan(id, (e) => (e.mesajId = mesajId));
    } catch {
      // the posting works without it; only the scheduled close cannot edit the card
    }
  }
  return store.ilan(id);
}

/**
 * Closes a posting: the card shows the result and the record is deleted. Safe to run twice.
 * @param {'kapandi'|'dolu'} durum
 * @returns {Promise<object|null>} the closed posting, or null when there was none
 */
export async function ilanKapat(context, store, id, durum = 'kapandi') {
  let entry = store.ilan(id);
  if (!entry) return null;
  if (entry.durum === 'acik') entry = store.updateIlan(id, (e) => (e.durum = durum));
  if (entry.mesajId) {
    const channel = await context.client.channels.fetch(entry.kanalId).catch((error) => {
      if (GONE.has(error?.code)) return null;
      throw error; // e.g. Discord is down: the job tries again later
    });
    const message = await channel?.messages?.fetch(entry.mesajId).catch(() => null);
    await message?.edit(renderIlan(entry)).catch(() => {});
  }
  store.setIlan(id, null);
  return entry;
}

function ilanOf(store, interaction, args) {
  const id = args[0] ?? '';
  const entry = ILAN_ID.test(id) ? store.ilan(id) : null;
  if (!entry || entry.guildId !== interaction.guildId || entry.durum !== 'acik') fail(C.ilanYok);
  return entry;
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

function cancelJob(context, id) {
  try {
    context.ozellikler.zamanlayici.iptal(jobIdOf(id));
  } catch {
    // the job runs later, finds no posting and does nothing
  }
}

/** The posting's buttons (bilesenler of the module). */
export function ilanBilesenleri(storeOf) {
  return {
    async katil(interaction, context, args) {
      const store = storeOf(context);
      const entry = ilanOf(store, interaction, args);
      const userId = interaction.user.id;
      if (entry.katilanlar.includes(userId)) fail(C.zatenKatildin);
      if (entry.katilanlar.length >= entry.kisi) fail(C.ilanDolu);
      const updated = store.updateIlan(entry.id, (e) => {
        if (!e.katilanlar.includes(userId) && e.katilanlar.length < e.kisi) e.katilanlar.push(userId);
        if (e.katilanlar.length >= e.kisi) e.durum = 'dolu';
      });
      if (updated.durum !== 'dolu') {
        await interaction.update(renderIlan(updated));
        await interaction.followUp(ephemeral(C.katildin(escapeMarkdown(updated.oyun))));
        return;
      }
      // Full: the card closes and the team is pinged once.
      await interaction.update(renderIlan(updated));
      store.setIlan(updated.id, null);
      cancelJob(context, updated.id);
      await interaction.followUp({
        content: T.tamamDuyuru(mentionList(updated.katilanlar), escapeMarkdown(updated.oyun)),
        allowedMentions: { users: updated.katilanlar },
      });
    },

    async ayril(interaction, context, args) {
      const store = storeOf(context);
      const entry = ilanOf(store, interaction, args);
      const userId = interaction.user.id;
      if (entry.sahipId === userId) fail(C.sahipAyrilamaz);
      if (!entry.katilanlar.includes(userId)) fail(C.katilmadin);
      const updated = store.updateIlan(entry.id, (e) => {
        e.katilanlar = e.katilanlar.filter((uid) => uid !== userId);
      });
      await interaction.update(renderIlan(updated));
      await interaction.followUp(ephemeral(C.ayrildin));
    },

    async kapat(interaction, context, args) {
      const store = storeOf(context);
      const entry = ilanOf(store, interaction, args);
      if (entry.sahipId !== interaction.user.id && !canManageGuild(interaction)) fail(C.kapatmaYetkisi);
      const closed = store.updateIlan(entry.id, (e) => (e.durum = 'kapandi'));
      await interaction.update(renderIlan(closed));
      store.setIlan(entry.id, null);
      cancelJob(context, entry.id);
      await interaction.followUp(ephemeral(C.kapatildi));
    },

    async 'ara-ac'(interaction) {
      if (!interaction.guildId) fail(ortak.sunucudaKullan);
      await interaction.showModal(ilanFormu());
    },

    async 'ara-gonder'(interaction, context) {
      const kisiText = String(interaction.fields.getTextInputValue('kisi') ?? '').trim();
      await ilanAc(interaction, context, storeOf(context), {
        oyun: interaction.fields.getTextInputValue('oyun'),
        kisi: /^\d{1,2}$/.test(kisiText) ? Number(kisiText) : NaN,
        not: interaction.fields.getTextInputValue('not'),
      });
    },
  };
}
