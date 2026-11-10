// Discord'dan gelen her eğik çizgi komutunu ilgili komut dosyasına yollar.
// Önce DJ rolü kuralını denetler (src/bot/dj.js), hataları Türkçe cevaba çevirir.
// Normalde bu dosyaya dokunmana gerek yok.

import { Events } from 'discord.js';
import { replyError } from '../commands/_helpers.js';
import { genel } from '../mesajlar.js';
import { MusicError, translateLavalinkError } from '../music/errors.js';
import { missingDjRole } from './dj.js';

/** Routes slash commands to their modules and turns errors into Turkish replies. */
export function registerInteractionHandler(context) {
  const { client, commands, logger } = context;

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = commands.get(interaction.commandName);
    if (!command) {
      await replyError(interaction, genel.komutYok).catch(() => {});
      return;
    }

    try {
      const djRoleId = missingDjRole(interaction, context);
      if (djRoleId) {
        await replyError(interaction, genel.djGerekli(djRoleId));
        return;
      }
      await command.execute(interaction, context);
    } catch (rawError) {
      const error = translateLavalinkError(rawError);
      if (error instanceof MusicError) {
        await replyError(interaction, error.message).catch(() => {});
        return;
      }
      logger.error(`/${interaction.commandName} komutunda hata:`, rawError);
      await replyError(interaction, genel.beklenmeyenHata).catch(() => {});
    }
  });
}
