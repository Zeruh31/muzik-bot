// "Roller ve takım arama" modülü (MEE6'nın rol menüsünün yerine):
//   /ayar rol-menusu olustur|ekle|cikar|sil|liste   düğmeli ya da seçme menülü rol panelleri (roller.js)
//   /ayar takim-ara oyun-rolu|liste                  takım arama ilanında hangi oyunun hangi rolü etiketleyeceği
//   /oyun ara oyun:... kisi:... not:...              "3/4 aranıyor" ilanı (ara.js)
// Kontrol merkezinde "Oyun" altında "Takım ara", "Ayarlar" altında rol panelleri ve "Yeni rol paneli" formu.
// Panel düğmeleri kalıcıdır (oz:roller-ve-ara:rol:<panel>:<rol>): bot yeniden başlasa da çalışır.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  SlashCommandSubcommandGroupBuilder,
  TextDisplayBuilder,
  TextInputStyle,
} from 'discord.js';
import { escapeMarkdown, truncate } from '../../util/format.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, defineModule, ozDescribe, ozId, ozSubcommand } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { CHANNEL_TYPES } from '../ayarlar/sema.js';
import { BILINEN_OYUNLAR, gameKey, ilanBilesenleri, ilanAc, ilanKapat, ILAN_KAPAT, jobIdOf, readGame } from './ara.js';
import { createRolesStore, KISI_EN_AZ, KISI_EN_FAZLA, PANEL_ROL_EN_FAZLA } from './depo.js';
import * as mesajlar from './mesajlar.js';
import {
  addRole,
  applyRoles,
  createPanel,
  deletePanel,
  findPanel,
  MODUL,
  panelKey,
  panelMessageExists,
  panelOf,
  readEmoji,
  removeRole,
  legacyRoles,
  setterOfPanel,
  wantedAfterClick,
} from './roller.js';
import { whyNotAssignable } from '../_roller.js';

const { komutlar: K, cevaplar: C, form: F, bolum: B } = mesajlar;
const R = K.rolMenusu;
const A = K.takimAra;
/** Roles given right away in "/ayar rol-menusu olustur"; more come with "ekle". */
const OLUSTUR_ROL = 5;
const OYUN_ROLU_EN_FAZLA = 50;

const fail = (text) => {
  throw new OzellikHatasi(text);
};

