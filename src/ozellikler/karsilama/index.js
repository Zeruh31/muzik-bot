// "Karşılama" modülü (MEE6'nın hoş geldin ve otomatik rol işlevlerinin yerine): sunucuya katılana hoş geldin,
// ayrılana güle güle mesajı (isteğe bağlı görsel kartla) ve katılana otomatik rol (botlara ayrı rol).
// Ayarlar /ayar karsilama ... altında; kontrol merkezinde yöneticiler için önizleme düğmeleri var.
//
// Server Members Intent (GuildMembers) gerekir: Developer Portal'da kapalıysa bot çökmez, bu modül kapanır
// ve /ayar ile menü Türkçe açıklama gösterir (src/ozellikler/_intentler.js).
// Üyelik kuralları (Membership Screening) açık sunucularda katılan ve kuralları bekleyen kişi
// data/karsilama-bekleyen.json listesine yazılır (depo.js). Otomatik rol YALNIZ bu listedekilere verilir:
// kurallar kabul edilince (ham GUILD_MEMBER_UPDATE, pending:false) ya da bot açılırken (ClientReady) kişi artık
// beklemiyorsa; verilince listeden çıkar. Listede olmayana rol asla geri verilmez (bir moderatörün aldığı
// rol geri gelmez). Kurallar ekranı yoksa rol katılınca hemen verilir.
// Otomatik rol, onu /ayar ile ayarlayan kişinin yetkisine göre verilirken yeniden denetlenir (_roller.js).
// Ayrılma olayı ham gateway paketinden (GUILD_MEMBER_REMOVE) okunur: önbellekte olmayan üye için de çalışır.
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  TextDisplayBuilder,
} from 'discord.js';
import { escapeMarkdown } from '../../util/format.js';
import { cardRendererOf } from '../_kart.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, defineModule, ozId } from '../_ortak.js';
import { createSendGuard, isAccessError } from '../_gonderim.js';
import { changeRoles, createThrottledWarn } from '../_roller.js';
import { fillTemplate } from '../_sablon.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { createPendingStore } from './depo.js';
import * as mesajlar from './mesajlar.js';

const { kart: T, cevaplar: C, bolum: B } = mesajlar;
const MODUL = 'karsilama';
const AUTO_ROLES = ['otorol-1', 'otorol-2', 'otorol-3'];
const ROLE_REASON = 'Otomatik rol';
const SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const AVATAR_HASH = /^(a_)?[0-9a-f]{32}$/;
const SNOWFLAKE = /^\d{17,20}$/;

const ayar = (context, guildId, key) => context.ozellikler.ayarlar.get(guildId, MODUL, key);

const warners = new WeakMap();
function warnOf(context) {
  if (!warners.has(context)) warners.set(context, createThrottledWarn(context.logger));
  return warners.get(context);
}

/** Pauses sending to a channel the bot cannot write to (src/ozellikler/_gonderim.js), one per running bot. */
const guards = new WeakMap();
function guardOf(context) {
  if (!guards.has(context))
    guards.set(context, createSendGuard({ clock: context.ozellikler.saat, logger: context.logger }));
  return guards.get(context);
}

