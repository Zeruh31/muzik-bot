// /gecmis sayfa: bu sunucuda son çalınan 20 şarkıyı sayfa sayfa gösterir; menüden seçilen şarkı
// yeniden kuyruğa eklenir. Geçmişte şarkıyı kimin istediği tutulmaz (src/bot/gecmis.js).
// Listeyi yalnız komutu yazan kişi kullanabilir; 2 dakika dokunulmazsa düğmeler kapanır.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';
import { genel, komutlar } from '../mesajlar.js';
import { ErrorCodes, MusicError, translateLavalinkError } from '../music/errors.js';
import { baseEmbed, errorEmbed, trackDuration, trackLink } from '../util/embeds.js';
import { truncate } from '../util/format.js';
import { addedEmbed, describe, guildCommand, requireJoinableVoice } from './_helpers.js';

const M = komutlar.gecmis;
export const SHOWN = 20;
const PAGE_SIZE = 10;
const IDLE_MS = 120_000;

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('gecmis').addIntegerOption((option) =>
  describe(option, 'gecmis', 'sayfa')
    .setMinValue(1)
    .setMaxValue(Math.ceil(SHOWN / PAGE_SIZE)),
);

const ago = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;

/** Embed and components for one page of `entries` (newest first). */
export function renderHistoryPage(entries, page, prefix, { disabled = false } = {}) {
  const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const shown = entries.slice(start, start + PAGE_SIZE);
  const lines = shown.map(
    (t, i) =>
      `**${start + i + 1}.** ${trackLink(t, 60)} \`${trackDuration(t)}\`${t.playedAt ? ` • ${ago(t.playedAt)}` : ''}`,
  );
  const embed = baseEmbed()
    .setTitle(M.baslik)
    .setDescription(lines.join('\n'))
    .setFooter({ text: M.altBilgi(safePage, pageCount) });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${prefix}:menu`)
    .setPlaceholder(M.menuYazisi)
    .setDisabled(disabled)
    .addOptions(
      shown.map((t, i) => ({
        label: truncate(`${start + i + 1}. ${t.title}`, 100),
        description: truncate(`${t.author ?? ''} • ${trackDuration(t)}`, 100),
        value: String(start + i),
      })),
    );
  const components = [new ActionRowBuilder().addComponents(menu)];
  if (pageCount > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${prefix}:prev`)
          .setEmoji('◀️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || safePage <= 1),
        new ButtonBuilder()
          .setCustomId(`${prefix}:next`)
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || safePage >= pageCount),
      ),
    );
  }
  return { embed, components, page: safePage, pageCount };
}

/** Queues a history entry for whoever picked it (same voice rules as /play). Also used by the control center. */
export async function requeue(component, { music, logger }, entry) {
  try {
    const channel = requireJoinableVoice(component, music);
    await component.deferReply();
    const result = await music.playSaved({
      guildId: component.guildId,
      voiceChannelId: channel.id,
      textChannelId: component.channelId,
      entries: [entry],
      requester: component.user,
    });
    await component.editReply({ embeds: [addedEmbed(result)] });
  } catch (rawError) {
    const error = translateLavalinkError(rawError);
    if (!(error instanceof MusicError)) logger.error('Geçmişten eklenemedi:', rawError);
    const text = error instanceof MusicError ? error.message : genel.beklenmeyenHata;
    const payload = { embeds: [errorEmbed(text)], flags: MessageFlags.Ephemeral };
    if (component.deferred) await component.deleteReply().catch(() => {});
    await (component.deferred || component.replied ? component.followUp(payload) : component.reply(payload)).catch(
      () => {},
    );
  }
}

export async function execute(interaction, context) {
  const entries = context.music.getHistory(interaction.guildId, SHOWN);
  if (!entries.length) throw new MusicError(ErrorCodes.NOT_FOUND, M.bos);

  const prefix = `gecmis:${interaction.id}`;
  let view = renderHistoryPage(entries, interaction.options.getInteger('sayfa') ?? 1, prefix);
  const response = await interaction.reply({
    embeds: [view.embed],
    components: view.components,
    allowedMentions: { parse: [] },
    withResponse: true,
  });
  const collector = response.resource.message.createMessageComponentCollector({
    idle: IDLE_MS,
    filter: (component) => component.customId.startsWith(`${prefix}:`),
  });

  collector.on('collect', async (component) => {
    if (component.user.id !== interaction.user.id) {
      await component.reply({ content: M.sadeceYazan, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    if (component.componentType === ComponentType.StringSelect) {
      const entry = entries[Number(component.values[0])];
      if (entry) await requeue(component, context, entry);
      return;
    }
    const page = component.customId.endsWith(':next') ? view.page + 1 : view.page - 1;
    view = renderHistoryPage(entries, page, prefix);
    await component.update({ embeds: [view.embed], components: view.components }).catch(() => {});
  });

  collector.on('end', async () => {
    const closed = renderHistoryPage(entries, view.page, prefix, { disabled: true });
    await interaction.editReply({ components: closed.components }).catch(() => {});
  });
}
