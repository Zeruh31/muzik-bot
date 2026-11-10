// /play şarkı: şarkı adı yazılırsa ilk sonuçları listeler ve seçileni çalar (tek sonuç varsa
// doğrudan çalar); bağlantı ya da çalma listesi verilirse doğrudan çalar.
// Listeyi kapatıp her zaman ilk sonucu çalmak için .env'de PLAY_SHOW_CHOICES=false yap.
import { secim } from '../gorunum.js';
import { addedEmbed, describe, guildCommand, requireJoinableVoice } from './_helpers.js';
import { pickAndPlay } from './_secim.js';

export const data = guildCommand('play').addStringOption((option) =>
  describe(option, 'play', 'şarkı').setRequired(true).setMaxLength(500),
);

export async function execute(interaction, context) {
  const { music, config } = context;
  const channel = requireJoinableVoice(interaction, music);
  await interaction.deferReply();

  const query = interaction.options.getString('şarkı', true);
  const resolved = await music.resolve(query, interaction.user);
  if (resolved.kind === 'search' && config.music.playShowChoices && resolved.tracks.length > 1) {
    await pickAndPlay(interaction, context, {
      tracks: resolved.tracks,
      query,
      voiceChannelId: channel.id,
      count: secim.playSonucSayisi,
    });
    return;
  }

  const result = await music.playResolved({
    guildId: interaction.guildId,
    voiceChannelId: channel.id,
    textChannelId: interaction.channelId,
    resolved,
  });
  await interaction.editReply({ embeds: [addedEmbed(result)] });
}
