// /liste: sunucuya kayıtlı çalma listeleri. Alt komutlar: kaydet, çal, ekle, göster, sil.
// Listeler data/listeler.json dosyasında (src/bot/listeler.js); sınırlar: liste başına 500 şarkı,
// sunucu başına 50 liste. Bir listeyi yalnızca onu oluşturan ya da "Sunucuyu Yönet" izni olan silebilir.
import { PermissionFlagsBits } from 'discord.js';
import { LIMITS } from '../bot/listeler.js';
import { komutlar, muzik } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';
import { baseEmbed, trackLink } from '../util/embeds.js';
import { escapeMarkdown, formatDuration } from '../util/format.js';
import { addedEmbed, guildCommand, replySuccess, requireJoinableVoice } from './_helpers.js';
import { replyPaged } from './_sayfalar.js';

const M = komutlar.liste;
const PAGE_SIZE = 15;
/** The "120/500 eklendi" message is edited at most this often while a list loads. */
const PROGRESS_EDIT_MS = 2000;

function nameOption(option, { required = true, autocomplete = true } = {}) {
  return option
    .setName('ad')
    .setDescription(M.secenekler.ad)
    .setRequired(required)
    .setMaxLength(LIMITS.nameLength)
    .setAutocomplete(autocomplete);
}

const sub = (name, options) => (subcommand) =>
  subcommand
    .setName(name)
    .setDescription(M.altKomutlar[name])
    .addStringOption((option) => nameOption(option, options));

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('liste')
  .addSubcommand(sub('kaydet', { autocomplete: false }))
  .addSubcommand(sub('çal'))
  .addSubcommand(sub('ekle'))
  .addSubcommand(sub('göster', { required: false }))
  .addSubcommand(sub('sil'));

/** Suggests the server's list names while the user types. */
export async function autocomplete(interaction, { playlists }) {
  const typed = interaction.options.getFocused();
  const names = playlists.suggest(interaction.guildId, typed);
  await interaction.respond(names.map((name) => ({ name, value: name })));
}

/** One page of the server's lists. */
export function renderListsPage(lists, page) {
  const pageCount = Math.max(1, Math.ceil(lists.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const lines = lists
    .slice(start, start + PAGE_SIZE)
    .map((l) => M.listeSatiri(escapeMarkdown(l.name), l.count, l.ownerId));
  const embed = baseEmbed()
    .setTitle(M.listelerBasligi(lists.length, LIMITS.listsPerGuild))
    .setDescription(lines.join('\n'))
    .setFooter({ text: M.altBilgi(safePage, pageCount) });
  return { embed, page: safePage, pageCount };
}

/** One page of a single list's songs. */
export function renderListPage(list, page) {
  const pageCount = Math.max(1, Math.ceil(list.tracks.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const lines = list.tracks
    .slice(start, start + PAGE_SIZE)
    .map((t, i) => `**${start + i + 1}.** ${trackLink(t, 60)} \`${formatDuration(t.duration)}\``);
  const total = list.tracks.reduce((sum, t) => sum + t.duration, 0);
  const embed = baseEmbed()
    .setTitle(M.listeBasligi(escapeMarkdown(list.name)))
    .setDescription(lines.length ? lines.join('\n') : M.listeBos)
    .setFooter({ text: M.listeAltBilgi(safePage, pageCount, list.tracks.length, formatDuration(total)) });
  return { embed, page: safePage, pageCount };
}

async function save(interaction, { music, playlists }) {
  const state = music.getState(interaction.guildId);
  const views = [state?.current, ...(state?.queue ?? [])].filter(Boolean);
  if (!views.length) throw new MusicError(ErrorCodes.EMPTY_QUEUE, M.kaydedilecekYok);
  const { name, saved, dropped } = playlists.create(
    interaction.guildId,
    interaction.options.getString('ad', true),
    interaction.user.id,
    views,
  );
  const tail = dropped > 0 ? M.sinirdanKesildi(dropped) : '';
  await replySuccess(interaction, `${M.kaydedildi(escapeMarkdown(name), saved)}${tail}`);
}

async function play(interaction, context) {
  await playList(interaction, context, interaction.options.getString('ad', true));
}

/**
 * Queues a saved list (/muzik liste çal). Also used by the control center's list menu, so it only
 * needs an interaction that can defer and edit its reply.
 */
export async function playList(interaction, { music, playlists }, listName) {
  const list = playlists.get(interaction.guildId, listName);
  const channel = requireJoinableVoice(interaction, music);
  await interaction.deferReply();
  let lastEdit = 0;
  let pending = Promise.resolve();
  const show = (progress, footer) => {
    const embed = addedEmbed({
      kind: 'playlist',
      playlistName: list.name,
      tracks: { length: progress.added },
      skippedForLimit: progress.skippedForLimit ?? 0,
      skippedUnsupported: 0,
      failedToResolve: progress.failed ?? 0,
    }).setFooter({ text: footer });
    pending = pending.then(() => interaction.editReply({ embeds: [embed] }).catch(() => {}));
    return pending;
  };
  // The first song plays as soon as it loads; the rest is queued in the background.
  const result = await music.playSaved({
    guildId: interaction.guildId,
    voiceChannelId: channel.id,
    textChannelId: interaction.channelId,
    entries: list.tracks,
    requester: interaction.user,
    playlistName: list.name,
    onProgress: (progress) => {
      if (Date.now() - lastEdit < PROGRESS_EDIT_MS) return;
      lastEdit = Date.now();
      show(progress, M.ilerleme(progress.added, progress.total));
    },
  });
  lastEdit = Date.now();
  const total = result.total;
  const first = { added: 1, failed: result.failedToResolve, skippedForLimit: result.skippedForLimit, total };
  await show(first, total > 1 ? M.ilerleme(1, total) : M.bitti(1, total));
  const final = await result.done;
  if (total > 1 || final.added > 1) {
    await show(final, final.stopped ? M.yarimKaldi(final.added, total) : M.bitti(final.added, total));
  }
}

async function add(interaction, { music, playlists }) {
  const track = music.getState(interaction.guildId)?.current;
  if (!track) throw new MusicError(ErrorCodes.NOTHING_PLAYING, muzik.calanYok);
  const { name, count } = playlists.append(
    interaction.guildId,
    interaction.options.getString('ad', true),
    interaction.user.id,
    track,
  );
  await replySuccess(interaction, M.eklendi(trackLink(track), escapeMarkdown(name), count));
}

async function show(interaction, { playlists }) {
  const guildId = interaction.guildId;
  const name = interaction.options.getString('ad');
  if (name) {
    playlists.get(guildId, name); // NOT_FOUND before replying
    await replyPaged(interaction, {
      render: (page) => {
        try {
          return renderListPage(playlists.get(guildId, name), page);
        } catch {
          return null; // deleted meanwhile
        }
      },
    });
    return;
  }
  if (!playlists.list(guildId).length) throw new MusicError(ErrorCodes.NOT_FOUND, M.bos);
  await replyPaged(interaction, {
    render: (page) => {
      const lists = playlists.list(guildId);
      return lists.length ? renderListsPage(lists, page) : null;
    },
  });
}

async function remove(interaction, { playlists }) {
  const name = playlists.remove(interaction.guildId, interaction.options.getString('ad', true), {
    userId: interaction.user.id,
    canManageGuild: Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)),
  });
  await replySuccess(interaction, M.silindi(escapeMarkdown(name)));
}

const HANDLERS = { kaydet: save, çal: play, ekle: add, göster: show, sil: remove };

export async function execute(interaction, context) {
  const handler = HANDLERS[interaction.options.getSubcommand()];
  await handler(interaction, context);
}
