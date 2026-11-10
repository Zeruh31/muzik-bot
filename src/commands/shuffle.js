// /shuffle: kuyruktaki şarkıları karıştırır.
import { komutlar } from '../mesajlar.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('shuffle');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const count = await music.shuffle(interaction.guildId);
  await replySuccess(interaction, komutlar.shuffle.tamam(count));
}
