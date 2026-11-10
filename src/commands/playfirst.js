// /playfirst sıra: kuyruktaki bir şarkıyı başa alır; çalan şarkı bitince o çalar.
import { komutlar } from '../mesajlar.js';
import { trackLink } from '../util/embeds.js';
import { describe, guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

const M = komutlar.playfirst;

export const data = guildCommand('playfirst').addIntegerOption((option) =>
  describe(option, 'playfirst', 'sıra').setRequired(true).setMinValue(1),
);

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const { track, moved } = await music.playNext(interaction.guildId, interaction.options.getInteger('sıra', true));
  await replySuccess(interaction, moved ? M.tamam(trackLink(track)) : M.zatenBasta(trackLink(track)));
}
