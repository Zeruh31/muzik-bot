// /seek zaman: şarkıda belirtilen zamana atlar (1:30, 90, 2dk 10sn).
import { komutlar } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';
import { formatDuration, parseTime } from '../util/format.js';
import { describe, guildCommand, replySuccess, requireSameVoice } from './_helpers.js';

export const data = guildCommand('seek').addStringOption((option) =>
  describe(option, 'seek', 'zaman').setRequired(true).setMaxLength(20),
);

export async function execute(interaction, { music }) {
  requireSameVoice(interaction, music);
  const ms = parseTime(interaction.options.getString('zaman', true));
  if (ms === null) throw new MusicError(ErrorCodes.INVALID_VALUE, komutlar.seek.anlasilmadi);
  await music.seek(interaction.guildId, ms);
  await replySuccess(interaction, komutlar.seek.tamam(formatDuration(ms)));
}
