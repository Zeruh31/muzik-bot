// "Ücretsiz oyunlar" modülü: Epic, Steam ve GOG'da kalıcı olarak ücretsiz alınabilen oyunları iki saatte bir
// kontrol eder ve /ayar ucretsiz-oyunlar kanal ile seçilen kanala kartla duyurur (görsel, son gün, mağaza
// bağlantısı; isteğe bağlı rol etiketi). Kontrol kalıcı zamanlayıcıyla yapılır ve her açılışta bir kez
// hemen çalışır: bot kapalıyken çıkan ama hâlâ geçerli olan oyunlar da duyurulur. Duyurulanlar
// data/ucretsiz-oyunlar.json'da tutulur; aynı oyun bir sunucuda iki kez duyurulmaz. Ağ hatasında sessizce
// geçilir; bir sonraki kontrolde yeniden denenir. Kaynaklar: kaynaklar.js.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  RESTJSONErrorCodes,
  TextDisplayBuilder,
} from 'discord.js';
import { escapeMarkdown, truncate } from '../../util/format.js';
import { canManageGuild, defineModule, ozId } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { createFreeGamesStore } from './depo.js';
import { oyunlariGetir, PLATFORMLAR } from './kaynaklar.js';
import * as mesajlar from './mesajlar.js';

const { platformlar: P, kart: T, bolum: B, cevaplar: C } = mesajlar;

export const MODUL = 'ucretsiz-oyunlar';
export const JOB_ID = 'ucretsiz-oyunlar.kontrol';
/** How often the sources are checked. */
export const ARALIK_MS = 2 * 60 * 60 * 1000;
/** At most this many cards per server and check (a newly set channel does not get a flood). */
export const EN_FAZLA_KART = 10;
const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
const NO_CHANNEL = new Set([
  RESTJSONErrorCodes.UnknownChannel,
  RESTJSONErrorCodes.MissingAccess,
  RESTJSONErrorCodes.MissingPermissions,
]);

export function storeOf(context) {
  return context.ozellikler.depo(MODUL, (file) =>
    createFreeGamesStore({ file, logger: context.logger?.child?.('ücretsiz oyun') }),
  );
}

/** The platforms a server wants (all three unless switched off). */
export function enabledPlatforms(ayarlar, guildId) {
  return PLATFORMLAR.filter((p) => ayarlar.get(guildId, MODUL, p) !== false);
}

/** The announcement card (Components V2). */
export function oyunKarti(offer, rolId = null) {
  const platform = P[offer.platform];
  const container = new ContainerBuilder().setAccentColor(platform.renk);
  if (rolId) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`<@&${rolId}>`));
  const lines = [
    T.baslik(escapeMarkdown(truncate(offer.baslik, 150))),
    T.platform(platform.emoji, platform.ad, offer.deger ? escapeMarkdown(offer.deger) : null),
    offer.bitis ? T.bitis(Math.floor(offer.bitis / 1000)) : T.bitisYok,
  ];
  if (offer.aciklama) lines.push('', escapeMarkdown(truncate(offer.aciklama, 300)));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  if (offer.gorsel) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems((item) =>
        item.setURL(offer.gorsel).setDescription(truncate(offer.baslik, 200)),
      ),
    );
  }
  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(T.kaynak(offer.kaynak)))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(offer.url).setLabel(T.magaza).setEmoji('🛒'),
      ),
    );
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], roles: rolId ? [rolId] : [] },
  };
}

/**
 * What a failed send means: 'kanal' (the bot cannot post there now), 'kart' (Discord refuses this card
 * itself, e.g. 50035 Invalid Form Body: sending it again never works) or 'gecici' (network, 429, 5xx).
 */
export function sendErrorKind(error) {
  if (NO_CHANNEL.has(error?.code)) return 'kanal';
  const status = Number(error?.status);
  if (
    error?.code === RESTJSONErrorCodes.InvalidFormBodyOrContentType ||
    (status >= 400 && status < 500 && status !== 429)
  )
    return 'kart';
  return 'gecici';
}

let current = null;

/**
 * One check: fetches the platforms any configured server wants and announces what each server has not
 * seen yet. Never throws for a source or a channel problem; those are skipped until the next check.
 * @param {object} context the bot context
 * @param {{ fetch?: Function, sleep?: Function, guildIds?: string[] }} [deps] for tests and the manual button
 * @returns {Promise<{ gonderilen: number, hatali: string[] }>}
 */
export function kontrolEt(context, deps = {}) {
  // A check that is already running is shared (the timer and the "Şimdi kontrol et" button).
  current ??= run(context, deps).finally(() => {
    current = null;
  });
  return current;
}

