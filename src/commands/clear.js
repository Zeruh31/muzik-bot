// /clear: kuyruktaki bütün şarkıları siler (çalan şarkı devam eder).
import { komutlar } from '../mesajlar.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('clear');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const count = await music.clear(interaction.guildId);
  await replySuccess(interaction, komutlar.clear.tamam(count));
}
