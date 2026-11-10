// /lyrics şarkı: çalan şarkının (ya da yazılan şarkının) sözlerini gösterir.
import { komutlar } from '../mesajlar.js';
import { baseEmbed } from '../util/embeds.js';
import { escapeMarkdown, truncate } from '../util/format.js';
import { describe, guildCommand } from './_helpers.js';

const M = komutlar.lyrics;
const MAX_TEXT = 4000; // Discord allows 4096 characters in an embed description

export const data = guildCommand('lyrics').addStringOption((option) =>
  describe(option, 'lyrics', 'şarkı').setMaxLength(200),
);

export async function execute(interaction, { music }) {
  await interaction.deferReply();
  const query = interaction.options.getString('şarkı') ?? undefined;
  const result = await music.lyrics({ guildId: interaction.guildId, query });

  // Escape first: escaping adds characters and the embed description limit is 4096.
  const escaped = escapeMarkdown(result.text);
  const text = escaped.length > MAX_TEXT ? `${escaped.slice(0, MAX_TEXT)}\n…` : escaped;
  const source = [result.provider, result.sourceName].filter(Boolean).join(' / ');
  const embed = baseEmbed()
    .setTitle(truncate(`📝 ${result.track.title} — ${result.track.author}`, 256))
    .setDescription(text)
    .setFooter({ text: source ? M.kaynak(source) : M.kaynaksiz });
  if (result.track.uri) embed.setURL(result.track.uri);
  if (result.track.artworkUrl) embed.setThumbnail(result.track.artworkUrl);
  await interaction.editReply({ embeds: [embed] });
}
