// /stop: müziği durdurur, kuyruğu temizler ve ses kanalından ayrılır.
import { komutlar } from '../mesajlar.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('stop');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  await music.stop(interaction.guildId);
  await replySuccess(interaction, komutlar.stop.tamam);
}
