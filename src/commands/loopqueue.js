// /loopqueue: bütün kuyruğun tekrarını açar ya da kapatır.
import { komutlar } from '../mesajlar.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('loopqueue');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const mode = await music.toggleQueueLoop(interaction.guildId);
  await replySuccess(interaction, mode === 'queue' ? komutlar.loopqueue.acildi : komutlar.loopqueue.kapandi);
}
