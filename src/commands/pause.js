// /pause: müziği duraklatır.
import { komutlar } from '../mesajlar.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('pause');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  await music.pause(interaction.guildId);
  await replySuccess(interaction, komutlar.pause.tamam);
}
