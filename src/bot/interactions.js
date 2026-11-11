// Discord'dan gelen her eğik çizgi ve sağ tık komutunu ilgili komut dosyasına yollar.
// Önce DJ rolü kuralını denetler (src/bot/dj.js), hataları Türkçe cevaba çevirir.
// "Şimdi çalıyor" düğmelerini (src/bot/controls.js, "muzikbot-kontrol:" öneki), özelliklerin kalıcı
// düğme/menü/formlarını (src/ozellikler/_yonlendirici.js, "oz:" öneki) ve otomatik tamamlamayı da yönlendirir.
// Normalde bu dosyaya dokunmana gerek yok.

import { Events } from 'discord.js';
import { replyError } from '../commands/_helpers.js';
import { genel } from '../mesajlar.js';
import { userMessageOf } from '../ozellikler/_yonlendirici.js';
import { handleControlButton } from './controls.js';
import { missingDjRole } from './dj.js';

/** Routes commands and components to their modules and turns errors into Turkish replies. */
export function registerInteractionHandler(context) {
  const { client, commands, logger } = context;

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isMessageComponent?.() || interaction.isModalSubmit?.()) {
      try {
        // Feature components ("oz:..."), then the now-playing controls; other components belong
        // to their own message collectors (/play choices, page buttons).
        if (await context.ozellikler?.router.handle(interaction, context)) return;
        if (interaction.isButton?.()) await handleControlButton(interaction, context);
      } catch (error) {
        logger.error('Bileşen hatası:', error);
      }
      return;
    }
    if (interaction.isAutocomplete?.()) {
      const command = commands.get(interaction.commandName);
      try {
        if (command?.autocomplete) await command.autocomplete(interaction, context);
        else await interaction.respond([]);
      } catch (error) {
        logger.debug(`/${interaction.commandName} otomatik tamamlama hatası:`, error?.message ?? error);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }
    if (!interaction.isChatInputCommand() && !interaction.isContextMenuCommand?.()) return;
    const command = commands.get(interaction.commandName);
    if (!command) {
      await replyError(interaction, genel.komutYok).catch(() => {});
      return;
    }

    try {
      const off = command.modul ? context.ozellikler?.disabledReason(command.modul) : null;
      if (off) {
        await replyError(interaction, off);
        return;
      }
      const djRoleId = missingDjRole(interaction, context, command.djName?.(interaction) ?? interaction.commandName);
      if (djRoleId) {
        await replyError(interaction, genel.djGerekli(djRoleId));
        return;
      }
      await command.execute(interaction, context);
    } catch (rawError) {
      const text = userMessageOf(rawError);
      if (text) {
        await replyError(interaction, text).catch(() => {});
        return;
      }
      logger.error(`/${interaction.commandName} komutunda hata:`, rawError);
      await replyError(interaction, genel.beklenmeyenHata).catch(() => {});
    }
  });
}
