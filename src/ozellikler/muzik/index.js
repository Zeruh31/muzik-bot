// "Müzik" modülü: kontrol merkezindeki (/menu ve kalıcı panel) müzik bölümü. Müzik komutları
// src/commands/ altında kalır; buradaki düğmeler aynı işlemleri ve kuralları kullanır:
//   oz:muzik:k:<eylem>   önceki/duraklat/atla/durdur/döngü/karıştır (src/bot/controls.js ile aynı denetimler)
//   oz:muzik:ekle        "Şarkı ekle" formunu açar; form /play ile aynı akıştan geçer
//   oz:muzik:kuyruk, oz:muzik:listeler, oz:muzik:liste, oz:muzik:gecmis-ac, oz:muzik:gecmis
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputStyle,
} from 'discord.js';
import { CONTROL_ACTIONS, controlRows, runCheckedControl } from '../../bot/controls.js';
import { requeue, SHOWN as HISTORY_SHOWN } from '../../commands/gecmis.js';
import { playList } from '../../commands/liste.js';
import { playQuery } from '../../commands/play.js';
import { renderQueuePage } from '../../commands/queue.js';
import { komutlar } from '../../mesajlar.js';
import { errorEmbed, requesterMention, trackDuration, trackLink } from '../../util/embeds.js';
import { escapeMarkdown, truncate } from '../../util/format.js';
import { ortak } from '../_mesajlar.js';
import { defineModule, ozId } from '../_ortak.js';
import { OzellikHatasi, userMessageOf } from '../_yonlendirici.js';
import * as mesajlar from './mesajlar.js';

const { bolum: B, dugmeler: D, form: F, secimler: S } = mesajlar;
const MAX_OPTIONS = 25;
const QUEUE_PREVIEW = 3;
/** The end time on the panel is rounded so that re-rendering does not change it by a second. */
const END_ROUND_MS = 5000;
const QUERY_INPUT = 'sorgu';

const isEphemeral = (message) => Boolean(message?.flags?.has?.(MessageFlags.Ephemeral));
const httpsUrl = (value) => (typeof value === 'string' && /^https:\/\/\S+$/i.test(value) ? value : null);

function requireGuild(interaction) {
  if (!interaction.guildId) throw new OzellikHatasi(ortak.sunucudaKullan);
}

/** Runs a handler that defers its reply; an error after the deferral replaces the "thinking…" message. */
async function withDeferredErrors(interaction, run) {
  try {
    await run();
  } catch (error) {
    if (!interaction.deferred || interaction.replied) throw error;
    const text = userMessageOf(error);
    if (!text) throw error;
    await interaction.editReply({ embeds: [errorEmbed(text)], components: [] }).catch(() => {});
  }
}

/** "Now playing" text of a getState() snapshot. */
export function nowPlayingText(state) {
  const track = state?.current;
  if (!track) return B.calanYok;
  const details = [`\`${trackDuration(track)}\``, B.isteyen(track.autoplay ? '🤖' : requesterMention(track))];
  if (state.paused) details.push(B.duraklatildi);
  else if (!track.isStream && track.duration > 0) {
    const end = (state.positionAt ?? Date.now()) - (state.position ?? 0) + track.duration;
    details.push(B.bitis(`<t:${Math.round(end / END_ROUND_MS) * (END_ROUND_MS / 1000)}:R>`));
  }
  return [B.simdiCaliyor, trackLink(track, 150), escapeMarkdown(truncate(track.author, 100)), details.join(' • ')].join(
    '\n',
  );
}

function queueText(state) {
  const queue = state?.queue ?? [];
  if (!queue.length) return B.siraBos;
  const lines = queue.slice(0, QUEUE_PREVIEW).map((t, i) => `${i + 1}. ${trackLink(t, 60)} \`${trackDuration(t)}\``);
  if (queue.length > QUEUE_PREVIEW) lines.push(B.dahaFazla(queue.length - QUEUE_PREVIEW));
  return [B.siradakiler(queue.length), ...lines].join('\n');
}

/** The music section's components for /menu and the panel. */
export function drawMusicSection(state) {
  const components = [];
  const text = new TextDisplayBuilder().setContent(nowPlayingText(state));
  const artwork = httpsUrl(state?.current?.artworkUrl);
  if (artwork) {
    components.push(
      new SectionBuilder().addTextDisplayComponents(text).setThumbnailAccessory((thumb) => thumb.setURL(artwork)),
    );
  } else {
    components.push(text);
  }
  if (state?.current) components.push(new TextDisplayBuilder().setContent(queueText(state)));
  components.push(...controlRows(state, { disabled: !state?.current, idOf: (action) => ozId('muzik', 'k', action) }));
  components.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(ozId('muzik', 'ekle'))
        .setEmoji('➕')
        .setLabel(D.ekle)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(ozId('muzik', 'kuyruk'))
        .setEmoji('📜')
        .setLabel(D.kuyruk)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ozId('muzik', 'listeler'))
        .setEmoji('📚')
        .setLabel(D.listeler)
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ozId('muzik', 'gecmis-ac'))
        .setEmoji('🕘')
        .setLabel(D.gecmis)
        .setStyle(ButtonStyle.Secondary),
    ),
  );
  return components;
}

