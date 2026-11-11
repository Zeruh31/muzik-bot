// /volume seviye: ses seviyesini değiştirir; seviye boşsa şu anki seviyeyi söyler.
import { komutlar, muzik } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';
import { VOLUME_MAX, VOLUME_MIN } from '../music/MusicService.js';
import { describe, guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

const M = komutlar.volume;

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('volume').addIntegerOption((option) =>
  describe(option, 'volume', 'seviye').setMinValue(VOLUME_MIN).setMaxValue(VOLUME_MAX),
);

export async function execute(interaction, { music }) {
  const level = interaction.options.getInteger('seviye');
  if (level === null) {
    const state = music.getState(interaction.guildId);
    if (!state) throw new MusicError(ErrorCodes.NO_PLAYER, muzik.calmiyor);
    await replySuccess(interaction, M.simdiki(state.volume));
    return;
  }
  requireSameVoice(interaction, music);
  await music.setVolume(interaction.guildId, level);
  await replySuccess(interaction, level > 100 ? M.yuksekUyarisi(level) : M.ayarlandi(level));
}
