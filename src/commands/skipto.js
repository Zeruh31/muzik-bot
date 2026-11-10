// /skipto sıra: kuyrukta o sıradaki şarkıya atlar (öncekiler kuyruktan çıkar).
import { komutlar } from '../mesajlar.js';
import { trackLink } from '../util/embeds.js';
import { describe, guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('skipto').addIntegerOption((option) =>
  describe(option, 'skipto', 'sıra').setRequired(true).setMinValue(1),
);

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const position = interaction.options.getInteger('sıra', true);
  const target = await music.skipTo(interaction.guildId, position);
  await replySuccess(interaction, komutlar.skipto.tamam(position, trackLink(target)));
}