/** The "Şarkı ekle" form. */
export function addSongModal() {
  return new ModalBuilder()
    .setCustomId(ozId('muzik', 'ekle-gonder'))
    .setTitle(F.baslik)
    .addLabelComponents((label) =>
      label
        .setLabel(F.alan)
        .setDescription(F.ipucu)
        .setTextInputComponent((input) =>
          input.setCustomId(QUERY_INPUT).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500),
        ),
    );
}

const ephemeral = (payload) => ({ ...payload, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

export default defineModule({
  ad: 'muzik',
  mesajlar,
  intentler: ['Guilds', 'GuildVoiceStates'],
  menu: {
    sira: 10,
    gorunurluk: 'herkes',
    ciz: ({ context, guildId }) => drawMusicSection(context.music.getState(guildId)),
  },
  bilesenler: {
    async k(interaction, context, [action]) {
      requireGuild(interaction);
      if (!Object.hasOwn(CONTROL_ACTIONS, action ?? '')) throw new OzellikHatasi(ortak.eskiDugme);
      const result = await runCheckedControl(interaction, context, action);
      // The fixed panel follows the player's events; an ephemeral /menu is refreshed here.
      if (result === 'done' && isEphemeral(interaction.message)) {
        await interaction.editReply(context.ozellikler.menu.payloadFor(interaction, 'muzik')).catch(() => {});
      }
    },

    async ekle(interaction) {
      requireGuild(interaction);
      await interaction.showModal(addSongModal());
    },

    async 'ekle-gonder'(interaction, context) {
      requireGuild(interaction);
      const query = interaction.fields.getTextInputValue(QUERY_INPUT);
      await withDeferredErrors(interaction, () => playQuery(interaction, context, query));
    },

    async kuyruk(interaction, { music }) {
      requireGuild(interaction);
      const state = music.getState(interaction.guildId);
      if (!state || (!state.current && state.queue.length === 0)) throw new OzellikHatasi(komutlar.queue.bos);
      await interaction.reply(ephemeral({ embeds: [renderQueuePage(state, 1).embed] }));
    },

    async listeler(interaction, { playlists }) {
      requireGuild(interaction);
      const lists = playlists.list(interaction.guildId).slice(0, MAX_OPTIONS);
      if (!lists.length) throw new OzellikHatasi(S.listeBos);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(ozId('muzik', 'liste'))
        .setPlaceholder(S.listeYazisi)
        .addOptions(
          lists.map((l) => ({ label: truncate(l.name, 100), description: S.listeSatiri(l.count), value: l.name })),
        );
      await interaction.reply(ephemeral({ components: [new ActionRowBuilder().addComponents(menu)] }));
    },

    async liste(interaction, context) {
      requireGuild(interaction);
      const name = interaction.values?.[0];
      await withDeferredErrors(interaction, () => playList(interaction, context, name));
    },

    async 'gecmis-ac'(interaction, { music }) {
      requireGuild(interaction);
      const entries = music.getHistory(interaction.guildId, HISTORY_SHOWN).slice(0, MAX_OPTIONS);
      if (!entries.length) throw new OzellikHatasi(S.gecmisBos);
      const menu = new StringSelectMenuBuilder()
        .setCustomId(ozId('muzik', 'gecmis'))
        .setPlaceholder(S.gecmisYazisi)
        .addOptions(
          entries.map((t, i) => ({
            label: truncate(`${i + 1}. ${t.title}`, 100),
            description: truncate(`${t.author ?? ''} • ${trackDuration(t)}`, 100),
            value: String(i),
          })),
        );
      await interaction.reply(ephemeral({ components: [new ActionRowBuilder().addComponents(menu)] }));
    },

    async gecmis(interaction, context) {
      requireGuild(interaction);
      const index = Number(interaction.values?.[0]);
      const entry = Number.isInteger(index)
        ? context.music.getHistory(interaction.guildId, HISTORY_SHOWN)[index]
        : null;
      if (!entry) throw new OzellikHatasi(S.gecmisDegisti);
      await requeue(interaction, context, entry);
    },
  },
});
