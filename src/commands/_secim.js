// Şarkı seçme listesi: /play (şarkı adıyla) ve /search bunu kullanır.
// Sonuçları numaralı gösterir; yalnızca komutu yazan kişi seçebilir. Süre dolarsa liste silinir.
// Kaç sonuç gösterileceği ve bekleme süresi src/gorunum.js içinde, yazılar src/mesajlar.js içinde.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { secim as ayar } from '../gorunum.js';
import { etiketler, secim } from '../mesajlar.js';
import { MusicError } from '../music/errors.js';
import { toTrackView } from '../music/MusicService.js';
import { baseEmbed, errorEmbed, trackDuration, trackLink } from '../util/embeds.js';
import { escapeMarkdown, truncate } from '../util/format.js';
import { addedEmbed, requireJoinableVoice } from './_helpers.js';

const MAX_BUTTONS = 5; // one row of buttons
const MAX_MENU_OPTIONS = 25; // Discord's limit for a select menu

/** Buttons "1".."n" for up to 5 results, a select menu for more. */
function choiceComponents(prefix, views) {
  if (views.length <= MAX_BUTTONS) {
    return new ActionRowBuilder().addComponents(
      views.map((_, i) =>
        new ButtonBuilder()
          .setCustomId(`${prefix}:${i}`)
          .setLabel(String(i + 1))
          .setStyle(ButtonStyle.Primary),
      ),
    );
  }
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}:menu`)
      .setPlaceholder(secim.menuYazisi)
      .addOptions(
        views.map((t, i) => ({
          label: truncate(`${i + 1}. ${t.title}`, 100),
          description: truncate(`${t.author} • ${trackDuration(t)}`, 100),
          value: String(i),
        })),
      ),
  );
}

/** Index of the picked result from a button ("prefix:3") or the select menu (values ["3"]). */
function pickedIndex(component) {
  const raw = component.isStringSelectMenu?.() ? component.values[0] : component.customId.split(':').pop();
  return Number(raw);
}

/**
 * Shows search results and queues the one the command's author picks.
 * The interaction must already be deferred. `tracks` are the raw search results. The pick is
 * the user's explicit choice, so no other result is played automatically if it fails.
 */
export async function pickAndPlay(
  interaction,
  { music, logger },
  { tracks, query, voiceChannelId, count, timeMs = ayar.sureSaniye * 1000 },
) {
  const shown = tracks.slice(0, Math.min(count, MAX_MENU_OPTIONS));
  const views = shown.map(toTrackView);
  const prefix = `secim:${interaction.id}`;

  const embed = baseEmbed()
    .setTitle(secim.baslik)
    .setDescription(views.map((t, i) => `**${i + 1}.** ${trackLink(t, 70)} \`${trackDuration(t)}\``).join('\n'))
    .addFields(
      { name: etiketler.isteyen, value: `<@${interaction.user.id}>`, inline: true },
      { name: etiketler.sesKanali, value: `<#${voiceChannelId}>`, inline: true },
    )
    .setFooter({ text: secim.altBilgi(Math.round(timeMs / 1000)) });

  const message = await interaction.editReply({
    embeds: [embed],
    components: [choiceComponents(prefix, views)],
    allowedMentions: { parse: [] },
  });

  const picked = await message
    .awaitMessageComponent({
      time: timeMs,
      filter: async (component) => {
        if (!component.customId.startsWith(`${prefix}:`)) return false;
        if (component.user.id === interaction.user.id) return true;
        await component.reply({ content: secim.sadeceYazan, flags: MessageFlags.Ephemeral }).catch(() => {});
        return false;
      },
    })
    .catch(() => null);

  if (!picked) {
    await interaction
      .editReply({ content: secim.zamanAsimi(escapeMarkdown(query)), embeds: [], components: [] })
      .catch(() => {});
    return null;
  }

  const index = pickedIndex(picked);
  const chosen = shown[index];
  try {
    await picked.deferUpdate();
    const channel = requireJoinableVoice(picked, music);
    const result = await music.enqueue({
      guildId: interaction.guildId,
      voiceChannelId: channel.id,
      textChannelId: interaction.channelId,
      tracks: [chosen],
      fromList: true,
    });
    await interaction.editReply({ embeds: [addedEmbed(result)], components: [] });
    return result;
  } catch (error) {
    if (!(error instanceof MusicError)) logger.error('Şarkı seçimi başarısız:', error);
    const text = error instanceof MusicError ? error.message : secim.eklenemedi(escapeMarkdown(chosen.info?.title));
    await interaction.editReply({ embeds: [errorEmbed(text)], components: [] }).catch(() => {});
    return null;
  }
}
