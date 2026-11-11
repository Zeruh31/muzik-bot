// "Sesli komut" modülü: bot ses kanalındayken "<uyandırma sözü>, tarkan dudu dudu aç" ya da "..., müziği durdur"
// gibi Türkçe komutları dinler. Ses bu bilgisayarda (stt/stt_worker.py, faster-whisper) işlenir, kaydedilmez,
// dışarı gönderilmez. Varsayılan KAPALI: yönetici "/ayar sesli-komut acik" ile açar; açık sunucuda bot kanala
// girince bunu kanala yazar. Herkes "/muzik sesli-komut beni-dinleme" ile kendini hariç tutabilir.
// Parçalar: niyet.js (metin → komut), kapilar.js (doğrulama), komutlar.js (Türkçe komut tablosu), dinleyici.js
// (kişi başına ses alma), isci.js (işçi süreci), yonetici.js (hepsini bağlar), kurulum.js (bileşenin yeri).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, TextDisplayBuilder } from 'discord.js';
import { ortak } from '../_mesajlar.js';
import { defineModule, ozId } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { createExclusionStore } from './depo.js';
import * as mesajlar from './mesajlar.js';
import { createSesliKomut, MODUL } from './yonetici.js';

const { bolum: B, cevaplar: C, isciDurumu: D } = mesajlar;

/** The exclusion list of the running bot (data/sesli-komut.json), created on first use. */
export function exclusionsOf(context) {
  return context.ozellikler.depo(MODUL, (file) =>
    createExclusionStore({ file, logger: context.logger?.child?.('sesli-komut') ?? context.logger }),
  );
}

/**
 * Sets whether a person's voice is excluded in a guild; returns false when it already was so.
 * Their audio stream is closed (or opened) at once.
 */
export function setExcluded(context, guildId, userId, excluded) {
  const changed = exclusionsOf(context).set(guildId, userId, excluded);
  if (changed) context.sesliKomut?.exclusionChanged(guildId, userId, excluded);
  return changed;
}

/** The status lines of /muzik sesli-komut durum. */
export function statusText(context, guildId, userId) {
  const get = (key) => context.ozellikler.ayarlar.get(guildId, MODUL, key);
  const state = context.sesliKomut?.durum() ?? { kurulu: false, isci: 'kapali' };
  const isci = state.isci === 'hazir' ? D.hazir(state.cihaz, state.model) : (D[state.isci] ?? state.isci);
  return C.durum({
    acik: get('acik') === true,
    soz: get('uyandirma') ?? mesajlar.varsayilanUyandirma,
    kurulu: state.kurulu,
    isci,
    haric: exclusionsOf(context).has(guildId, userId),
  });
}

export default defineModule({
  ad: MODUL,
  mesajlar,
  ayarlar: {
    acik: { tur: 'bayrak', varsayilan: false },
    uyandirma: { tur: 'metin', enAz: 3, enFazla: 40, varsayilan: mesajlar.varsayilanUyandirma },
  },
  ayarDegisti(context, guildId, anahtar) {
    context.sesliKomut
      ?.ayarDegisti(guildId, anahtar)
      .catch((error) => context.logger?.error('Sesli komut ayarı uygulanamadı:', error?.message ?? error));
  },
  olaylar(context) {
    const logger = context.logger?.child?.('sesli-komut') ?? context.logger;
    const manager = createSesliKomut({ context, exclusions: exclusionsOf(context), logger });
    context.sesliKomut = manager;
    return () => {
      manager.kapat().catch(() => {});
      if (context.sesliKomut === manager) context.sesliKomut = null;
    };
  },
  menu: {
    sira: 15,
    gorunurluk: 'herkes',
    // Only where the feature is on (members need the button then); off, admins find it under /ayar.
    gorunur: ({ context, guildId }) =>
      Boolean(guildId) && context.ozellikler.ayarlar.get(guildId, MODUL, 'acik') === true,
    ciz({ context, guildId, viewer }) {
      const get = (key) => context.ozellikler.ayarlar.get(guildId, MODUL, key);
      const acik = get('acik') === true;
      const haric = viewer.userId ? exclusionsOf(context).has(guildId, viewer.userId) : false;
      const components = [
        new TextDisplayBuilder().setContent(
          B.metin({ acik, soz: get('uyandirma') ?? mesajlar.varsayilanUyandirma, haric }),
        ),
      ];
      if (acik) {
        // On the fixed panel nobody in particular looks: the button toggles it for whoever presses it.
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'haric', haric ? 'hayir' : 'evet'))
            .setEmoji(haric ? '🎙️' : '🔇')
            .setLabel(haric ? B.benidinle : B.benidinleme)
            .setStyle(ButtonStyle.Secondary),
        );
        components.push(row);
      }
      return components;
    },
  },
  bilesenler: {
    async haric(interaction, context, [secim]) {
      if (!interaction.guildId) throw new OzellikHatasi(ortak.sunucudaKullan);
      if (secim !== 'evet' && secim !== 'hayir') throw new OzellikHatasi(ortak.eskiDugme);
      const excluded = secim === 'evet';
      const changed = setExcluded(context, interaction.guildId, interaction.user.id, excluded);
      const text = excluded ? (changed ? C.haricTutuldu : C.zatenHaric) : changed ? C.dinleniyor : C.zatenDinleniyor;
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    },
  },
});
