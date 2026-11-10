// /dj rol kaldır: sunucunun DJ rolünü ayarlar, gösterir ya da kaldırır.
// Yalnızca "Sunucuyu Yönet" izni olanlar kullanabilir. DJ rolünün neleri kısıtladığı src/bot/dj.js içinde.
import { PermissionFlagsBits } from 'discord.js';
import { SettingsSaveError } from '../bot/serverSettings.js';
import { genel, komutlar } from '../mesajlar.js';
import { describe, guildCommand, replyError, replySuccess } from './_helpers.js';

const M = komutlar.dj;

export const data = guildCommand('dj')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addRoleOption((option) => describe(option, 'dj', 'rol'))
  .addBooleanOption((option) => describe(option, 'dj', 'kaldır'));

export async function execute(interaction, { settings }) {
  // The default permission above only hides the command; server admins can change that, so check here too.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await replyError(interaction, genel.yetkiYok);
    return;
  }
  const guildId = interaction.guildId;
  const current = settings.getDjRole(guildId);
  const role = interaction.options.getRole('rol');

  try {
    // Choosing the current role again removes it (as in the old bot).
    if (interaction.options.getBoolean('kaldır') || (role && role.id === current)) {
      settings.setDjRole(guildId, null);
      await replySuccess(interaction, M.kaldirildi);
    } else if (role) {
      settings.setDjRole(guildId, role.id);
      await replySuccess(interaction, M.ayarlandi(role.id));
    } else {
      await replySuccess(interaction, current ? M.simdikiRol(current) : M.rolYok);
    }
  } catch (error) {
    if (!(error instanceof SettingsSaveError)) throw error;
    await replyError(interaction, M.kaydedilemedi);
  }
}
