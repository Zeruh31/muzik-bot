// /bassboost seviye: bas güçlendirmeyi Kapalı / Düşük / Orta / Yüksek yapar.
import { komutlar } from '../mesajlar.js';
import { BASSBOOST_LEVELS } from '../music/MusicService.js';
import { describe, guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

const M = komutlar.bassboost;

export const data = guildCommand('bassboost').addStringOption((option) =>
  describe(option, 'bassboost', 'seviye')
    .setRequired(true)
    .addChoices(...Object.entries(BASSBOOST_LEVELS).map(([value, { label }]) => ({ name: label, value }))),
);

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const level = interaction.options.getString('seviye', true);
  await music.setBassboost(interaction.guildId, level);
  await replySuccess(interaction, level === 'none' ? M.kapatildi : M.ayarlandi(BASSBOOST_LEVELS[level].label));
}
