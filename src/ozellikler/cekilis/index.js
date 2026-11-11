// "Çekiliş" modülü: /oyun cekilis ve kontrol merkezindeki "Çekiliş başlat" formu (yalnız "Sunucuyu Yönet").
// Katılım düğmeyledir (oz:cekilis:katil:<id>); bitiş kalıcı zamanlayıcıyla yapılır, bot kapalıyken süresi
// dolan çekiliş açılışta sonuçlanır. Bitiş İKİ KEZ ÇALIŞMAYA DAYANIKLIDIR: kazananlar tek bir eşzamanlı
// adımda seçilip kaydedilir, ikinci çalıştırma yeni kazanan seçmez, aynı anda gelen ikinci çağrı ilkinin
// bitmesini bekler; duyuru bir kez gönderilir ve gönderilmeden bitiş işi iptal edilmez. Başlatma, erken
// bitirme ve yeniden çekme yalnız "Sunucuyu Yönet" izni olanlara açıktır.
// Katılımcı kimlikleri bitişten 24 saat sonra çekilişin kaydıyla birlikte silinir (depo.js).
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
import { memberRoleIds } from '../../bot/dj.js';
import { escapeMarkdown, truncate } from '../../util/format.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, defineModule, ozDescribe, ozId, ozSubcommand } from '../_ortak.js';
import { cryptoRandom, pickSome } from '../_rastgele.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { createGiveawayStore, GIVEAWAY_ID, MAX_KATILIMCI, SAKLAMA_MS } from './depo.js';
import * as mesajlar from './mesajlar.js';
import { SURE_EN_FAZLA_GUN, sureCoz } from './sure.js';

const { komutlar: K, kart: T, duyuru: D, cevaplar: C, form: F, bolum: B } = mesajlar;

export const KAZANAN_EN_FAZLA = 20;
const ODUL_EN_FAZLA = 200;
/** Lost the message or the channel for good: the giveaway is still finished, only nothing can be shown. */
const GONE = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.UnknownMessage,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
]);

/**
 * Giveaways being finished right now: id -> the running finish. A second caller (the scheduled job and the
 * "Şimdi bitir" button at once) waits for the same run and gets its result or its error, so nobody reports
 * success while the announcement may still fail.
 */
const finishing = new Map();
/** After a failed early finish, the end job tries again this soon. */
const RETRY_AFTER_MS = 60_000;

export const jobIdOf = (id) => `cekilis.${id}`;
const cleanupJobIdOf = (id) => `cekilis.${id}.sil`;

const fail = (text) => {
  throw new OzellikHatasi(text);
};

/** The giveaway store of a running bot (data/cekilisler.json). */
export function storeOf(context) {
  const { ozellikler } = context;
  return ozellikler.depo('cekilisler', (file) =>
    createGiveawayStore({ file, now: () => ozellikler.saat.now(), logger: context.logger?.child?.('çekiliş') }),
  );
}

const nowOf = (context) => context.ozellikler.saat.now();
const seconds = (ms) => Math.floor(ms / 1000);
const mentionList = (ids) => ids.map((id) => `<@${id}>`).join(', ');
const prize = (g) => escapeMarkdown(truncate(g.odul, ODUL_EN_FAZLA));

/** The giveaway message (Components V2), open or finished. */
export function renderGiveaway(g) {
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  const row = new ActionRowBuilder();
  if (g.durum === 'acik') {
    const lines = [
      T.acikBaslik,
      T.odul(prize(g)),
      T.bitis(seconds(g.bitis)),
      T.sayilar(g.kazananSayisi, g.katilimcilar.length),
    ];
    if (g.rolId) lines.push(T.rol(g.rolId));
    if (g.sahipId) lines.push(T.baslatan(g.sahipId));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(ozId('cekilis', 'katil', g.id))
        .setEmoji('🎉')
        .setLabel(T.katil)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(ozId('cekilis', 'ayril', g.id))
        .setLabel(T.ayril)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ozId('cekilis', 'bitir', g.id))
        .setLabel(T.erkenBitir)
        .setStyle(ButtonStyle.Danger),
    );
  } else {
    const lines = [
      T.bittiBaslik,
      T.odul(prize(g)),
      g.kazananlar.length ? T.kazananlar(mentionList(g.kazananlar)) : T.kazananYok,
      `${T.katilimci(g.katilimcilar.length)} • ${T.bitti(seconds(g.bittiAt ?? g.bitis))}`,
      T.saklamaNotu(Math.round(SAKLAMA_MS / 3_600_000)),
    ];
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(ozId('cekilis', 'yeniden', g.id))
        .setEmoji('🔁')
        .setLabel(T.yenidenCek)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(g.katilimcilar.length === 0),
    );
  }
  container
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addActionRowComponents(row);
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

