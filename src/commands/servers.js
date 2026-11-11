// /servers: botun bulunduğu sunucuları ad ve üye sayısıyla listeler. Yalnızca bot sahibi kullanabilir,
// cevabı da yalnızca o görür. Sahibin kim olduğu src/bot/owner.js içinde (ya da .env > BOT_OWNER_IDS).
import { genel, komutlar } from '../mesajlar.js';
import { baseEmbed } from '../util/embeds.js';
import { escapeMarkdown, truncate } from '../util/format.js';
import { anywhereCommand, replyError } from './_helpers.js';
import { replyPaged } from './_sayfalar.js';

const M = komutlar.servers;
const PAGE_SIZE = 10; // one embed field per server; Discord allows at most 25

export const data = anywhereCommand('servers');
export const kategori = 'genel';

/** Builds one page of the server list (biggest servers first). */
export function renderServerPage(guilds, page) {
  const sorted = [...guilds].sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), pageCount);
  const slice = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const embed = baseEmbed()
    .setTitle(M.baslik(sorted.length))
    .setFooter({ text: M.altBilgi(safePage, pageCount) });
  if (slice.length === 0) embed.setDescription(M.hicYok);
  embed.addFields(
    slice.map((guild) => ({
      name: escapeMarkdown(truncate(guild.name, 100)), // escaping at most doubles it: below the 256 limit
      value: M.uyeSayisi(guild.memberCount ?? 0),
    })),
  );
  return { embed, page: safePage, pageCount };
}

export async function execute(interaction, { isOwner }) {
  if (!(await isOwner(interaction.user.id))) {
    await replyError(interaction, genel.yetkiYok);
    return;
  }
  await replyPaged(interaction, {
    ephemeral: true,
    render: (page) => renderServerPage(interaction.client.guilds.cache.values(), page),
  });
}
