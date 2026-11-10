// /nowplaying: çalan şarkıyı ilerleme çubuğu, ses, tekrar ve bas bilgisiyle gösterir.
import { etiketler, komutlar, muzik } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';
import { baseEmbed, requesterMention, trackLink } from '../util/embeds.js';
import { escapeMarkdown, formatDuration, progressBar } from '../util/format.js';
import { guildCommand } from './_helpers.js';

const M = komutlar.nowplaying;

export const data = guildCommand('nowplaying');

export async function execute(interaction, { music }) {
  const state = music.getState(interaction.guildId);
  if (!state?.current) throw new MusicError(ErrorCodes.NOTHING_PLAYING, muzik.calanYok);

  const track = state.current;
  const timeLine = track.isStream
    ? M.canliYayin
    : `${progressBar(state.position, track.duration)}\n\`${formatDuration(state.position)} / ${formatDuration(track.duration)}\``;

  const embed = baseEmbed()
    .setTitle(state.paused ? M.duraklatildi : M.caliyor)
    .setDescription(`${trackLink(track, 200)}\n${escapeMarkdown(track.author)}\n\n${timeLine}`)
    .addFields(
      { name: etiketler.isteyen, value: requesterMention(track), inline: true },
      { name: M.ses, value: String(state.volume), inline: true },
      { name: M.tekrar, value: etiketler.tekrar[state.repeatMode] ?? state.repeatMode, inline: true },
      { name: M.bas, value: etiketler.bas[state.bassboost] ?? etiketler.bas.none, inline: true },
      { name: M.kuyrukta, value: M.sarkiSayisi(state.queue.length), inline: true },
    );
  if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);
  await interaction.reply({ embeds: [embed] });
}