function announcement(text, winners) {
  const container = new ContainerBuilder()
    .setAccentColor(0xf1c40f)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { users: winners } };
}

/** Starts a giveaway in the interaction's channel. */
export async function baslat(interaction, context, { odul, sureMs, kazananSayisi = 1, rolId = null }) {
  if (!interaction.guildId) fail(ortak.sunucudaKullan);
  if (!canManageGuild(interaction)) fail(C.baslatmaYetkisi);
  const store = storeOf(context);
  const { zamanlayici } = context.ozellikler;
  const now = nowOf(context);
  const id = randomBytes(5).toString('hex');
  const giveaway = store.create({
    id,
    guildId: interaction.guildId,
    kanalId: interaction.channelId,
    mesajId: null,
    sahipId: interaction.user.id,
    odul: String(odul).trim().slice(0, ODUL_EN_FAZLA),
    kazananSayisi,
    rolId,
    olusma: now,
    bitis: now + sureMs,
    durum: 'acik',
    katilimcilar: [],
  });
  let response;
  try {
    zamanlayici.planla({ id: jobIdOf(id), zaman: giveaway.bitis, tur: 'cekilis.bitir', veri: { id } });
    response = await interaction.reply({ ...renderGiveaway(giveaway), withResponse: true });
  } catch (error) {
    // Nothing half-made stays behind: no job without a giveaway, no giveaway without a message.
    try {
      zamanlayici.iptal(jobIdOf(id));
    } catch {
      // the job file could not be written either; the job finds no giveaway and does nothing
    }
    store.remove(id);
    throw error;
  }
  const mesajId = response?.resource?.message?.id ?? null;
  try {
    if (mesajId) store.update(id, (g) => (g.mesajId = mesajId));
  } catch {
    // The giveaway works without it; only the message is not edited when it ends.
  }
  return store.get(id);
}

async function fetchChannel(context, channelId) {
  try {
    return await context.client.channels.fetch(channelId);
  } catch (error) {
    if (GONE.has(error?.code)) return null;
    throw error;
  }
}

/**
 * Finishes a giveaway: picks the winners (once), shows them on the message and announces them (once).
 * Safe to run twice, also at the same time (the scheduled job and the "Şimdi bitir" button).
 * @returns {Promise<object|null>} the finished giveaway, or null when there is none
 */
export function bitir(context, id, options) {
  if (!finishing.has(id)) {
    finishing.set(
      id,
      finish(context, id, options).finally(() => finishing.delete(id)),
    );
  }
  return finishing.get(id);
}

async function finish(context, id, { random = cryptoRandom } = {}) {
  const store = storeOf(context);
  let giveaway = store.get(id);
  if (!giveaway) return null;
  if (giveaway.durum === 'acik') {
    // The commit point: winners are picked and saved in one synchronous step.
    giveaway = store.update(id, (g) => {
      g.durum = 'bitti';
      g.kazananlar = pickSome(g.katilimcilar, g.kazananSayisi, random);
      g.cekilenler = [...g.kazananlar];
      g.bittiAt = nowOf(context);
    });
  }
  if (!giveaway.duyuruldu) {
    const channel = await fetchChannel(context, giveaway.kanalId);
    if (channel) {
      if (giveaway.mesajId) {
        const message = await channel.messages?.fetch(giveaway.mesajId).catch(() => null);
        await message?.edit(renderGiveaway(giveaway)).catch(() => {});
      }
      const text = giveaway.kazananlar.length
        ? D.kazandi(mentionList(giveaway.kazananlar), prize(giveaway))
        : D.kimseYok(prize(giveaway));
      try {
        await channel.send(announcement(text, giveaway.kazananlar));
      } catch (error) {
        if (!GONE.has(error?.code)) throw error; // e.g. Discord is down: the job tries again later
      }
    }
    giveaway = store.update(id, (g) => (g.duyuruldu = true));
  }
  // Same id every time: running twice plans the cleanup once.
  context.ozellikler.zamanlayici.planla({
    id: cleanupJobIdOf(id),
    zaman: (giveaway.bittiAt ?? giveaway.bitis) + SAKLAMA_MS,
    tur: 'cekilis.temizle',
    veri: { id },
  });
  return giveaway;
}

