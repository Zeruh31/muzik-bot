// /muzik sesli-komut beni-dinleme | beni-dinle | durum: kişinin kendi sesini sesli komuttan çıkarması (paketleri
// işlenmeden atılır) ve geri alması. Özellik src/ozellikler/sesli-komut içinde; yazıları oradaki mesajlar.js'te.
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { exclusionsOf, setExcluded, statusText } from '../ozellikler/sesli-komut/index.js';
import { cevaplar as C, komut as K } from '../ozellikler/sesli-komut/mesajlar.js';

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = new SlashCommandBuilder()
  .setName('sesli-komut')
  .setDescription(K.aciklama)
  .addSubcommand((s) => s.setName('beni-dinleme').setDescription(K.benidinleme))
  .addSubcommand((s) => s.setName('beni-dinle').setDescription(K.benidinle))
  .addSubcommand((s) => s.setName('durum').setDescription(K.durum));

export async function execute(interaction, context) {
  const sub = interaction.options.getSubcommand();
  const { guildId } = interaction;
  const userId = interaction.user.id;
  let content;
  if (sub === 'durum') {
    content = statusText(context, guildId, userId);
  } else {
    const excluded = sub === 'beni-dinleme';
    if (exclusionsOf(context).has(guildId, userId) === excluded) content = excluded ? C.zatenHaric : C.zatenDinleniyor;
    else {
      setExcluded(context, guildId, userId, excluded);
      content = excluded ? C.haricTutuldu : C.dinleniyor;
    }
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}
