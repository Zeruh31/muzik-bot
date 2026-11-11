// /help: komutları kategori kategori gösterir; alttaki menüden kategori seçilir (Müzik, Oyun, Genel, Ayarlar...).
// Liste komut kayıtlarından kendiliğinden kurulur: yeni bir komut ya da alt komut eklenince burada da görünür.
// En altta (doluysa) destek sunucusu ve yapımcı bağlantıları: .env > BRAND_SUPPORT_URL, BRAND_AUTHOR_NAME, BRAND_AUTHOR_URL.
import { ActionRowBuilder, ApplicationCommandOptionType, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { komutlar } from '../mesajlar.js';
import { ozId } from '../ozellikler/_ortak.js';
import { kategoriler, yardim as Y } from '../ozellikler/yardim/mesajlar.js';
import { baseEmbed } from '../util/embeds.js';
import { escapeMarkdown } from '../util/format.js';
import { anywhereCommand } from './_helpers.js';

const M = komutlar.help;
const CATEGORY_ORDER = ['muzik', 'oyun', 'genel', 'ayarlar'];
const DESCRIPTION_MAX = 4000;

export const data = anywhereCommand('help');
export const kategori = 'genel';

/**
 * "[Discord](...) • By [Name](...)" from config.brand; empty parts are left out,
 * so with nothing set in .env the /help embed has no links field at all.
 */
export function brandLine(brand = {}) {
  const parts = [];
  if (brand.supportUrl) parts.push(M.discordBaglantisi(brand.supportUrl));
  const name = brand.authorName ? escapeMarkdown(brand.authorName.replace(/[[\]()]/g, '')) : '';
  if (name && brand.authorUrl) parts.push(M.yazar(name, brand.authorUrl));
  else if (name) parts.push(M.yazarBaglantisiz(name));
  return parts.join(' • ');
}

/** "/name — description" lines of one command, one per subcommand (and group subcommand). */
export function commandLines(command) {
  const json = command.data.toJSON();
  if ((json.type ?? 1) !== 1) return [`${Y.sagTik(json.name)}`];
  const subs = (json.options ?? []).filter((o) =>
    [ApplicationCommandOptionType.Subcommand, ApplicationCommandOptionType.SubcommandGroup].includes(o.type),
  );
  if (!subs.length) return [`\`/${json.name}\` — ${json.description}`];
  return subs.flatMap((sub) =>
    sub.type === ApplicationCommandOptionType.SubcommandGroup
      ? (sub.options ?? []).map((leaf) => `\`/${json.name} ${sub.name} ${leaf.name}\` — ${leaf.description}`)
      : [`\`/${json.name} ${sub.name}\` — ${sub.description}`],
  );
}

/** Category name -> its commands, in a stable order. */
export function commandsByCategory(commands) {
  const groups = new Map();
  for (const command of commands.values()) {
    const name = command.kategori ?? 'muzik';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(command);
  }
  for (const list of groups.values()) list.sort((a, b) => a.data.name.localeCompare(b.data.name));
  const rank = (name) => (CATEGORY_ORDER.includes(name) ? CATEGORY_ORDER.indexOf(name) : CATEGORY_ORDER.length);
  return new Map([...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)));
}

// A category without an entry in yardim/mesajlar.js is shown by its name (no emoji: Discord refuses invalid ones).
const labelOf = (name) => kategoriler[name] ?? { ad: name, emoji: null, aciklama: null };

/**
 * The /help message for one category (the first one when `wanted` is unknown).
 * @returns {{ embeds: object[], components: object[] }}
 */
export function renderHelp({ commands, config, panel }, wanted) {
  const groups = commandsByCategory(commands);
  const names = [...groups.keys()];
  const shown = names.includes(wanted) ? wanted : names[0];
  const label = labelOf(shown);
  let text = (groups.get(shown) ?? []).flatMap(commandLines).join('\n');
  if (text.length > DESCRIPTION_MAX) text = `${text.slice(0, DESCRIPTION_MAX)}\n…`;

  const notes = [
    config.music.twentyFourSeven ? M.yirmiDortYedi : M.bosKanal(config.music.leaveWhenEmptySeconds),
    M.kaynaklar,
    Y.menuIpucu,
  ];
  if (panel?.url) notes.push(M.panel(panel.url));

  const embed = baseEmbed()
    .setTitle(Y.kategoriBasligi(label.emoji ?? '📂', label.ad))
    .setDescription(text || '—')
    .addFields({ name: M.bilgiBasligi, value: notes.join('\n') });
  const brand = brandLine(config.brand);
  if (brand) embed.addFields({ name: M.baglantilarBasligi, value: brand });

  const components = [];
  if (names.length > 1) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(ozId('yardim', 'kategori'))
      .setPlaceholder(Y.kategoriSec)
      .addOptions(
        names.slice(0, 25).map((name) => {
          const { ad, emoji, aciklama } = labelOf(name);
          return {
            label: ad,
            value: name,
            default: name === shown,
            ...(emoji ? { emoji } : {}),
            ...(aciklama ? { description: aciklama } : {}),
          };
        }),
      );
    components.push(new ActionRowBuilder().addComponents(select));
  }
  return { embeds: [embed], components };
}

export async function execute(interaction, context) {
  await interaction.reply({ ...renderHelp(context, 'muzik'), flags: MessageFlags.Ephemeral });
}
