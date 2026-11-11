// "Şans" modülü: /oyun zar, /oyun sec, /oyun yazitura ve kontrol merkezindeki "Oyun" bölümünde iki düğme.
// Sonuçlar kanala herkese açık yazılır; hiçbir şey saklanmaz.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, TextDisplayBuilder } from 'discord.js';
import { replySuccess } from '../../commands/_helpers.js';
import { escapeMarkdown, truncate } from '../../util/format.js';
import { defineModule, listeyiAyir, ozDescribe, ozId, ozSubcommand } from '../_ortak.js';
import { cryptoRandom } from '../_rastgele.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import * as mesajlar from './mesajlar.js';

const { komutlar: K, cevaplar: C, bolum: B } = mesajlar;

export const ZAR = Object.freeze({ yuzEnAz: 2, yuzEnFazla: 1000, adetEnFazla: 100, varsayilanYuz: 6 });
export const SECIM = Object.freeze({ enAz: 2, enFazla: 50, metinEnFazla: 1000 });

/** Rolls `adet` dice with `yuz` faces. @returns {{ sonuclar: number[], toplam: number }} */
export function zarAt(yuz = ZAR.varsayilanYuz, adet = 1, random = cryptoRandom) {
  if (!Number.isInteger(yuz) || yuz < ZAR.yuzEnAz || yuz > ZAR.yuzEnFazla) throw new RangeError('yuz');
  if (!Number.isInteger(adet) || adet < 1 || adet > ZAR.adetEnFazla) throw new RangeError('adet');
  const sonuclar = Array.from({ length: adet }, () => random(yuz) + 1);
  return { sonuclar, toplam: sonuclar.reduce((a, b) => a + b, 0) };
}

/** The options of "a, b, c" (or "a | b | c" / one per line): see listeyiAyir. Throws OzellikHatasi when too few or too many. */
export function secenekleriAyir(text) {
  const list = listeyiAyir(text);
  if (list.length < SECIM.enAz || list.length > SECIM.enFazla)
    throw new OzellikHatasi(C.azSecenek(SECIM.enAz, SECIM.enFazla));
  return list;
}

export const sec = (list, random = cryptoRandom) => list[random(list.length)];
export const yaziTura = (random = cryptoRandom) => (random(2) === 0 ? 'yazi' : 'tura');

const who = (interaction) => `<@${interaction.user.id}>`;

async function zar(interaction) {
  const yuz = interaction.options?.getInteger?.('yuz') ?? ZAR.varsayilanYuz;
  const adet = interaction.options?.getInteger?.('adet') ?? 1;
  const { sonuclar, toplam } = zarAt(yuz, adet);
  await replySuccess(interaction, C.zar(who(interaction), adet, yuz, sonuclar, toplam));
}

async function yazitura(interaction) {
  await replySuccess(interaction, C[yaziTura()](who(interaction)));
}

export default defineModule({
  ad: 'sans',
  mesajlar,
  komutlar: [
    {
      ust: 'oyun',
      kategori: 'oyun',
      data: ozSubcommand('zar', K.zar)
        .addIntegerOption((o) =>
          ozDescribe(o, 'yuz', K.secenekler.yuz).setMinValue(ZAR.yuzEnAz).setMaxValue(ZAR.yuzEnFazla),
        )
        .addIntegerOption((o) => ozDescribe(o, 'adet', K.secenekler.adet).setMinValue(1).setMaxValue(ZAR.adetEnFazla)),
      execute: zar,
    },
    {
      ust: 'oyun',
      kategori: 'oyun',
      data: ozSubcommand('sec', K.sec).addStringOption((o) =>
        ozDescribe(o, 'secenekler', K.secenekler.secenekler).setRequired(true).setMaxLength(SECIM.metinEnFazla),
      ),
      async execute(interaction) {
        const list = secenekleriAyir(interaction.options.getString('secenekler'));
        const secilen = escapeMarkdown(truncate(sec(list), 200));
        await replySuccess(interaction, C.sec(who(interaction), secilen, list.length));
      },
    },
    { ust: 'oyun', kategori: 'oyun', data: ozSubcommand('yazitura', K.yazitura), execute: yazitura },
  ],
  menu: {
    sira: 30,
    kategori: 'oyun',
    gorunurluk: 'herkes',
    // The fixed panel is for music; its 40-component budget is kept for that.
    gorunur: ({ yer }) => yer !== 'panel',
    ciz: () => [
      new TextDisplayBuilder().setContent(B.metin),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(ozId('sans', 'zar'))
          .setEmoji('🎲')
          .setLabel(B.zar)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(ozId('sans', 'yazitura'))
          .setEmoji('🪙')
          .setLabel(B.yazitura)
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  },
  bilesenler: {
    zar: (interaction) => zar(interaction),
    yazitura: (interaction) => yazitura(interaction),
  },
});
