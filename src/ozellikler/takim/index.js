// "Takım" modülü: /oyun takim, sağ tık > Uygulamalar > "Takıma ekle" ve kontrol merkezinde "2/3/4 takım".
// Komutu yazanın ses kanalındaki insanlar (botlar hariç) rastgele ve dengeli bölünür; isteğe bağlı kaptan
// seçilir. "Yeniden karıştır" yalnız kurana ve "Sunucuyu Yönet" iznine açıktır; "Kanallara taşı" için ayrıca
// "Üyeleri Taşı" (ya da "Sunucuyu Yönet") izni gerekir ve hedef kanala giremeyen üye taşınmaz.
// Takım listeleri yalnız bellekte ve en çok 3 saat tutulur (diske yazılmaz); bot yeniden başlayınca
// eski listelerin düğmeleri "artık geçerli değil" der.
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ContainerBuilder,
  ContextMenuCommandBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';
import { humansInVoice } from '../../bot/dj.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, defineModule, ozDescribe, ozId, ozSubcommand } from '../_ortak.js';
import { cryptoRandom, shuffle } from '../_rastgele.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import * as mesajlar from './mesajlar.js';

const { komutlar: K, kart: T, cevaplar: C, bolum: B } = mesajlar;

export const TAKIM_EN_AZ = 2;
export const TAKIM_EN_FAZLA = 4;
/** How long a team list stays usable (in memory only). */
export const SAKLAMA_MS = 3 * 60 * 60 * 1000;
const MAX_LISTS = 200;
const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
const TARGET_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.MoveMembers,
];

/**
 * Splits people into `count` teams as evenly as possible (sizes differ by at most one), at random.
 * With `kaptanli`, each team's first member is its captain (also random).
 * @returns {{ takimlar: string[][], kaptanlar: (string|null)[] }}
 */
export function takimlaraBol(people, count, { kaptanli = false, random = cryptoRandom } = {}) {
  if (!Number.isInteger(count) || count < TAKIM_EN_AZ || count > TAKIM_EN_FAZLA) throw new RangeError('count');
  const takimlar = Array.from({ length: count }, () => []);
  // Which teams get the extra people is random too, so team 1 is not always the bigger one.
  const order = shuffle(
    Array.from({ length: count }, (_, i) => i),
    random,
  );
  shuffle([...new Set(people)], random).forEach((id, i) => takimlar[order[i % count]].push(id));
  return { takimlar, kaptanlar: takimlar.map((t) => (kaptanli ? (t[0] ?? null) : null)) };
}

/** Adds someone to the smallest team (the first of the smallest). @returns {number} the team index */
export function enKucugeEkle(takimlar, id) {
  let index = 0;
  takimlar.forEach((t, i) => {
    if (t.length < takimlar[index].length) index = i;
  });
  takimlar[index].push(id);
  return index;
}

/** In-memory team lists: id -> list, and "guild:owner" -> the owner's latest list. */
export function createTeamStore({ now = () => Date.now() } = {}) {
  const lists = new Map();
  const latest = new Map();
  const forget = (id) => {
    const list = lists.get(id);
    lists.delete(id);
    const key = `${list.guildId}:${list.sahipId}`;
    if (latest.get(key) === id) latest.delete(key);
  };
  const prune = () => {
    for (const [id, list] of lists) if (now() - list.olusma > SAKLAMA_MS) forget(id);
    // The oldest lists go first when there are too many (Map keeps insertion order).
    while (lists.size > MAX_LISTS) forget(lists.keys().next().value);
  };
  return {
    ekle(list) {
      const id = randomBytes(5).toString('hex');
      lists.set(id, { ...list, id, olusma: now() });
      latest.set(`${list.guildId}:${list.sahipId}`, id);
      prune();
      return lists.get(id) ?? null;
    },
    al(id) {
      prune();
      return lists.get(id) ?? null;
    },
    sonListe(guildId, sahipId) {
      prune();
      return lists.get(latest.get(`${guildId}:${sahipId}`)) ?? null;
    },
    temizle() {
      lists.clear();
      latest.clear();
    },
  };
}

/** The bot's team lists (tests reach it to look inside). */
export const takimDeposu = createTeamStore();

function requireGuild(interaction) {
  if (!interaction.guildId || !interaction.guild) throw new OzellikHatasi(ortak.sunucudaKullan);
}

function voiceChannelOf(interaction) {
  return (
    interaction.member?.voice?.channelId ??
    interaction.guild.voiceStates?.cache?.get(interaction.user.id)?.channelId ??
    null
  );
}

/** Moving people needs "Üyeleri Taşı" or "Sunucuyu Yönet" of the one who asks (the bot's own right is not enough). */
export const canMoveMembers = (interaction) =>
  canManageGuild(interaction) || Boolean(interaction?.memberPermissions?.has?.(PermissionFlagsBits.MoveMembers));

const JOIN_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];
const canJoin = (channel, who) => Boolean(who && channel?.permissionsFor?.(who)?.has(JOIN_PERMISSIONS));

