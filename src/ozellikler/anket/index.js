// "Anket" modülü: /oyun anket ve kontrol merkezindeki "Anket oluştur" formu.
// Discord'un yerleşik anketi (Poll API) kullanılır: oylar Discord'da tutulur (bot hiçbir oy ya da kullanıcı
// kimliği saklamaz), kişi oyunu kaldırıp değiştirebilir, sonuç çubuklarını Discord çizer ve süre dolunca
// anket bot kapalı olsa bile kendiliğinden kapanır. Sınırlar Discord'unkidir: 2-10 seçenek, soru en fazla
// 300, seçenek en fazla 55 karakter, süre 1 saat ile 32 gün (768 saat) arası.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  TextDisplayBuilder,
  TextInputStyle,
} from 'discord.js';
import { ortak } from '../_mesajlar.js';
import { defineModule, listeyiAyir, ozDescribe, ozId, ozSubcommand } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import * as mesajlar from './mesajlar.js';

const { komutlar: K, form: F, cevaplar: C, bolum: B } = mesajlar;

export const ANKET = Object.freeze({
  secenekEnAz: 2,
  secenekEnFazla: 10,
  secenekUzunlugu: 55,
  soruUzunlugu: 300,
  sureEnAz: 1,
  sureEnFazla: 768,
  varsayilanSure: 24,
});

const fail = (text) => {
  throw new OzellikHatasi(text);
};

/**
 * Checks the poll's parts and returns discord.js PollData. Throws OzellikHatasi with a Turkish reason.
 * @param {{ soru: string, secenekler: string[], sure?: number|null, coklu?: boolean }} input
 */
export function anketVerisi({ soru, secenekler, sure = null, coklu = false }) {
  const question = String(soru ?? '').trim();
  if (!question || question.length > ANKET.soruUzunlugu) fail(C.soruUzunlugu(ANKET.soruUzunlugu));
  const answers = (secenekler ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (answers.length < ANKET.secenekEnAz || answers.length > ANKET.secenekEnFazla)
    fail(C.secenekSayisi(ANKET.secenekEnAz, ANKET.secenekEnFazla));
  if (answers.some((a) => a.length > ANKET.secenekUzunlugu)) fail(C.secenekUzun(ANKET.secenekUzunlugu));
  if (new Set(answers.map((a) => a.toLocaleLowerCase('tr'))).size !== answers.length) fail(C.secenekTekrar);
  const duration = sure ?? ANKET.varsayilanSure;
  if (!Number.isInteger(duration) || duration < ANKET.sureEnAz || duration > ANKET.sureEnFazla)
    fail(C.sureAraligi(ANKET.sureEnAz, ANKET.sureEnFazla));
  return {
    question: { text: question },
    answers: answers.map((text) => ({ text })),
    duration,
    allowMultiselect: Boolean(coklu),
  };
}

/** Splits text by a separator or regex (the form: one option per line). The command uses listeyiAyir. */
export const ayir = (text, ayrac) => String(text ?? '').split(ayrac);

async function gonder(interaction, poll) {
  if (!interaction.guildId) fail(ortak.sunucudaKullan);
  // appPermissions: the bot's permissions in this channel.
  if (interaction.appPermissions && !interaction.appPermissions.has(PermissionFlagsBits.SendPolls)) fail(C.izinYok);
  await interaction.reply({ poll, allowedMentions: { parse: [] } });
}

export function anketFormu() {
  return new ModalBuilder()
    .setCustomId(ozId('anket', 'gonder'))
    .setTitle(F.baslik)
    .addLabelComponents(
      (label) =>
        label
          .setLabel(F.soru)
          .setTextInputComponent((input) =>
            input.setCustomId('soru').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(ANKET.soruUzunlugu),
          ),
      (label) =>
        label
          .setLabel(F.secenekler)
          .setDescription(F.seceneklerIpucu)
          .setTextInputComponent((input) =>
            input.setCustomId('secenekler').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(700),
          ),
      (label) =>
        label
          .setLabel(F.sure)
          .setDescription(F.sureIpucu)
          .setTextInputComponent((input) =>
            input.setCustomId('sure').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3),
          ),
    );
}

export default defineModule({
  ad: 'anket',
  mesajlar,
  izinler: ['SendPolls'],
  komutlar: [
    {
      ust: 'oyun',
      kategori: 'oyun',
      data: ozSubcommand('anket', K.anket)
        .addStringOption((o) =>
          ozDescribe(o, 'soru', K.secenekler.soru).setRequired(true).setMaxLength(ANKET.soruUzunlugu),
        )
        .addStringOption((o) =>
          ozDescribe(o, 'secenekler', K.secenekler.secenekler).setRequired(true).setMaxLength(700),
        )
        .addIntegerOption((o) =>
          ozDescribe(o, 'sure', K.secenekler.sure).setMinValue(ANKET.sureEnAz).setMaxValue(ANKET.sureEnFazla),
        )
        .addBooleanOption((o) => ozDescribe(o, 'coklu', K.secenekler.coklu)),
      async execute(interaction) {
        const { options } = interaction;
        const poll = anketVerisi({
          soru: options.getString('soru'),
          secenekler: listeyiAyir(options.getString('secenekler')),
          sure: options.getInteger('sure'),
          coklu: options.getBoolean('coklu'),
        });
        await gonder(interaction, poll);
      },
    },
  ],
  menu: {
    sira: 40,
    kategori: 'oyun',
    gorunurluk: 'herkes',
    gorunur: ({ yer }) => yer !== 'panel',
    ciz: () => [
      new TextDisplayBuilder().setContent(B.metin),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(ozId('anket', 'ac'))
          .setEmoji('📊')
          .setLabel(B.olustur)
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  },
  bilesenler: {
    async ac(interaction) {
      if (!interaction.guildId) fail(ortak.sunucudaKullan);
      await interaction.showModal(anketFormu());
    },

    async gonder(interaction) {
      const sureText = interaction.fields.getTextInputValue('sure')?.trim();
      const sure = sureText ? Number(sureText) : null;
      const poll = anketVerisi({
        soru: interaction.fields.getTextInputValue('soru'),
        secenekler: ayir(interaction.fields.getTextInputValue('secenekler'), /\r?\n/),
        sure: sure === null || Number.isInteger(sure) ? sure : NaN,
      });
      await gonder(interaction, poll);
    },
  },
});
