// /skip: çalan şarkıyı atlar.
import { komutlar } from '../mesajlar.js';
import { trackLink } from '../util/embeds.js';
import { guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('skip');

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const skipped = await music.skip(interaction.guildId);
  await replySuccess(interaction, komutlar.skip.tamam(trackLink(skipped)));
}
