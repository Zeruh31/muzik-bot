// /remove sıra: kuyruktan bir şarkıyı çıkarır.
import { komutlar } from '../mesajlar.js';
import { trackLink } from '../util/embeds.js';
import { describe, guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('remove').addIntegerOption((option) =>
  describe(option, 'remove', 'sıra').setRequired(true).setMinValue(1),
);

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const removed = await music.remove(interaction.guildId, interaction.options.getInteger('sıra', true));
  await replySuccess(interaction, komutlar.remove.tamam(trackLink(removed)));
}
