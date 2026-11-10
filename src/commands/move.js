// /move parça konum: kuyruktaki bir şarkıyı başka bir sıraya taşır.
import { komutlar } from '../mesajlar.js';
import { trackLink } from '../util/embeds.js';
import { describe, guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('move')
  .addIntegerOption((option) => describe(option, 'move', 'parça').setRequired(true).setMinValue(1))
  .addIntegerOption((option) => describe(option, 'move', 'konum').setRequired(true).setMinValue(1));

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const from = interaction.options.getInteger('parça', true);
  const to = interaction.options.getInteger('konum', true);
  const moved = await music.move(interaction.guildId, from, to);
  await replySuccess(interaction, komutlar.move.tamam(trackLink(moved), to));
}
