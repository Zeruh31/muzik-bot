// /autoplay durum: kuyruk bitince son şarkıya benzer şarkılar eklemeyi açar ya da kapatır.
// Ayar sunucu başınadır ve data/sunucular.json dosyasında kalır (bot yeniden başlasa da).
import { SettingsSaveError } from '../bot/serverSettings.js';
import { komutlar } from '../mesajlar.js';
import { describe, guildCommand, replyError, replySuccess } from './_helpers.js';

const M = komutlar.autoplay;

/** Lives under /muzik (src/commands/muzik.js). */
export const ust = 'muzik';

export const data = guildCommand('autoplay').addBooleanOption((option) => describe(option, 'autoplay', 'durum'));

export async function execute(interaction, { music }) {
  const wanted = interaction.options.getBoolean('durum');
  const enabled = wanted ?? !music.isAutoplay(interaction.guildId);
  try {
    music.setAutoplay(interaction.guildId, enabled);
  } catch (error) {
    if (!(error instanceof SettingsSaveError)) throw error;
    await replyError(interaction, M.kaydedilemedi);
    return;
  }
  await replySuccess(interaction, enabled ? M.acildi : M.kapandi);
}
