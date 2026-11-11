// "Kontrol merkezi" modülü: /menu (yalnız yazana görünen menü), sağ tık > Uygulamalar > "Bot menüsünü aç"
// ve kalıcı panelin ayarı. Bölümler diğer modüllerin `menu` kayıtlarından gelir (src/ozellikler/menu/merkez.js).
import { ApplicationCommandType, ContextMenuCommandBuilder, InteractionContextType } from 'discord.js';
import { ortak } from '../_mesajlar.js';
import { defineModule, ozCommand } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { buildMenu, viewerOf } from './merkez.js';
import * as mesajlar from './mesajlar.js';

const K = mesajlar.komutlar;

function requireGuild(interaction) {
  if (!interaction.guildId) throw new OzellikHatasi(ortak.sunucudaKullan);
}

/** Opens the menu as a new ephemeral reply. */
async function openMenu(interaction, context, { hedefId = null } = {}) {
  requireGuild(interaction);
  const { payload } = buildMenu(context, viewerOf(interaction, context), { hedefId });
  await interaction.reply(payload);
}

export default defineModule({
  ad: 'menu',
  mesajlar,
  komutlar: [
    {
      data: ozCommand('menu', K.menu),
      kategori: 'genel',
      execute: (interaction, context) => openMenu(interaction, context),
    },
    {
      // Right click on a member > Apps. "Seviyesini göster" and "Takıma ekle" will come with their features.
      data: new ContextMenuCommandBuilder()
        .setName(K.kullaniciMenusu)
        .setType(ApplicationCommandType.User)
        .setContexts(InteractionContextType.Guild),
      kategori: 'genel',
      execute: (interaction, context) =>
        openMenu(interaction, context, {
          hedefId:
            interaction.targetUser && interaction.targetUser.id !== interaction.user.id
              ? interaction.targetUser.id
              : null,
        }),
    },
  ],
  // The fixed panel fetches its stored message again after a restart.
  izinler: ['ReadMessageHistory'],
  ayarlar: {
    'panel-aralik': { tur: 'sayi', enAz: 3, enFazla: 60, varsayilan: 5 },
  },
  bilesenler: {
    /** The section picker of an open menu. Visibility is checked again: the choice comes from Discord. */
    async bolum(interaction, context) {
      requireGuild(interaction);
      await interaction.update(context.ozellikler.menu.payloadFor(interaction, interaction.values?.[0]));
    },

    /** "Menüyü aç" on the fixed panel. */
    ac: (interaction, context) => openMenu(interaction, context),
  },
});
