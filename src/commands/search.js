// /search şarkı: arama sonuçlarını listeler, seçilen şarkıyı çalar (/play ile aynı seçim listesi).
import { secim } from '../gorunum.js';
import { describe, guildCommand, requireJoinableVoice } from './_helpers.js';
import { pickAndPlay } from './_secim.js';

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('search').addStringOption((option) =>
  describe(option, 'search', 'şarkı').setRequired(true).setMaxLength(200),
);

export async function execute(interaction, context) {
  const channel = requireJoinableVoice(interaction, context.music);
  await interaction.deferReply();
  const query = interaction.options.getString('şarkı', true);
  const resolved = await context.music.resolve(query, interaction.user, { guildId: interaction.guildId });
  await pickAndPlay(interaction, context, {
    tracks: resolved.tracks,
    query,
    voiceChannelId: channel.id,
    count: secim.searchSonucSayisi,
  });
}