/** The avatar URL of a raw gateway user object (a member who left may not be cached). */
export function rawAvatarUrl(user) {
  if (!user || !SNOWFLAKE.test(String(user.id))) return null;
  if (AVATAR_HASH.test(user.avatar ?? ''))
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=256`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

/**
 * Who a message is about, in one shape for a GuildMember and for the raw user of a leave packet.
 * @returns {{ id: string, ad: string, kullaniciAdi: string, avatarUrl: string|null, bot: boolean }}
 */
function personOf(memberOrUser) {
  const user = memberOrUser?.user ?? memberOrUser;
  const options = { extension: 'png', size: 256, forceStatic: true };
  return {
    id: user.id,
    ad: memberOrUser?.displayName ?? user.globalName ?? user.global_name ?? user.username ?? '?',
    kullaniciAdi: user.username ?? '',
    avatarUrl: memberOrUser?.displayAvatarURL?.(options) ?? user.displayAvatarURL?.(options) ?? rawAvatarUrl(user),
    bot: Boolean(user.bot),
  };
}

/**
 * The welcome (tur 'hosgeldin') or goodbye ('gulegule') message for a person.
 * @returns {Promise<{ content: string, files: AttachmentBuilder[], allowedMentions: object }>}
 */
export async function buildMessage(
  context,
  guild,
  person,
  tur,
  { kart = ayar(context, guild.id, `${tur}-kart`) } = {},
) {
  const memberCount = Number(guild.memberCount) || 0;
  const template = ayar(context, guild.id, `${tur}-metni`) ?? mesajlar.varsayilanlar[tur];
  const content = fillTemplate(template, {
    kullanici: `<@${person.id}>`,
    ad: escapeMarkdown(person.ad),
    kullanici_adi: escapeMarkdown(person.kullaniciAdi),
    sunucu: escapeMarkdown(guild.name ?? ''),
    uye_sayisi: memberCount,
  });
  const files = [];
  if (kart) {
    try {
      const png = await cardRendererOf(context).karsilamaKarti({
        baslik: tur === 'hosgeldin' ? T.hosgeldinBaslik : T.gulegulebaslik,
        ad: person.ad,
        altMetin:
          tur === 'hosgeldin'
            ? T.hosgeldinAlt(memberCount, guild.name ?? '')
            : T.gulegulealt(memberCount, guild.name ?? ''),
        avatarUrl: person.avatarUrl,
        renk: ayar(context, guild.id, 'kart-renk'),
        arkaPlanUrl: ayar(context, guild.id, 'kart-gorsel'),
      });
      files.push(new AttachmentBuilder(png, { name: T.dosyaAdi }));
    } catch (error) {
      context.logger?.debug?.(`Karşılama kartı çizilemedi: ${error?.message ?? error}`);
    }
  }
  // Only the person may be pinged: a template or a server name with @everyone pings nobody.
  return { content, files, allowedMentions: { users: tur === 'hosgeldin' ? [person.id] : [] } };
}

/** Sends the welcome or goodbye message when its channel is set and the bot may post there. */
export async function sendGreeting(context, guild, person, tur) {
  const channelId = ayar(context, guild.id, `${tur}-kanal`);
  if (!channelId) return false;
  const channel = guild.channels?.cache?.get(channelId) ?? (await guild.channels?.fetch?.(channelId).catch(() => null));
  if (!channel?.send) return false;
  const me = guild.members?.me;
  const permissions = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
  if (permissions && !permissions.has(SEND)) {
    warnOf(context)(`${guild.id}:${tur}`, `Karşılama mesajı gönderilemiyor (sunucu ${guild.id}): kanalda izin yok.`);
    return false;
  }
  const canAttach = !permissions || permissions.has(PermissionFlagsBits.AttachFiles);
  const payload = await buildMessage(context, guild, person, tur, {
    kart: canAttach && ayar(context, guild.id, `${tur}-kart`),
  });
  // A channel that keeps refusing (403/404, 50001, 50013) is paused for a while with one warning.
  const result = await guardOf(context).gonder(
    `${MODUL}:${guild.id}:${tur}`,
    async () => {
      try {
        await channel.send(payload);
      } catch (error) {
        if (!isAccessError(error)) {
          warnOf(context)(
            `${guild.id}:${tur}:send`,
            `Karşılama mesajı gönderilemedi (sunucu ${guild.id}): ${error?.message ?? error}`,
          );
        }
        throw error;
      }
    },
    (hata, dakika) =>
      `Karşılama mesajı gönderilemedi (sunucu ${guild.id}, kanal ${channelId}): ${hata}. ${dakika} dakika denenmeyecek; kanal izinlerini kontrol edin.`,
  );
  return result === 'gonderildi';
}

/** The automatic roles a joining member gets (bots get only "bot-rol"). */
export function autoRolesOf(context, guildId, isBot) {
  const keys = isBot ? ['bot-rol'] : AUTO_ROLES;
  return [...new Set(keys.map((key) => ayar(context, guildId, key)).filter(Boolean))];
}

export async function giveAutoRoles(context, member) {
  const guildId = member.guild.id;
  const keys = member.user?.bot ? ['bot-rol'] : AUTO_ROLES;
  const roles = autoRolesOf(context, guildId, Boolean(member.user?.bot));
  if (!roles.length) return null;
  // Who set each role with /ayar: the role must still be below their highest role when it is given.
  const setters = new Map(
    keys.map((key) => [ayar(context, guildId, key), context.ozellikler.ayarlar.setBy(guildId, MODUL, key)]),
  );
  return changeRoles(member, {
    add: roles,
    reason: ROLE_REASON,
    warn: warnOf(context),
    setterOf: (roleId) => setters.get(roleId) ?? null,
  });
}

/** The list of people waiting for membership screening (data/karsilama-bekleyen.json). */
export function pendingOf(context) {
  const { ozellikler } = context;
  return ozellikler.depo('karsilama-bekleyen', (file) =>
    createPendingStore({ file, now: () => ozellikler.saat.now(), logger: context.logger }),
  );
}

async function memberOf(guild, userId) {
  return guild.members?.cache?.get(userId) ?? (await guild.members?.fetch?.(userId).catch(() => null)) ?? null;
}

/** Raw GUILD_MEMBER_UPDATE: someone on the waiting list passed screening, so they get the roles (once). */
export async function handleMemberUpdate(context, data) {
  const guild = context.client?.guilds?.cache?.get(data?.guild_id);
  const userId = data?.user?.id;
  if (!guild || !userId || data.pending !== false) return null;
  // Taking them off the list first: two packets in a row give the roles once.
  if (!pendingOf(context).al(guild.id, userId)) return null;
  await null; // let discord.js apply the packet first (the member is then cached and up to date)
  const member = await memberOf(guild, userId);
  return member ? giveAutoRoles(context, member) : null;
}

/**
 * On login: whoever on the list passed screening while the bot was off gets the roles; who left is dropped.
 * @returns {Promise<number>} how many got their roles
 */
export async function catchUpPending(context) {
  const store = pendingOf(context);
  let given = 0;
  for (const { guildId, userId } of store.hepsi()) {
    const guild = context.client?.guilds?.cache?.get(guildId);
    if (!guild) continue;
    const member = await memberOf(guild, userId);
    if (!member) {
      store.al(guildId, userId);
      continue;
    }
    if (member.pending) continue;
    if (store.al(guildId, userId)) {
      await giveAutoRoles(context, member);
      given += 1;
    }
  }
  return given;
}

/** GuildMemberAdd: automatic roles (now, or after membership screening) and the welcome message. */
export async function handleJoin(context, member) {
  const guild = member.guild;
  if (!guild) return;
  if (member.pending && !member.user?.bot) {
    if (autoRolesOf(context, guild.id, false).length) {
      pendingOf(context).ekle(guild.id, member.id, member.joinedTimestamp ?? context.ozellikler.saat.now());
    }
  } else await giveAutoRoles(context, member);
  await sendGreeting(context, guild, personOf(member), 'hosgeldin');
}

/** Raw GUILD_MEMBER_REMOVE: the goodbye message. */
export async function handleLeave(context, data) {
  // The gateway packet comes before discord.js updates the member count; let it do that first.
  await null;
  const guild = context.client?.guilds?.cache?.get(data?.guild_id);
  if (!guild || !data?.user || !SNOWFLAKE.test(String(data.user.id))) return false;
  if (data.user.id === context.client?.user?.id) return false;
  if (pendingOf(context).var(guild.id, data.user.id)) pendingOf(context).al(guild.id, data.user.id);
  return sendGreeting(context, guild, personOf(data.user), 'gulegule');
}

async function preview(interaction, context, tur) {
  if (!interaction.guildId || !interaction.guild) throw new OzellikHatasi(ortak.sunucudaKullan);
  if (!canManageGuild(interaction)) throw new OzellikHatasi(C.yetkiYok);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild } = interaction;
  const payload = await buildMessage(context, guild, personOf(interaction.member ?? interaction.user), tur, {
    kart: ayar(context, guild.id, `${tur}-kart`),
  });
  const notes = [C.onizlemeBasligi(tur)];
  if (!ayar(context, guild.id, `${tur}-kanal`)) notes.push(C.kanalYok(tur));
  const url = ayar(context, guild.id, 'kart-gorsel');
  if (url && ayar(context, guild.id, `${tur}-kart`) && !(await cardRendererOf(context).arkaPlanKullanilabilir(url)))
    notes.push(C.gorselUyari);
  await interaction.editReply({
    content: `${payload.content}\n${notes.join('\n')}`.slice(0, 2000),
    files: payload.files,
    allowedMentions: { parse: [] },
  });
}

export default defineModule({
  ad: MODUL,
  mesajlar,
  intentler: ['GuildMembers'],
  izinler: ['ManageRoles', 'AttachFiles'],
  ayarlar: {
    'hosgeldin-kanal': { tur: 'kanal', kanalTurleri: ['metin'] },
    'hosgeldin-metni': { tur: 'metin', enAz: 1, enFazla: 500, varsayilan: mesajlar.varsayilanlar.hosgeldin },
    'hosgeldin-kart': { tur: 'bayrak', varsayilan: true },
    'gulegule-kanal': { tur: 'kanal', kanalTurleri: ['metin'] },
    'gulegule-metni': { tur: 'metin', enAz: 1, enFazla: 500, varsayilan: mesajlar.varsayilanlar.gulegule },
    'gulegule-kart': { tur: 'bayrak', varsayilan: false },
    'kart-renk': { tur: 'metin', enAz: 7, enFazla: 7, varsayilan: '#2b2d31' },
    'kart-gorsel': { tur: 'metin', enAz: 12, enFazla: 500 },
    'otorol-1': { tur: 'rol', verilebilir: true },
    'otorol-2': { tur: 'rol', verilebilir: true },
    'otorol-3': { tur: 'rol', verilebilir: true },
    'bot-rol': { tur: 'rol', verilebilir: true },
  },
  menu: {
    sira: 85,
    gorunurluk: 'yonetici',
    ciz({ context, guildId }) {
      const roles = [
        ...autoRolesOf(context, guildId, false).map((id) => `<@&${id}>`),
        ...autoRolesOf(context, guildId, true).map((id) => `<@&${id}> (bot)`),
      ].join(', ');
      return [
        new TextDisplayBuilder().setContent(
          B.metin(ayar(context, guildId, 'hosgeldin-kanal'), ayar(context, guildId, 'gulegule-kanal'), roles),
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'onizle', 'hosgeldin'))
            .setEmoji('👋')
            .setLabel(B.hosgeldin)
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(ozId(MODUL, 'onizle', 'gulegule'))
            .setEmoji('🚪')
            .setLabel(B.gulegule)
            .setStyle(ButtonStyle.Secondary),
        ),
      ];
    },
  },
  bilesenler: {
    async onizle(interaction, context, [tur]) {
      if (tur !== 'hosgeldin' && tur !== 'gulegule') throw new OzellikHatasi(ortak.eskiDugme);
      await preview(interaction, context, tur);
    },
  },
  olaylar(context) {
    const { client } = context;
    if (typeof client?.on !== 'function') return undefined;
    const log = (what) => (error) =>
      context.logger?.warn?.(`Karşılama (${what}) işlenemedi: ${error?.message ?? error}`);
    const onJoin = (member) => handleJoin(context, member).catch(log('katılma'));
    // Raw packets: the leave and the screening update also work for members that are not cached.
    const onRaw = (packet) => {
      if (packet?.t === 'GUILD_MEMBER_REMOVE') handleLeave(context, packet.d).catch(log('ayrılma'));
      else if (packet?.t === 'GUILD_MEMBER_UPDATE') handleMemberUpdate(context, packet.d).catch(log('rol'));
    };
    const onReady = () => catchUpPending(context).catch(log('açılış'));
    client.on(Events.GuildMemberAdd, onJoin);
    client.on(Events.Raw, onRaw);
    client.on(Events.ClientReady, onReady);
    return () => {
      client.off(Events.GuildMemberAdd, onJoin);
      client.off(Events.Raw, onRaw);
      client.off(Events.ClientReady, onReady);
    };
  },
});