/** Picks new winners among those who have not won yet. @returns {object} the updated giveaway */
export function yenidenCek(context, id, { random = cryptoRandom } = {}) {
  const store = storeOf(context);
  const giveaway = store.get(id);
  if (!giveaway) fail(C.bulunamadi);
  if (giveaway.durum !== 'bitti') fail(C.bitmediHenuz);
  const pool = giveaway.katilimcilar.filter((uid) => !giveaway.cekilenler.includes(uid));
  if (!pool.length) fail(C.kalanYok);
  return store.update(id, (g) => {
    g.kazananlar = pickSome(pool, g.kazananSayisi, random);
    g.cekilenler = [...g.cekilenler, ...g.kazananlar];
  });
}

function giveawayOf(context, args) {
  const id = args[0] ?? '';
  const giveaway = GIVEAWAY_ID.test(id) ? storeOf(context).get(id) : null;
  if (!giveaway) fail(C.bulunamadi);
  return giveaway;
}

/** Ending early and re-rolling are for "Sunucuyu Yönet" only, like starting. */
function requireManager(interaction) {
  if (!canManageGuild(interaction)) fail(C.yetkiYok);
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

function giveawayForm() {
  return new ModalBuilder()
    .setCustomId(ozId('cekilis', 'gonder'))
    .setTitle(F.baslik)
    .addLabelComponents(
      (label) =>
        label
          .setLabel(F.odul)
          .setTextInputComponent((input) =>
            input.setCustomId('odul').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(ODUL_EN_FAZLA),
          ),
      (label) =>
        label
          .setLabel(F.sure)
          .setTextInputComponent((input) =>
            input.setCustomId('sure').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
          ),
      (label) =>
        label
          .setLabel(F.kazanan)
          .setDescription(F.kazananIpucu)
          .setTextInputComponent((input) =>
            input.setCustomId('kazanan').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2),
          ),
    );
}

function readDuration(text) {
  const ms = sureCoz(text);
  if (ms === null) fail(C.sureGecersiz(SURE_EN_FAZLA_GUN));
  return ms;
}

