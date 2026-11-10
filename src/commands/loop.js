// /loop: çalan şarkının tekrarını açar ya da kapatır.
import { komutlar } from '../mesajlar.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('loop');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const mode = await music.toggleTrackLoop(interaction.guildId);
  await replySuccess(interaction, mode === 'track' ? komutlar.loop.acildi : komutlar.loop.kapandi);
}