/** The store of a running bot (data/roller-ve-ara.json). */
export function storeOf(context) {
  return context.ozellikler.depo(MODUL, (file) =>
    createRolesStore({ file, logger: context.logger?.child?.('roller') }),
  );
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
/** For editReply: the reply is already ephemeral. */
const quiet = (content) => ({ content, allowedMentions: { parse: [] } });

function requireManager(interaction) {
  if (!interaction.guildId || !interaction.guild) fail(ortak.sunucudaKullan);
  if (!canManageGuild(interaction)) fail(C.yoneticiGerekli);
}

/** Up to 25 autocomplete choices whose name contains what was typed. */
function choices(list, focused) {
  const typed = gameKey(focused);
  return list
    .filter((c) => !typed || gameKey(c.name).includes(typed))
    .slice(0, 25)
    .map((c) => ({ name: truncate(c.name, 100), value: String(c.value).slice(0, 100) }));
}

function rolMenusuGroup() {
  const group = new SlashCommandSubcommandGroupBuilder().setName('rol-menusu').setDescription(R.grup);
  group.addSubcommand((s) => {
    s.setName('olustur')
      .setDescription(R.olustur)
      .addChannelOption((o) =>
        ozDescribe(o, 'kanal', R.secenekler.kanal)
          .setRequired(true)
          .addChannelTypes(...CHANNEL_TYPES.metin),
      )
      .addStringOption((o) => ozDescribe(o, 'baslik', R.secenekler.baslik).setRequired(true).setMaxLength(100))
      .addRoleOption((o) => ozDescribe(o, 'rol1', R.secenekler.rol(1)).setRequired(true))
      .addStringOption((o) =>
        ozDescribe(o, 'stil', R.secenekler.stil).addChoices(
          { name: R.stiller.dugme, value: 'dugme' },
          { name: R.stiller.menu, value: 'menu' },
        ),
      )
      .addBooleanOption((o) => ozDescribe(o, 'coklu', R.secenekler.coklu));
    for (let n = 2; n <= OLUSTUR_ROL; n += 1) s.addRoleOption((o) => ozDescribe(o, `rol${n}`, R.secenekler.rol(n)));
    return s;
  });
  const panelOption = (o) => ozDescribe(o, 'panel', R.secenekler.panel).setRequired(true).setAutocomplete(true);
  group.addSubcommand((s) =>
    s
      .setName('ekle')
      .setDescription(R.ekle)
      .addStringOption(panelOption)
      .addRoleOption((o) => ozDescribe(o, 'rol', R.secenekler.rol(0)).setRequired(true))
      .addStringOption((o) => ozDescribe(o, 'emoji', R.secenekler.emoji).setMaxLength(64)),
  );
  group.addSubcommand((s) =>
    s
      .setName('cikar')
      .setDescription(R.cikar)
      .addStringOption(panelOption)
      .addRoleOption((o) => ozDescribe(o, 'rol', R.secenekler.rol(0)).setRequired(true)),
  );
  group.addSubcommand((s) => s.setName('sil').setDescription(R.sil).addStringOption(panelOption));
  group.addSubcommand((s) => s.setName('liste').setDescription(R.liste));
  return group;
}

function takimAraGroup() {
  return new SlashCommandSubcommandGroupBuilder()
    .setName('takim-ara')
    .setDescription(A.grup)
    .addSubcommand((s) =>
      s
        .setName('oyun-rolu')
        .setDescription(A.oyunRolu)
        .addStringOption((o) =>
          ozDescribe(o, 'oyun', A.secenekler.oyun).setRequired(true).setMaxLength(50).setAutocomplete(true),
        )
        .addRoleOption((o) => ozDescribe(o, 'rol', A.secenekler.rol)),
    )
    .addSubcommand((s) => s.setName('liste').setDescription(A.liste));
}

const panelLines = (store, guildId) =>
  store.panelsOf(guildId).map((p) => C.panelSatiri(escapeMarkdown(p.baslik), p.kanalId, p.roller.length));

async function rolMenusu(interaction, context) {
  requireManager(interaction);
  const store = storeOf(context);
  const { options, guildId } = interaction;
  const sub = options.getSubcommand();
  if (sub === 'liste') {
    await interaction.reply(ephemeral(C.panelListesi(panelLines(store, guildId)).slice(0, 2000)));
    return;
  }
  if (sub === 'olustur') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roller = [];
    for (let n = 1; n <= OLUSTUR_ROL; n += 1) roller.push(options.getRole(`rol${n}`));
    const panel = await createPanel(interaction, context, store, {
      kanal: options.getChannel('kanal'),
      baslik: options.getString('baslik'),
      roller,
      stil: options.getString('stil') ?? 'dugme',
      coklu: options.getBoolean('coklu') ?? true,
    });
    await interaction.editReply(quiet(C.kuruldu(panel.kanalId, panel.roller.length)));
    return;
  }
  const panel = findPanel(store, guildId, options.getString('panel'));
  if (sub === 'sil') {
    await deletePanel(context, store, panel);
    await interaction.reply(ephemeral(C.silindi));
    return;
  }
  // The record exists but its message was deleted: it can only be removed ("sil") and set up again.
  if (!(await panelMessageExists(context, panel))) fail(C.panelYok);
  const role = options.getRole('rol');
  if (sub === 'ekle') {
    const emoji = readEmoji(options.getString('emoji'));
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await addRole(interaction, context, store, panel, role, emoji);
    await interaction.editReply(quiet(C.eklendiPanele(role.id)));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await removeRole(interaction, context, store, panel, role.id);
  await interaction.editReply(quiet(C.cikarildiPanelden(role.id)));
}

async function takimAra(interaction, context) {
  requireManager(interaction);
  const store = storeOf(context);
  const { options, guildId } = interaction;
  if (options.getSubcommand() === 'liste') {
    const lines = Object.values(store.gameRoles(guildId)).map((g) => C.oyunRoluSatiri(escapeMarkdown(g.ad), g.rolId));
    await interaction.reply(ephemeral(C.oyunRolleriListesi(lines).slice(0, 2000)));
    return;
  }
  const ad = readGame(options.getString('oyun'));
  const key = gameKey(ad);
  const role = options.getRole('rol');
  if (!role) {
    store.setGameRole(guildId, key, null);
    await interaction.reply(ephemeral(C.oyunRoluKaldirildi(escapeMarkdown(ad))));
    return;
  }
  const games = store.gameRoles(guildId);
  if (!games[key] && Object.keys(games).length >= OYUN_ROLU_EN_FAZLA) fail(C.oyunRoluSiniri(OYUN_ROLU_EN_FAZLA));
  // Only pinged, never given: @everyone and bot roles are still refused.
  if (role.id === guildId) fail(C.rolHerkes);
  if (role.managed) fail(C.rolYonetilen(role.id));
  store.setGameRole(guildId, key, { ad, rolId: role.id });
  const lines = [C.oyunRoluKaydedildi(escapeMarkdown(ad), role.id)];
  if (role.mentionable === false) lines.push(C.oyunRoluEtiketlenemez(role.id));
  await interaction.reply(ephemeral(lines.join('\n')));
}

function gameChoices(context, guildId, focused) {
  const own = Object.values(storeOf(context).gameRoles(guildId)).map((g) => ({ name: g.ad, value: g.ad }));
  const known = BILINEN_OYUNLAR.filter((name) => !own.some((g) => gameKey(g.name) === gameKey(name))).map((name) => ({
    name,
    value: name,
  }));
  return choices([...own, ...known], focused);
}

function panelForm() {
  return new ModalBuilder()
    .setCustomId(ozId(MODUL, 'panel-gonder'))
    .setTitle(F.panelBaslik)
    .addLabelComponents(
      (l) =>
        l
          .setLabel(F.panelAdi)
          .setTextInputComponent((i) =>
            i.setCustomId('baslik').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
          ),
      (l) =>
        l
          .setLabel(F.panelKanal)
          .setChannelSelectMenuComponent((s) =>
            s
              .setCustomId('kanal')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
              .setMinValues(1)
              .setMaxValues(1),
          ),
      (l) =>
        l
          .setLabel(F.panelRoller)
          .setRoleSelectMenuComponent((s) => s.setCustomId('roller').setMinValues(1).setMaxValues(PANEL_ROL_EN_FAZLA)),
      (l) =>
        l.setLabel(F.panelStil).setStringSelectMenuComponent((s) =>
          s
            .setCustomId('stil')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(Object.entries(F.stiller).map(([value, label]) => ({ label, value }))),
        ),
    );
}

export default defineModule({
  ad: MODUL,
  mesajlar,
  // Roles of the panels are given and taken.
  izinler: ['ManageRoles'],
  ayarlar: {
    'ara-sure': { tur: 'sayi', enAz: 1, enFazla: 12, varsayilan: 2 },
    'ara-etiket': { tur: 'bayrak', varsayilan: true },
  },
  komutlar: [
    {
      ust: 'oyun',
      kategori: 'oyun',
      data: ozSubcommand('ara', K.ara)
        .addStringOption((o) =>
          ozDescribe(o, 'oyun', K.secenekler.oyun).setRequired(true).setMaxLength(50).setAutocomplete(true),
        )
        .addIntegerOption((o) =>
          ozDescribe(o, 'kisi', K.secenekler.kisi).setRequired(true).setMinValue(KISI_EN_AZ).setMaxValue(KISI_EN_FAZLA),
        )
        .addStringOption((o) => ozDescribe(o, 'not', K.secenekler.not).setMaxLength(200)),
      async execute(interaction, context) {
        await ilanAc(interaction, context, storeOf(context), {
          oyun: interaction.options.getString('oyun'),
          kisi: interaction.options.getInteger('kisi'),
          not: interaction.options.getString('not'),
        });
      },
      async autocomplete(interaction, context) {
        await interaction.respond(gameChoices(context, interaction.guildId, interaction.options.getFocused()));
      },
    },
  ],
  ayarKomutlari: [
    {
      data: rolMenusuGroup(),
      execute: rolMenusu,
      async autocomplete(interaction, context) {
        const typed = panelKey(interaction.options.getFocused());
        const channels = interaction.guild?.channels?.cache;
        const list = storeOf(context)
          .panelsOf(interaction.guildId)
          .filter((p) => !typed || panelKey(p.baslik).includes(typed))
          .slice(0, 25)
          .map((p) => {
            const channel = channels?.get(p.kanalId)?.name;
            return {
              name: truncate(`${p.baslik} — ${channel ? `#${channel}` : 'kanal yok'}`, 100),
              value: p.id,
            };
          });
        await interaction.respond(list);
      },
    },
    {
      data: takimAraGroup(),
      execute: takimAra,
      async autocomplete(interaction, context) {
        await interaction.respond(gameChoices(context, interaction.guildId, interaction.options.getFocused()));
      },
    },
  ],
  ayarListeleri: {
    'rol-panelleri': {
      tur: 'ozel',
      aciklama: mesajlar.listeler.rolPanelleri,
      yalnizDiscord: '/ayar rol-menusu',
      oku: (context, guildId) => panelLines(storeOf(context), guildId),
    },
    'oyun-rolleri': {
      tur: 'ozel',
      aciklama: mesajlar.listeler.oyunRolleri,
      yalnizDiscord: '/ayar takim-ara oyun-rolu',
      oku: (context, guildId) =>
        Object.values(storeOf(context).gameRoles(guildId)).map((g) => C.oyunRoluSatiri(escapeMarkdown(g.ad), g.rolId)),
    },
  },
  /** Lines for /ayar goster: panels set up before setters were stored, and roles a panel no longer gives. */
  async ayarUyarilari(guild, context) {
    const lines = [];
    for (const panel of storeOf(context).panelsOf(guild.id)) {
      const title = escapeMarkdown(panel.baslik);
      if (legacyRoles(panel).length) lines.push(C.yenidenKur(title, panel.kanalId));
      const setterOf = setterOfPanel(panel);
      for (const { id } of panel.roller) {
        const neden = await whyNotAssignable(guild, id, { setterId: setterOf(id) });
        if (neden) lines.push(C.verilmiyor(title, id, neden));
      }
    }
    return lines;
  },
  isler: {
    'ilan-kapat': async (veri, context) => {
      await ilanKapat(context, storeOf(context), String(veri.id ?? ''));
    },
  },
  olaylar(context) {
    // An open posting whose close job was lost (e.g. data/zamanlayici.json was deleted) still closes.
    const { zamanlayici } = context.ozellikler;
    if (zamanlayici.saltOkunur) return undefined;
    const planned = new Set(zamanlayici.bekleyenler().map((job) => job.id));
    for (const entry of storeOf(context).ilanlar()) {
      if (planned.has(jobIdOf(entry.id))) continue;
      try {
        zamanlayici.planla({ id: jobIdOf(entry.id), zaman: entry.bitis, tur: ILAN_KAPAT, veri: { id: entry.id } });
      } catch (error) {
        context.logger?.warn?.(`Takım arama ilanı kapanışı planlanamadı (${entry.id}): ${error?.message ?? error}`);
      }
    }
    return undefined;
  },
  menu: [
    {
      sira: 25,
      kategori: 'oyun',
      gorunurluk: 'herkes',
      gorunur: ({ yer }) => yer !== 'panel',
      ciz: () => [
        new TextDisplayBuilder().setContent(B.ara),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'ara-ac'))
            .setEmoji('🎮')
            .setLabel(B.araDugme)
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    },
    {
      sira: 92,
      kategori: 'ayarlar',
      gorunurluk: 'yonetici',
      gorunur: ({ yer }) => yer !== 'panel',
      ciz: ({ context, guildId }) => [
        new TextDisplayBuilder().setContent(
          B.roller(panelLines(storeOf(context), guildId).slice(0, 10)).slice(0, 1500),
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'panel-ac'))
            .setEmoji('🎭')
            .setLabel(B.yeniPanel)
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    },
  ],
  bilesenler: {
    /** A role button of a panel: toggles that role. */
    async rol(interaction, context, [panelId, roleId]) {
      if (!interaction.guildId || !interaction.member) fail(ortak.sunucudaKullan);
      const panel = panelOf(storeOf(context), interaction.guildId, panelId);
      if (!panel.roller.some((r) => r.id === roleId)) fail(C.panelYok);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await applyRoles(interaction, panel, wantedAfterClick(panel, interaction.member, roleId), context);
      await interaction.editReply(quiet(C.rolDegisti(result.eklenen, result.kaldirilan, result.atlanan, result.eski)));
    },

    /** The select menu of a panel: the member's panel roles become exactly what was picked. */
    async sec(interaction, context, [panelId]) {
      if (!interaction.guildId || !interaction.member) fail(ortak.sunucudaKullan);
      const panel = panelOf(storeOf(context), interaction.guildId, panelId);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await applyRoles(interaction, panel, interaction.values ?? [], context);
      await interaction.editReply(quiet(C.rolDegisti(result.eklenen, result.kaldirilan, result.atlanan, result.eski)));
    },

    async 'panel-ac'(interaction) {
      requireManager(interaction);
      await interaction.showModal(panelForm());
    },

    async 'panel-gonder'(interaction, context) {
      requireManager(interaction);
      const { fields, guild } = interaction;
      const picked = fields.getSelectedChannels('kanal', true)?.first?.();
      const kanal = guild.channels?.cache?.get(picked?.id) ?? picked;
      const roller = [...(fields.getSelectedRoles('roller', true)?.values?.() ?? [])];
      const [stil = 'dugme', secim = 'cok'] = String(fields.getStringSelectValues('stil')?.[0] ?? '').split('-');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const panel = await createPanel(interaction, context, storeOf(context), {
        kanal,
        baslik: fields.getTextInputValue('baslik'),
        roller,
        stil: stil === 'menu' ? 'menu' : 'dugme',
        coklu: secim !== 'tek',
      });
      await interaction.editReply(quiet(C.kuruldu(panel.kanalId, panel.roller.length)));
    },

    ...ilanBilesenleri(storeOf),
  },
});
