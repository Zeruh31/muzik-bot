// /previous: önceki şarkıyı yeniden çalar; çalan şarkı kuyruğun başına döner (tekrar modları korunur).
import { komutlar } from '../mesajlar.js';
import { trackLink } from '../util/embeds.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('previous');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  await interaction.deferReply();
  const track = await music.previous(interaction.guildId);
  await replySuccess(interaction, komutlar.previous.tamam(trackLink(track)));
}
