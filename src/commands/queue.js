// /queue sayfa: şarkı kuyruğunu sayfa sayfa gösterir (◀️ ▶️ düğmeleriyle).
import { etiketler, komutlar } from '../mesajlar.js';
import { ErrorCodes, MusicError } from '../music/errors.js';
import { baseEmbed, requesterMention, trackDuration, trackLink } from '../util/embeds.js';
import { formatDuration } from '../util/format.js';
import { describe, guildCommand } from './_helpers.js';
import { replyPaged } from './_sayfalar.js';

const M = komutlar.queue;
const PAGE_SIZE = 10;

export const data = guildCommand('queue').addIntegerOption((option) =>
  describe(option, 'queue', 'sayfa').setMinValue(1),
);

/** Builds the embed for one page of the queue. */
export function renderQueuePage(state, page) {
  const pageCount = Math.max(1, Math.ceil(state.queue.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const lines = state.queue
    .slice(start, start + PAGE_SIZE)
    .map((t, i) => `**${start + i + 1}.** ${trackLink(t, 60)} \`${trackDuration(t)}\` • ${requesterMention(t)}`);
  const current = state.current
    ? M.simdiCaliyor(`${trackLink(state.current)} \`${trackDuration(state.current)}\``)
    : M.simdiCalanYok;

  const embed = baseEmbed()
    .setTitle(M.baslik)
    .setDescription([current, '', lines.length ? lines.join('\n') : M.bekleyenYok].join('\n'))
    .setFooter({
      text: M.altBilgi(
        safePage,
        pageCount,
        state.queue.length,
        formatDuration(state.queueDuration),
        etiketler.tekrar[state.repeatMode] ?? state.repeatMode,
      ),
    });
  return { embed, page: safePage, pageCount };
}

export async function execute(interaction, { music }) {
  const state = music.getState(interaction.guildId);
  if (!state || (!state.current && state.queue.length === 0)) throw new MusicError(ErrorCodes.EMPTY_QUEUE, M.bos);

  await replyPaged(interaction, {
    startPage: interaction.options.getInteger('sayfa') ?? 1,
    render: (page) => {
      const fresh = music.getState(interaction.guildId);
      return fresh ? renderQueuePage(fresh, page) : null;
    },
  });
}
