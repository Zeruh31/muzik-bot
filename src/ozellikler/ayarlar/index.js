// "Ayarlar" modülü: /ayar komutu ve kontrol merkezinde yalnız yöneticilerin gördüğü "Ayarlar" bölümü.
import { TextDisplayBuilder } from 'discord.js';
import { defineModule } from '../_ortak.js';
import { createAyarCommand, settingsSummary } from './komut.js';
import * as mesajlar from './mesajlar.js';

const { cevaplar } = mesajlar;

export default defineModule({
  ad: 'ayarlar',
  mesajlar,
  komutlar: (modules) => [createAyarCommand(modules)],
  ayarListeleri: {
    'kalici-panel': {
      tur: 'ozel',
      aciklama: mesajlar.komut.panel,
      yalnizDiscord: '/ayar panel',
      oku: (context, guildId) => [cevaplar.panelSatiri(context.ozellikler.panel?.kanalOf(guildId) ?? null)],
    },
  },
  menu: {
    sira: 90,
    gorunurluk: 'yonetici',
    ciz({ context, guildId, guild }) {
      const { ozellikler } = context;
      const lines = [cevaplar.panelSatiri(ozellikler.panel?.kanalOf(guildId) ?? null), ''];
      for (const { title, lines: rows } of settingsSummary(guildId, ozellikler, { guild }))
        lines.push(`**${title}**`, ...rows, '');
      lines.push(`-# ${cevaplar.menuIpucu}`);
      return [new TextDisplayBuilder().setContent(lines.join('\n').slice(0, 3000))];
    },
  },
});
