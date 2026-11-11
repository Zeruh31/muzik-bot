// /muzik: sık kullanılmayan müzik komutlarının çatısı (/muzik search, /muzik loop, /muzik liste kaydet ...).
// Alt komutlar kendi dosyalarında kalır ve aynı mantığı kullanır; bir dosyanın buraya girmesi için içinde
// `export const ust = 'muzik'` yazması yeter. Sık kullanılanlar (/play, /skip, /stop, /queue, /nowplaying,
// /pause, /resume) üst düzeydedir. Normalde bu dosyaya dokunmana gerek yok.
import { ApplicationCommandOptionType } from 'discord.js';
import { guildCommand } from './_helpers.js';

export const data = guildCommand('muzik');

/** A subcommand file's command JSON as a /muzik option: a subcommand, or a group when it has its own. */
function asOption(command) {
  const json = command.data.toJSON();
  const isGroup = (json.options ?? []).some((o) => o.type === ApplicationCommandOptionType.Subcommand);
  const option = {
    type: isGroup ? ApplicationCommandOptionType.SubcommandGroup : ApplicationCommandOptionType.Subcommand,
    name: json.name,
    description: json.description,
    options: json.options ?? [],
  };
  if (json.name_localizations) option.name_localizations = json.name_localizations;
  if (json.description_localizations) option.description_localizations = json.description_localizations;
  return option;
}

/** Which subcommand file an interaction of /muzik belongs to. */
const subName = (interaction) =>
  interaction.options.getSubcommandGroup(false) ?? interaction.options.getSubcommand(false);

/**
 * Builds /muzik from its subcommand files (called by the loader in index.js).
 * @param {Map<string, { data: object, execute: Function, autocomplete?: Function }>} subs
 */
export function altKomutlar(subs) {
  const pick = (interaction) => subs.get(subName(interaction) ?? '');
  return {
    data: {
      name: data.name,
      description: data.description,
      toJSON: () => ({ ...data.toJSON(), options: [...subs.values()].map(asOption) }),
    },
    subcommands: subs,
    /** The DJ rule (src/bot/dj.js) is per subcommand: "/muzik loop" follows "loop". */
    djName: (interaction) => subName(interaction),
    /** Usage counters (src/bot/durumDosyasi.js) keep the old names: "/muzik seek" counts as "seek". */
    statName: (interaction) => subName(interaction) ?? 'muzik',
    async execute(interaction, context) {
      const sub = pick(interaction);
      if (!sub) throw new Error(`/muzik: bilinmeyen alt komut ${subName(interaction)}`);
      await sub.execute(interaction, context);
    },
    async autocomplete(interaction, context) {
      const sub = pick(interaction);
      if (sub?.autocomplete) await sub.autocomplete(interaction, context);
      else await interaction.respond([]);
    },
  };
}

export async function execute() {
  throw new Error('/muzik alt komutları yüklenmedi (src/commands/index.js).');
}