async function run(context, { guildIds, ...http }) {
  const { ozellikler, client } = context;
  const logger = context.logger?.child?.('ücretsiz oyun') ?? context.logger;
  const now = ozellikler.saat.now();
  const store = storeOf(context);
  if (store.saltOkunur) return { gonderilen: 0, hatali: [] };
  const servers = (guildIds ?? [...(client?.guilds?.cache?.keys?.() ?? [])])
    .map((guildId) => ({ guildId, kanalId: ozellikler.ayarlar.get(guildId, MODUL, 'kanal') }))
    .filter((s) => s.kanalId)
    .map((s) => ({
      ...s,
      rolId: ozellikler.ayarlar.get(s.guildId, MODUL, 'rol'),
      platforms: enabledPlatforms(ozellikler.ayarlar, s.guildId),
    }))
    .filter((s) => s.platforms.length);
  // Nobody wants announcements: no request goes out at all.
  if (!servers.length) return { gonderilen: 0, hatali: [] };

  const wanted = [...new Set(servers.flatMap((s) => s.platforms))];
  const results = await oyunlariGetir(wanted, { now, ...http });
  const hatali = wanted.filter((p) => !results[p]?.ok).map((p) => P[p].ad);
  if (hatali.length) logger?.debug?.(`Ücretsiz oyun kaynağına ulaşılamadı: ${hatali.join(', ')}`);

  let gonderilen = 0;
  for (const server of servers) {
    const okPlatforms = server.platforms.filter((p) => results[p]?.ok);
    for (const p of okPlatforms) store.unut(server.guildId, p, new Set(results[p].offers.map((o) => o.anahtar)), now);
    const fresh = okPlatforms
      .flatMap((p) => results[p].offers)
      .filter((o) => (o.bitis === null || o.bitis > now) && !store.duyuruldu(server.guildId, o.anahtar))
      .sort((a, b) => (a.bitis ?? Infinity) - (b.bitis ?? Infinity))
      .slice(0, EN_FAZLA_KART);
    if (!fresh.length) continue;
    let channel;
    try {
      channel = await client.channels.fetch(server.kanalId);
    } catch (error) {
      if (!NO_CHANNEL.has(error?.code)) logger?.debug?.('Duyuru kanalı alınamadı:', error?.message ?? error);
      continue;
    }
    if (!channel?.send) continue;
    for (const offer of fresh) {
      try {
        await channel.send(oyunKarti(offer, server.rolId));
      } catch (error) {
        const kind = sendErrorKind(error);
        logger?.warn?.(
          `Ücretsiz oyun duyurusu gönderilemedi (${server.guildId}, ${offer.anahtar}): ${error?.message ?? error}`,
        );
        if (kind === 'kanal') break; // no access to the channel: the rest waits for the next check
        // Discord refused this card for good: skip it from now on; a temporary error is tried next check.
        if (kind === 'kart') store.duyurulamadi(server.guildId, offer.anahtar, now);
        continue;
      }
      store.isaretle(server.guildId, offer.anahtar, now);
      gonderilen += 1;
    }
  }
  store.kontrolEdildi(now);
  if (gonderilen) logger?.info?.(`Ücretsiz oyun: ${gonderilen} duyuru gönderildi.`);
  return { gonderilen, hatali };
}

/** Plans the next check, or moves it to `zaman` when that is sooner. */
function planNext(zamanlayici, zaman, { sooner = false } = {}) {
  const existing = zamanlayici.bekleyenler().find((job) => job.id === JOB_ID && job.durum !== 'basarisiz');
  if (sooner && existing && existing.zaman <= zaman && existing.durum !== 'calisiyor') return;
  zamanlayici.planla({ id: JOB_ID, zaman, tur: 'ucretsiz-oyunlar.kontrol' });
}

let lastManual = 0;

export default defineModule({
  ad: MODUL,
  mesajlar,
  ayarlar: {
    kanal: { tur: 'kanal', kanalTurleri: ['metin'] },
    rol: { tur: 'rol' },
    epic: { tur: 'bayrak', varsayilan: true },
    steam: { tur: 'bayrak', varsayilan: true },
    gog: { tur: 'bayrak', varsayilan: true },
  },
  isler: {
    async kontrol(veri, context) {
      try {
        await kontrolEt(context);
      } catch (error) {
        // e.g. data/ucretsiz-oyunlar.json could not be written: try again with the next check
        context.logger?.warn?.(`Ücretsiz oyun kontrolü yapılamadı: ${error?.message ?? error}`);
      } finally {
        planNext(context.ozellikler.zamanlayici, context.ozellikler.saat.now() + ARALIK_MS);
      }
    },
  },
  olaylar(context) {
    // Every start checks once right away (the scheduler runs it on login), then every ARALIK_MS.
    const { zamanlayici, saat } = context.ozellikler;
    if (zamanlayici.saltOkunur) return undefined;
    try {
      planNext(zamanlayici, saat.now(), { sooner: true });
    } catch (error) {
      context.logger?.warn?.(`Ücretsiz oyun kontrolü planlanamadı: ${error?.message ?? error}`);
    }
    return undefined;
  },
  menu: {
    sira: 80,
    kategori: 'bildirimler',
    gorunurluk: 'yonetici',
    ciz({ context, guildId }) {
      const { ayarlar } = context.ozellikler;
      const last = storeOf(context).sonKontrol;
      const lines = [
        B.baslik,
        B.kanal(ayarlar.get(guildId, MODUL, 'kanal')),
        B.rol(ayarlar.get(guildId, MODUL, 'rol')),
        B.platformlar(
          enabledPlatforms(ayarlar, guildId)
            .map((p) => P[p].ad)
            .join(', '),
        ),
        B.sonKontrol(last ? Math.floor(last / 1000) : null),
        B.ipucu,
      ];
      return [
        new TextDisplayBuilder().setContent(lines.join('\n')),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'kontrol'))
            .setEmoji('🔎')
            .setLabel(B.kontrol)
            .setStyle(ButtonStyle.Secondary),
        ),
      ];
    },
  },
  bilesenler: {
    async kontrol(interaction, context) {
      if (!interaction.guildId || !canManageGuild(interaction)) throw new OzellikHatasi(C.yetkiYok);
      if (!context.ozellikler.ayarlar.get(interaction.guildId, MODUL, 'kanal')) throw new OzellikHatasi(C.kanalYok);
      const now = context.ozellikler.saat.now();
      if (now - lastManual < MANUAL_COOLDOWN_MS)
        throw new OzellikHatasi(C.bekle(Math.ceil((lastManual + MANUAL_COOLDOWN_MS) / 1000)));
      lastManual = now;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { gonderilen, hatali } = await kontrolEt(context, { guildIds: [interaction.guildId] });
      await interaction.editReply({ content: C.bitti(gonderilen, hatali), allowedMentions: { parse: [] } });
    },
  },
});
