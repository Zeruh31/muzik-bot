// Sayfalı liste: ◀️ ▶️ düğmeleriyle sayfa çevrilen mesajlar (/queue ve /servers).
// Sayfaları yalnızca komutu yazan kişi çevirebilir; 2 dakika dokunulmazsa düğmeler kapanır.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { sayfalar } from '../mesajlar.js';

const IDLE_MS = 120_000;

function buttons(prefix, page, pageCount, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page <= 1),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || page >= pageCount),
  );
}

/**
 * Replies with page `startPage` and lets the author flip pages.
 * `render(page)` returns { embed, page, pageCount } (page clamped), or null when the data is gone.
 * It is called again on every click, so pages always show fresh data.
 */
export async function replyPaged(interaction, { render, startPage = 1, ephemeral = false }) {
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
  let view = render(startPage);
  if (view.pageCount <= 1) {
    await interaction.reply({ embeds: [view.embed], flags });
    return;
  }

  const prefix = `sayfa:${interaction.id}`;
  const response = await interaction.reply({
    embeds: [view.embed],
    components: [buttons(prefix, view.page, view.pageCount)],
    flags,
    withResponse: true,
  });
  const collector = response.resource.message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    idle: IDLE_MS,
    filter: (button) => button.customId.startsWith(`${prefix}:`),
  });

  collector.on('collect', async (button) => {
    if (button.user.id !== interaction.user.id) {
      await button.reply({ content: sayfalar.sadeceYazan, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const next = render(button.customId.endsWith(':next') ? view.page + 1 : view.page - 1);
    if (!next) {
      collector.stop('gone');
      await button.update({ components: [] }).catch(() => {});
      return;
    }
    view = next;
    await button
      .update({ embeds: [view.embed], components: [buttons(prefix, view.page, view.pageCount)] })
      .catch(() => {});
  });

  collector.on('end', async () => {
    await interaction.editReply({ components: [buttons(prefix, view.page, view.pageCount, true)] }).catch(() => {});
  });
}
