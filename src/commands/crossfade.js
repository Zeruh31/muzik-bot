// /muzik crossfade saniye: şarkılar arası geçiş süresini ayarlar; saniye boşsa şu anki süreyi söyler.
import { komutlar } from '../mesajlar.js';
import { CROSSFADE_MAX_SECONDS, CROSSFADE_MIN_SECONDS } from '../music/crossfade.js';
import { describe, guildCommand, replySuccess } from './_helpers.js';

const M = komutlar.crossfade;

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('crossfade').addIntegerOption((option) =>
  describe(option, 'crossfade', 'saniye').setMinValue(CROSSFADE_MIN_SECONDS).setMaxValue(CROSSFADE_MAX_SECONDS),
);

export async function execute(interaction, { music }) {
  const seconds = interaction.options.getInteger('saniye');
  if (seconds === null) {
    await replySuccess(interaction, M.simdiki(music.getCrossfade(interaction.guildId)));
    return;
  }
  await music.setCrossfade(interaction.guildId, seconds);
  await replySuccess(interaction, seconds === 0 ? M.kapatildi : M.ayarlandi(seconds));
}
