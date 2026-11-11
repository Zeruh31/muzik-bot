// "Yardım" modülü: /help mesajındaki kategori menüsünü (oz:yardim:kategori) karşılar. /help komutu
// src/commands/help.js'te kalır; kalıcı customId sayesinde bot yeniden başlasa da menü çalışır.
import { renderHelp } from '../../commands/help.js';
import { defineModule } from '../_ortak.js';
import * as mesajlar from './mesajlar.js';

export default defineModule({
  ad: 'yardim',
  mesajlar,
  bilesenler: {
    async kategori(interaction, context) {
      await interaction.update(renderHelp(context, interaction.values?.[0]));
    },
  },
});
