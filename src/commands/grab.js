// /grab: çalan şarkının bilgisini komutu yazana özel mesaj (DM) olarak gönderir.
import { RESTJSONErrorCodes } from 'discord.js';
import { etiketler, komutlar, muzik } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';
import { baseEmbed, trackDuration, trackLink } from '../util/embeds.js';
import { escapeMarkdown } from '../util/format.js';
import { guildCommand, replySuccess } from './_helpers.js';

const M = komutlar.grab;

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('grab');

export async function execute(interaction, { music }) {
  const track = music.getState(interaction.guildId)?.current;
  if (!track) throw new MusicError(ErrorCodes.NOTHING_PLAYING, muzik.calanYok);

  const embed = baseEmbed()
    .setTitle(M.baslik)
    .setDescription(`${trackLink(track, 200)}\n${escapeMarkdown(track.author)}`)
    .addFields(
      { name: etiketler.sure, value: trackDuration(track), inline: true },
      { name: etiketler.sunucu, value: escapeMarkdown(interaction.guild.name), inline: true },
    );
  if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);

  try {
    await interaction.user.send({ embeds: [embed] });
  } catch (error) {
    if (error?.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
      throw new MusicError(ErrorCodes.INVALID_VALUE, M.dmKapali);
    }
    throw error;
  }
  await replySuccess(interaction, M.tamam, { ephemeral: true });
}
