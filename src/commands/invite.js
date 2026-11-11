// /invite: botu başka bir sunucuya eklemek için davet bağlantısı verir.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, OAuth2Scopes } from 'discord.js';
import { botPermissions } from '../bot/permissions.js';
import { komutlar } from '../mesajlar.js';
import { baseEmbed } from '../util/embeds.js';
import { anywhereCommand } from './_helpers.js';

const M = komutlar.invite;

export const data = anywhereCommand('invite');
export const kategori = 'genel';

export async function execute(interaction, { ozellikler } = {}) {
  const url = interaction.client.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    // Music plus what the loaded feature modules ask for (src/bot/permissions.js).
    permissions: botPermissions(ozellikler?.moduller?.values()),
  });
  const embed = baseEmbed().setTitle(M.baslik).setDescription(M.metin);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(M.dugme).setURL(url),
  );
  await interaction.reply({ embeds: [embed], components: [row] });
}
