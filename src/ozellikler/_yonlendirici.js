// Kalıcı bileşen yönlendiricisi: customId'si "oz:<modül>:<eylem>[:arg...]" olan her düğme, seçme menüsü
// ve modal (form) bu dosyadan ilgili modülün işleyicisine gider. Bot yeniden başlasa da eski mesajlardaki
// düğmeler çalışır, çünkü hiçbir şey bellekte bekletilmez. Müzik düğmelerinin "muzikbot-kontrol:" öneki
// src/bot/controls.js'te kalır. Normalde bu dosyaya dokunmana gerek yok.

import { MessageFlags } from 'discord.js';
import { genel } from '../mesajlar.js';
import { MusicError, translateLavalinkError } from '../music/errors.js';
import { errorEmbed } from '../util/embeds.js';
import { ortak } from './_mesajlar.js';
import { own, parseOzId } from './_ortak.js';

/** An error whose message is meant for the user as-is (Turkish), e.g. a refused setting. */
export class OzellikHatasi extends Error {
  constructor(message) {
    super(message);
    this.name = 'OzellikHatasi';
  }
}

/** Short ephemeral error, whether or not the interaction was already answered. */
export function warnEphemeral(interaction, text) {
  const payload = { embeds: [errorEmbed(text)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

/** The Turkish text for an error thrown by a command or component handler, or null if unexpected. */
export function userMessageOf(rawError) {
  const error = translateLavalinkError(rawError);
  if (error instanceof MusicError || error instanceof OzellikHatasi) return error.message;
  return null;
}

/**
 * @param {Map<string, object>} modules module name -> definition
 * @param {{ disabledReason?: (name: string) => string|null, logger?: object }} options
 *   disabledReason gives the Turkish "feature is off" text for a module whose intents are missing
 */
export function createRouter(modules, { disabledReason = () => null, logger } = {}) {
  return {
    /**
     * Handles a component or modal interaction with an "oz:" customId.
     * @returns {Promise<boolean>} false when the customId is not one of ours (left to other handlers)
     */
    async handle(interaction, context) {
      const parsed = parseOzId(interaction.customId);
      if (!parsed) return false;
      const module = modules.get(parsed.modul);
      const handler = own(module?.bilesenler, parsed.eylem);
      if (!handler) {
        await warnEphemeral(interaction, ortak.eskiDugme).catch(() => {});
        return true;
      }
      const off = disabledReason(parsed.modul);
      if (off) {
        await warnEphemeral(interaction, off).catch(() => {});
        return true;
      }
      try {
        await handler(interaction, context, parsed.args);
      } catch (rawError) {
        const text = userMessageOf(rawError);
        if (!text) logger?.error(`Bileşen hatası (${interaction.customId}):`, rawError);
        await warnEphemeral(interaction, text ?? genel.beklenmeyenHata).catch(() => {});
      }
      return true;
    },
  };
}
