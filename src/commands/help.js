// /help: bütün komutları açıklamalarıyla listeler; en altta (doluysa) destek sunucusu ve yapımcı bağlantıları.
// Bağlantılar .env dosyasındaki BRAND_SUPPORT_URL, BRAND_AUTHOR_NAME ve BRAND_AUTHOR_URL ayarlarıdır.
import { MessageFlags } from 'discord.js';
import { komutlar } from '../mesajlar.js';
import { baseEmbed } from '../util/embeds.js';
import { escapeMarkdown } from '../util/format.js';
import { anywhereCommand } from './_helpers.js';

const M = komutlar.help;

export const data = anywhereCommand('help');

/**
 * "[Discord](...) • By [Name](...)" from config.brand; empty parts are left out,
 * so with nothing set in .env the /help embed has no links field at all.
 */
export function brandLine(brand = {}) {
  const parts = [];
  if (brand.supportUrl) parts.push(M.discordBaglantisi(brand.supportUrl));
  const name = brand.authorName ? escapeMarkdown(brand.authorName.replace(/[[\]()]/g, '')) : '';
  if (name && brand.authorUrl) parts.push(M.yazar(name, brand.authorUrl));
  else if (name) parts.push(M.yazarBaglantisiz(name));
  return parts.join(' • ');
}

export async function execute(interaction, { commands, config, panel }) {
  const lines = [...commands.values()]
    .map((command) => command.data)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => `\`/${d.name}\` — ${d.description}`);

  const notes = [
    config.music.twentyFourSeven ? M.yirmiDortYedi : M.bosKanal(config.music.leaveWhenEmptySeconds),
    M.kaynaklar,
  ];
  if (panel?.url) notes.push(M.panel(panel.url));

  const embed = baseEmbed()
    .setTitle(M.baslik)
    .setDescription(lines.join('\n'))
    .addFields({ name: M.bilgiBasligi, value: notes.join('\n') });
  const brand = brandLine(config.brand);
  if (brand) embed.addFields({ name: M.baglantilarBasligi, value: brand });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