function requireOwner(interaction, list) {
  if (list.sahipId !== interaction.user.id && !canManageGuild(interaction)) throw new OzellikHatasi(C.yetkiYok);
}

/** The pool of a list: who is in its voice channel now, plus those added with "Takıma ekle". */
function poolOf(guild, list) {
  return [...new Set([...humansInVoice(guild, list.kaynakKanalId), ...list.eklenenler])];
}

/** The Components V2 message of a team list. */
export function renderTeams(list) {
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(T.baslik(list.takimlar.length)));
  list.takimlar.forEach((members, i) => {
    const lines = [T.takim(i + 1, members.length) + (list.kanallar[i] ? ` ${T.kanal(list.kanallar[i])}` : '')];
    if (!members.length) lines.push(T.bos);
    for (const id of members) lines.push(`${list.kaptanlar[i] === id ? `${T.kaptan} ` : '• '}<@${id}>`);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 900)));
  });
  const canMove = list.kanallar.length >= list.takimlar.length;
  const footer = canMove ? T.altBilgi(list.sahipId) : `${T.altBilgi(list.sahipId)}\n-# ${T.tasiKanalYok}`;
  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(footer))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(ozId('takim', 'karistir', list.id))
          .setEmoji('🔀')
          .setLabel(T.karistir)
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(ozId('takim', 'tasi', list.id))
          .setEmoji('🚚')
          .setLabel(T.tasi)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!canMove),
      ),
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/** Builds a new team list from the user's voice channel and replies with it. */
export async function kur(interaction, { takimSayisi = TAKIM_EN_AZ, kaptanli = false, kanallar = [] } = {}) {
  requireGuild(interaction);
  const kaynakKanalId = voiceChannelOf(interaction);
  if (!kaynakKanalId) throw new OzellikHatasi(C.sesteDegilsin);
  const people = humansInVoice(interaction.guild, kaynakKanalId);
  if (people.length < takimSayisi) throw new OzellikHatasi(C.azKisi(takimSayisi, people.length));
  if (new Set(kanallar).size !== kanallar.length) throw new OzellikHatasi(C.kanalAyni);
  if (kanallar.length && !canMoveMembers(interaction)) throw new OzellikHatasi(C.tasimaYetkisi);
  const { takimlar, kaptanlar } = takimlaraBol(people, takimSayisi, { kaptanli });
  const list = takimDeposu.ekle({
    guildId: interaction.guildId,
    sahipId: interaction.user.id,
    kaynakKanalId,
    kaptanli,
    kanallar,
    takimlar,
    kaptanlar,
    eklenenler: [],
    kanalId: interaction.channelId ?? null,
    mesajId: null,
  });
  const response = await interaction.reply({ ...renderTeams(list), withResponse: true });
  list.mesajId = response?.resource?.message?.id ?? null;
  return list;
}

/**
 * Checks who asks and the channels, then moves every team member who is in voice to their team's channel.
 * The one who asks needs "Üyeleri Taşı" (or "Sunucuyu Yönet") and must be able to join the source and target
 * channels; a member who could not join their team's channel is skipped, so the bot never lets anyone in.
 */
