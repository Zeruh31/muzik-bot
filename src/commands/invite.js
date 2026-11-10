// /invite: botu başka bir sunucuya eklemek için davet bağlantısı verir.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, OAuth2Scopes } from 'discord.js';
import { BOT_PERMISSIONS } from '../bot/permissions.js';
import { komutlar } from '../mesajlar.js';
import { baseEmbed } from '../util/embeds.js';
import { anywhereCommand } from './_helpers.js';

const M = komutlar.invite;

export const data = anywhereCommand('invite');

export async function execute(interaction) {
  const url = interaction.client.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: BOT_PERMISSIONS,
  });
  const embed = baseEmbed().setTitle(M.baslik).setDescription(M.metin);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(M.dugme).setURL(url),
  );
  await interaction.reply({ embeds: [embed], components: [row] });
}
