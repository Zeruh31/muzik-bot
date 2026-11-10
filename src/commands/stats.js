// /stats: gecikme, çalışma süresi, bellek, sunucu sayısı ve Lavalink durumunu gösterir.
import { version as discordJsVersion } from 'discord.js';
import { komutlar } from '../mesajlar.js';
import { baseEmbed } from '../util/embeds.js';
import { formatBytes, formatUptime } from '../util/format.js';
import { anywhereCommand } from './_helpers.js';

const M = komutlar.stats;

export const data = anywhereCommand('stats');

export async function execute(interaction, { music, startedAt, panel }) {
  const { client } = interaction;
  const users = client.guilds.cache.reduce((sum, guild) => sum + (guild.memberCount ?? 0), 0);
  const node = music.nodeStats();

  const embed = baseEmbed()
    .setTitle(M.baslik)
    .addFields(
      { name: M.gecikme, value: `${Math.max(client.ws.ping, 0)} ms`, inline: true },
      { name: M.calismaSuresi, value: formatUptime(Date.now() - startedAt), inline: true },
      { name: M.bellek, value: formatBytes(process.memoryUsage().rss), inline: true },
      { name: M.sunucular, value: String(client.guilds.cache.size), inline: true },
      { name: M.kullanicilar, value: String(users), inline: true },
      { name: M.aktifOyuncu, value: String(music.activeGuildIds().length), inline: true },
      { name: '📘 discord.js', value: discordJsVersion, inline: true },
      { name: '📗 Node.js', value: process.version, inline: true },
    );

  if (node) {
    embed.addFields({
      name: M.lavalink,
      value: M.lavalinkBilgisi({
        surum: node.version ?? '?',
        calan: `${node.playingPlayers}/${node.players}`,
        calisma: formatUptime(node.uptime),
        bellek: formatBytes(node.memoryUsed),
        cpu: (node.cpuLoad * 100).toFixed(1),
        eklentiler: node.plugins.join(', ') || '—',
      }),
    });
  } else {
    embed.addFields({ name: M.lavalink, value: M.lavalinkYok });
  }
  if (panel?.url) embed.addFields({ name: M.panel, value: panel.url });
  await interaction.reply({ embeds: [embed] });
}