export async function tasi(interaction, list) {
  const { guild } = interaction;
  const me = guild.members?.me;
  if (!canMoveMembers(interaction)) throw new OzellikHatasi(C.tasimaYetkisi);
  if (list.kanallar.length < list.takimlar.length) throw new OzellikHatasi(C.kanalEksik(list.takimlar.length));
  if (me?.permissions && !me.permissions.has(PermissionFlagsBits.MoveMembers)) throw new OzellikHatasi(C.botTasiyamaz);
  const channels = list.kanallar.slice(0, list.takimlar.length).map((id) => guild.channels?.cache?.get(id) ?? null);
  const source = guild.channels?.cache?.get(list.kaynakKanalId) ?? null;
  if (source && !canJoin(source, interaction.member)) throw new OzellikHatasi(C.sizeKapali(list.kaynakKanalId));
  for (const [i, channel] of channels.entries()) {
    const id = list.kanallar[i];
    if (!channel || !VOICE_TYPES.includes(channel.type)) throw new OzellikHatasi(C.kanalIzni(id));
    if (me && channel.permissionsFor && !channel.permissionsFor(me)?.has(TARGET_PERMISSIONS))
      throw new OzellikHatasi(C.kanalIzni(id));
    if (!canJoin(channel, interaction.member)) throw new OzellikHatasi(C.sizeKapali(id));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // Only people still in voice, and only from the list's own voice channel or its team channels.
  const allowedFrom = new Set([list.kaynakKanalId, ...list.kanallar]);
  let tasinan = 0;
  let atlanan = 0;
  let izinsiz = 0;
  for (const [i, members] of list.takimlar.entries()) {
    for (const userId of members) {
      const state = guild.voiceStates?.cache?.get(userId);
      if (!state?.channelId || !allowedFrom.has(state.channelId)) {
        atlanan += 1;
        continue;
      }
      if (state.channelId === channels[i].id) {
        tasinan += 1;
        continue;
      }
      const member = state.member ?? guild.members?.cache?.get(userId) ?? null;
      if (!canJoin(channels[i], member)) {
        izinsiz += 1;
        continue;
      }
      try {
        await state.setChannel(channels[i]);
        tasinan += 1;
      } catch {
        atlanan += 1;
      }
    }
  }
  await interaction.editReply({ content: C.tasindi(tasinan, atlanan, izinsiz), allowedMentions: { parse: [] } });
}

function listOf(args) {
  const list = takimDeposu.al(args[0] ?? '');
  if (!list) throw new OzellikHatasi(C.suresiDoldu);
  return list;
}

function takimData() {
  const sub = ozSubcommand('takim', K.takim)
    .addIntegerOption((o) =>
      ozDescribe(o, 'takimlar', K.secenekler.takimlar).setMinValue(TAKIM_EN_AZ).setMaxValue(TAKIM_EN_FAZLA),
    )
    .addBooleanOption((o) => ozDescribe(o, 'kaptan', K.secenekler.kaptan));
  for (let n = 1; n <= TAKIM_EN_FAZLA; n += 1) {
    sub.addChannelOption((o) => ozDescribe(o, `kanal${n}`, K.secenekler.kanal(n)).addChannelTypes(...VOICE_TYPES));
  }
  return sub;
}

/** Right click on a member > Apps > "Takıma ekle": adds them to the smallest team of your latest list. */
async function takimaEkle(interaction, context) {
  requireGuild(interaction);
  const target = interaction.targetUser;
  if (!target || target.bot) throw new OzellikHatasi(C.ekleBotOlmaz);
  const list = takimDeposu.sonListe(interaction.guildId, interaction.user.id);
  if (!list) throw new OzellikHatasi(C.ekleListeYok);
  const kisi = `<@${target.id}>`;
  if (list.takimlar.some((t) => t.includes(target.id))) throw new OzellikHatasi(C.ekleZatenVar(kisi));
  const index = enKucugeEkle(list.takimlar, target.id);
  list.eklenenler.push(target.id);
  await interaction.reply({
    content: C.eklendi(kisi, index + 1),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
  if (list.kanalId && list.mesajId) {
    const channel = await context.client?.channels?.fetch(list.kanalId).catch(() => null);
    const message = await channel?.messages?.fetch(list.mesajId).catch(() => null);
    await message?.edit(renderTeams(list)).catch(() => {});
  }
}

export default defineModule({
  ad: 'takim',
  mesajlar,
  izinler: ['MoveMembers'],
  komutlar: [
    {
      ust: 'oyun',
      kategori: 'oyun',
      data: takimData(),
      async execute(interaction) {
        const kanallar = [];
        for (let n = 1; n <= TAKIM_EN_FAZLA; n += 1) {
          const channel = interaction.options.getChannel(`kanal${n}`);
          if (channel) kanallar.push(channel.id);
        }
        await kur(interaction, {
          takimSayisi: interaction.options.getInteger('takimlar') ?? TAKIM_EN_AZ,
          kaptanli: Boolean(interaction.options.getBoolean('kaptan')),
          kanallar,
        });
      },
    },
    {
      data: new ContextMenuCommandBuilder()
        .setName(K.takimaEkle)
        .setType(ApplicationCommandType.User)
        .setContexts(InteractionContextType.Guild),
      kategori: 'oyun',
      execute: takimaEkle,
    },
  ],
  menu: {
    sira: 20,
    kategori: 'oyun',
    gorunurluk: 'herkes',
    // The fixed panel is for music; its 40-component budget is kept for that.
    gorunur: ({ yer }) => yer !== 'panel',
    ciz: () => [
      new TextDisplayBuilder().setContent(B.metin),
      new ActionRowBuilder().addComponents(
        [2, 3, 4].map((n) =>
          new ButtonBuilder()
            .setCustomId(ozId('takim', 'kur', String(n)))
            .setEmoji('👥')
            .setLabel(B.kur(n))
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    ],
  },
  bilesenler: {
    async kur(interaction, context, [n]) {
      const takimSayisi = Number(n);
      if (!Number.isInteger(takimSayisi) || takimSayisi < TAKIM_EN_AZ || takimSayisi > TAKIM_EN_FAZLA)
        throw new OzellikHatasi(ortak.eskiDugme);
      await kur(interaction, { takimSayisi });
    },

    async karistir(interaction, context, args) {
      requireGuild(interaction);
      const list = listOf(args);
      requireOwner(interaction, list);
      const people = poolOf(interaction.guild, list);
      if (people.length < list.takimlar.length) throw new OzellikHatasi(C.azKisi(list.takimlar.length, people.length));
      Object.assign(list, takimlaraBol(people, list.takimlar.length, { kaptanli: list.kaptanli }));
      list.mesajId = interaction.message?.id ?? list.mesajId;
      list.kanalId = interaction.channelId ?? list.kanalId;
      await interaction.update(renderTeams(list));
    },

    async tasi(interaction, context, args) {
      requireGuild(interaction);
      const list = listOf(args);
      requireOwner(interaction, list);
      await tasi(interaction, list);
    },
  },
  kapat: () => takimDeposu.temizle(),
});