export default defineModule({
  ad: 'cekilis',
  mesajlar,
  // The giveaway message is fetched again to show the winners.
  izinler: ['ReadMessageHistory'],
  komutlar: [
    {
      ust: 'oyun',
      kategori: 'oyun',
      data: ozSubcommand('cekilis', K.cekilis)
        .addStringOption((o) => ozDescribe(o, 'odul', K.secenekler.odul).setRequired(true).setMaxLength(ODUL_EN_FAZLA))
        .addStringOption((o) => ozDescribe(o, 'sure', K.secenekler.sure).setRequired(true).setMaxLength(20))
        .addIntegerOption((o) =>
          ozDescribe(o, 'kazanan', K.secenekler.kazanan).setMinValue(1).setMaxValue(KAZANAN_EN_FAZLA),
        )
        .addRoleOption((o) => ozDescribe(o, 'rol', K.secenekler.rol)),
      async execute(interaction, context) {
        const { options } = interaction;
        if (!canManageGuild(interaction)) fail(C.baslatmaYetkisi);
        await baslat(interaction, context, {
          odul: options.getString('odul'),
          sureMs: readDuration(options.getString('sure')),
          kazananSayisi: options.getInteger('kazanan') ?? 1,
          rolId: options.getRole('rol')?.id ?? null,
        });
      },
    },
  ],
  isler: {
    bitir: async (veri, context) => {
      await bitir(context, String(veri.id ?? ''));
    },
    temizle: async (veri, context) => {
      storeOf(context).remove(String(veri.id ?? ''));
    },
  },
  olaylar(context) {
    // An open giveaway whose end job was lost (e.g. data/zamanlayici.json was deleted) still ends.
    const { zamanlayici } = context.ozellikler;
    if (zamanlayici.saltOkunur) return undefined;
    const planned = new Set(zamanlayici.bekleyenler().map((job) => job.id));
    for (const g of storeOf(context).all()) {
      if (g.durum !== 'acik' || planned.has(jobIdOf(g.id))) continue;
      try {
        zamanlayici.planla({ id: jobIdOf(g.id), zaman: g.bitis, tur: 'cekilis.bitir', veri: { id: g.id } });
      } catch (error) {
        context.logger?.warn?.(`Çekiliş bitişi planlanamadı (${g.id}): ${error?.message ?? error}`);
      }
    }
    return undefined;
  },
  menu: {
    sira: 50,
    kategori: 'oyun',
    gorunurluk: 'yonetici',
    gorunur: ({ yer }) => yer !== 'panel',
    ciz: () => [
      new TextDisplayBuilder().setContent(B.metin),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(ozId('cekilis', 'ac'))
          .setEmoji('🎉')
          .setLabel(B.baslat)
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  },
  bilesenler: {
    async katil(interaction, context, args) {
      const giveaway = giveawayOf(context, args);
      if (giveaway.durum !== 'acik') fail(C.bittiZaten);
      if (giveaway.rolId && !memberRoleIds(interaction.member).includes(giveaway.rolId))
        fail(C.rolGerekli(giveaway.rolId));
      if (giveaway.katilimcilar.includes(interaction.user.id)) fail(C.zatenKatildin);
      if (giveaway.katilimcilar.length >= MAX_KATILIMCI) fail(C.dolu(MAX_KATILIMCI));
      const updated = storeOf(context).update(giveaway.id, (g) => {
        if (g.durum === 'acik' && !g.katilimcilar.includes(interaction.user.id))
          g.katilimcilar.push(interaction.user.id);
      });
      await interaction.update(renderGiveaway(updated));
      await interaction.followUp(ephemeral(C.katildin(prize(updated))));
    },

    async ayril(interaction, context, args) {
      const giveaway = giveawayOf(context, args);
      if (giveaway.durum !== 'acik') fail(C.bittiZaten);
      if (!giveaway.katilimcilar.includes(interaction.user.id)) fail(C.katilmamissin);
      const updated = storeOf(context).update(giveaway.id, (g) => {
        g.katilimcilar = g.katilimcilar.filter((uid) => uid !== interaction.user.id);
      });
      await interaction.update(renderGiveaway(updated));
      await interaction.followUp(ephemeral(C.ayrildin));
    },

    async bitir(interaction, context, args) {
      const giveaway = giveawayOf(context, args);
      requireManager(interaction);
      if (giveaway.durum !== 'acik') fail(C.bittiZaten);
      await interaction.deferUpdate();
      const { zamanlayici, saat } = context.ozellikler;
      let done;
      try {
        done = await bitir(context, giveaway.id);
      } catch (error) {
        // Not announced yet: the end job stays and comes sooner, so the result is still posted.
        zamanlayici.planla({
          id: jobIdOf(giveaway.id),
          zaman: saat.now() + RETRY_AFTER_MS,
          tur: 'cekilis.bitir',
          veri: { id: giveaway.id },
        });
        throw error;
      }
      // The end job is only dropped once the result really went out.
      if (done?.duyuruldu) zamanlayici.iptal(jobIdOf(giveaway.id));
      await interaction.followUp(ephemeral(C.bitirildi));
    },

    async yeniden(interaction, context, args) {
      const giveaway = giveawayOf(context, args);
      requireManager(interaction);
      const updated = yenidenCek(context, giveaway.id);
      await interaction.update(renderGiveaway(updated));
      await interaction.followUp(
        announcement(D.yeniden(mentionList(updated.kazananlar), prize(updated)), updated.kazananlar),
      );
    },

    async ac(interaction) {
      if (!interaction.guildId) fail(ortak.sunucudaKullan);
      if (!canManageGuild(interaction)) fail(C.baslatmaYetkisi);
      await interaction.showModal(giveawayForm());
    },

    async gonder(interaction, context) {
      const kazananText = interaction.fields.getTextInputValue('kazanan')?.trim();
      const kazananSayisi = kazananText ? Number(kazananText) : 1;
      if (!Number.isInteger(kazananSayisi) || kazananSayisi < 1 || kazananSayisi > KAZANAN_EN_FAZLA)
        fail(K.secenekler.kazanan);
      await baslat(interaction, context, {
        odul: interaction.fields.getTextInputValue('odul'),
        sureMs: readDuration(interaction.fields.getTextInputValue('sure')),
        kazananSayisi,
      });
    },
  },
});
