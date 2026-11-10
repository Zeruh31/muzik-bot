// /resume: duraklatılan müziği devam ettirir.
import { komutlar } from '../mesajlar.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('resume');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  await music.resume(interaction.guildId);
  await replySuccess(interaction, komutlar.resume.tamam);
}
