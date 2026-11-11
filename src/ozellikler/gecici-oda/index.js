// "Geçici odalar" modülü: "/ayar gecici-oda kanal" ile seçilen "➕ Oda aç" ses kanalına giren kişiye
// "{kullanıcı} odası" adlı kendi ses odası açılır ve kişi oraya taşınır. Odanın sohbetine düğmeli bir kontrol
// mesajı gider: ad, kişi sınırı, kilit, birini atma ve sahipliği devretme (yalnız sahip ya da "Sunucuyu Yönet").
// Sahip ayrılınca sahiplik odadaki birine geçer; oda boşalınca 10 saniye sonra silinir. Bot yeniden
// başlayınca boş kalmış eski odalar silinir.
// GÜVENLİK: bot yalnız kendi açtığı ve data/gecici-odalar.json'a yazdığı kanalları düzenler ve siler; silmeden
// önce kanal kimliğinin ve sunucusunun kayıtla aynı olduğu yeniden denetlenir. Kişi başına tek oda vardır ve
// yeni oda açmak için bekleme süresi uygulanır ("/ayar gecici-oda bekleme").
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { humansInVoice } from '../../bot/dj.js';
import { ortak } from '../_mesajlar.js';
import { canManageGuild, defineModule, ozId } from '../_ortak.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { validateValue } from '../ayarlar/sema.js';
import { createRoomStore } from './depo.js';
import * as mesajlar from './mesajlar.js';

const { kontrol: T, form: F, cevaplar: C, bolum: B, konsol: L } = mesajlar;

export const MODUL = 'gecici-oda';
/** An empty room is deleted this long after the last person left. */
export const BOS_SILME_MS = 10_000;
/** Discord allows two name changes per channel in ten minutes. */
export const AD_DEGISTIRME_SINIRI = 2;
export const AD_DEGISTIRME_PENCERESI_MS = 10 * 60_000;
const NAME_MAX = 100;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const SNOWFLAKE = /^\d{17,20}$/;
const GONE = new Set([RESTJSONErrorCodes.UnknownChannel]);
const DISCORD_EPOCH = 1_420_070_400_000n;
/** A room's channel id must have been made this close to the recorded opening time. */
export const OLUSMA_TOLERANSI_MS = 10 * 60_000;
/** The owner can never kick these (moderators and bots). */
const UNKICKABLE = [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.MoveMembers];

const fail = (text) => {
  throw new OzellikHatasi(text);
};

/** The room store of a running bot (data/gecici-odalar.json). */
export function storeOf(context) {
  return context.ozellikler.depo(MODUL, (file) =>
    createRoomStore({ file, logger: context.logger?.child?.('geçici oda') }),
  );
}

/** Timers, cool-downs and rename history; in memory, one set per running bot. */
const states = new WeakMap();
function stateOf(context) {
  if (!states.has(context)) {
    states.set(context, { timers: new Map(), cooldown: new Map(), renames: new Map(), opening: new Set() });
  }
  return states.get(context);
}

const setting = (context, guildId, key) => context.ozellikler.ayarlar.get(guildId, MODUL, key);
const clockOf = (context) => context.ozellikler.saat;

/** "{nickname} odası", without control characters and within Discord's 100 characters. */
export function roomName(displayName) {
  const clean =
    String(displayName ?? '')
      .replace(CONTROL_CHARS, '')
      .trim() || '?';
  const name = mesajlar.odaAdi(clean);
  return name.length <= NAME_MAX ? name : mesajlar.odaAdi(clean.slice(0, NAME_MAX - (name.length - clean.length)));
}

/** The control message of a room (Components V2). */
export function renderControls(room, channel) {
  const lines = [T.baslik, T.sahip(room.sahipId), T.sinir(channel?.userLimit ?? 0), T.kilit(room.kilitli)];
  const container = new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(ozId(MODUL, 'ad', room.id))
          .setEmoji('✏️')
          .setLabel(T.ad)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(ozId(MODUL, 'limit', room.id))
          .setEmoji('👥')
          .setLabel(T.limit)
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(ozId(MODUL, 'kilit', room.id))
          .setEmoji(room.kilitli ? '🔓' : '🔒')
          .setLabel(room.kilitli ? T.ac : T.kilitle)
          .setStyle(room.kilitli ? ButtonStyle.Success : ButtonStyle.Danger),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(ozId(MODUL, 'at', room.id)).setPlaceholder(T.at),
      ),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(ozId(MODUL, 'devret', room.id)).setPlaceholder(T.devret),
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(T.ipucu));
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

const channelOf = (guild, id) => guild?.channels?.cache?.get(id) ?? null;
const guildOf = (context, guildId) => context.client?.guilds?.cache?.get(guildId) ?? null;

function cancelDelete(context, channelId) {
  const { timers } = stateOf(context);
  const timer = timers.get(channelId);
  if (timer !== undefined) clockOf(context).clearTimeout(timer);
  timers.delete(channelId);
}

function scheduleDelete(context, channelId) {
  cancelDelete(context, channelId);
  const timer = clockOf(context).setTimeout(() => {
    stateOf(context).timers.delete(channelId);
    deleteIfEmpty(context, channelId).catch((error) =>
      context.logger?.warn?.(L.silinemedi(channelId, error?.message ?? error)),
    );
  }, BOS_SILME_MS);
  stateOf(context).timers.set(channelId, timer);
}

/** When a channel id was made, from the snowflake itself (ms). */
export const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

/**
 * Whether a channel is really the room of a record: same id and guild, a voice channel, in the category
 * it was opened in, and created when the record says. Anything else is never edited nor deleted.
 */
export function isOwnRoom(room, channel) {
  if (!room || !channel || channel.id !== room.id) return false;
  if ((channel.guildId ?? channel.guild?.id) !== room.guildId) return false;
  if (channel.type !== ChannelType.GuildVoice) return false;
  if ((channel.parentId ?? null) !== (room.kategoriId ?? null)) return false;
  return Math.abs(snowflakeTime(room.id) - room.olusma) <= OLUSMA_TOLERANSI_MS;
}

/**
 * Deletes a room when nobody is in it. Only a channel the store knows, of the same guild, is ever touched.
 * A record that does not match its channel (isOwnRoom) is dropped and the channel is left alone.
 * @returns {Promise<boolean>} whether the room is gone now
 */
export async function deleteIfEmpty(context, channelId) {
  const store = storeOf(context);
  const room = store.get(channelId);
  if (!room) return false; // never a channel the bot did not open
  const guild = guildOf(context, room.guildId);
  if (!guild) return false; // the guild is unavailable right now: try again on the next start
  const channel = channelOf(guild, room.id);
  if (!channel) {
    store.remove(room.id);
    return true;
  }
  if (humansInVoice(guild, room.id).length) return false;
  if (!isOwnRoom(room, channel)) {
    cancelDelete(context, room.id);
    store.remove(room.id);
    context.logger?.warn?.(L.kayitUymuyor(room.id));
    return false;
  }
  try {
    await channel.delete(mesajlar.baslik);
  } catch (error) {
    if (!GONE.has(error?.code)) throw error;
  }
  cancelDelete(context, room.id);
  store.remove(room.id);
  return true;
}

/** Updates the control message of a room (when it can be found). */
async function refreshControls(context, room, channel) {
  if (!room.kontrolMesajId || !channel?.messages?.fetch) return;
  const message = await channel.messages.fetch(room.kontrolMesajId).catch(() => null);
  await message?.edit(renderControls(room, channel)).catch(() => {});
}

/** Hands a room to someone still in it (the owner left). */
async function handOver(context, guild, room, newOwnerId) {
  const updated = storeOf(context).update(room.id, (r) => (r.sahipId = newOwnerId));
  const channel = channelOf(guild, room.id);
  await refreshControls(context, updated, channel);
  await channel
    ?.send?.({ content: C.sahipAyrildi(newOwnerId), allowedMentions: { users: [newOwnerId] } })
    .catch(() => {});
  return updated;
}

/** Whether a room is being opened right now (tests wait for it). */
export const isOpening = (context) => stateOf(context).opening.size > 0;

/** Opens at most one room per person at a time, also when "bekleme" is 0 and they join twice quickly. */
async function openRoom(context, guild, member, voiceState) {
  const userId = voiceState.id ?? member?.id;
  const { opening } = stateOf(context);
  const key = `${guild.id}:${userId}`;
  if (opening.has(key)) return;
  opening.add(key);
  try {
    await openRoomOnce(context, guild, member, voiceState, userId);
  } finally {
    opening.delete(key);
  }
}

async function openRoomOnce(context, guild, member, voiceState, userId) {
  const store = storeOf(context);
  const own = store.ofOwner(guild.id, userId);
  if (own) {
    const channel = channelOf(guild, own.id);
    if (channel) {
      await voiceState.setChannel(channel).catch(() => {});
      return;
    }
    store.remove(own.id); // deleted by hand while the bot was off
  }
  const { cooldown } = stateOf(context);
  const now = clockOf(context).now();
  const waitMs = setting(context, guild.id, 'bekleme') * 1000;
  for (const [key, at] of cooldown) if (now - at >= waitMs) cooldown.delete(key);
  const key = `${guild.id}:${userId}`;
  if (cooldown.has(key)) {
    const left = Math.ceil((waitMs - (now - cooldown.get(key))) / 1000);
    const hub = channelOf(guild, voiceState.channelId);
    await hub?.send?.({ content: C.bekle(userId, left), allowedMentions: { users: [userId] } }).catch(() => {});
    return;
  }
  cooldown.set(key, now);
  const hub = channelOf(guild, voiceState.channelId);
  const parent = setting(context, guild.id, 'kategori') ?? hub?.parentId ?? null;
  const limit = setting(context, guild.id, 'limit');
  let channel;
  try {
    channel = await guild.channels.create({
      name: roomName(member?.displayName ?? member?.user?.username),
      type: ChannelType.GuildVoice,
      ...(parent ? { parent } : {}),
      ...(limit ? { userLimit: limit } : {}),
      reason: mesajlar.baslik,
    });
  } catch (error) {
    context.logger?.warn?.(L.acilamadi(error?.message ?? error));
    return;
  }
  let room;
  try {
    room = store.add({
      id: channel.id,
      guildId: guild.id,
      sahipId: userId,
      olusma: now,
      kategoriId: channel.parentId ?? null,
      kilitli: false,
    });
  } catch (error) {
    // Not recorded means it could never be cleaned up later: remove the channel made a moment ago.
    await channel.delete(mesajlar.baslik).catch(() => {});
    context.logger?.warn?.(L.acilamadi(error?.message ?? error));
    return;
  }
  await voiceState.setChannel(channel).catch(() => {});
  if (!humansInVoice(guild, channel.id).length) scheduleDelete(context, channel.id);
  const message = await channel.send?.(renderControls(room, channel)).catch(() => null);
  if (message?.id) {
    try {
      store.update(room.id, (r) => (r.kontrolMesajId = message.id));
    } catch {
      // the controls still work; only the message is not refreshed later
    }
  }
}

async function afterLeave(context, guild, channelId, leaverId) {
  const room = storeOf(context).get(channelId);
  if (!room) return;
  const humans = humansInVoice(guild, channelId);
  if (!humans.length) {
    scheduleDelete(context, channelId);
    return;
  }
  if (room.sahipId === leaverId) await handOver(context, guild, room, humans[0]);
}

/** The voiceStateUpdate listener (exported for tests). */
export async function onVoiceStateUpdate(context, oldState, newState) {
  const guild = newState?.guild ?? oldState?.guild;
  if (!guild || oldState?.channelId === newState?.channelId) return;
  const member = newState.member ?? oldState?.member ?? null;
  if (member?.user?.bot) return;
  const store = storeOf(context);
  if (newState.channelId) {
    if (store.get(newState.channelId)) cancelDelete(context, newState.channelId);
    const hubId = setting(context, guild.id, 'kanal');
    if (hubId && newState.channelId === hubId) await openRoom(context, guild, member, newState);
  }
  if (oldState?.channelId) await afterLeave(context, guild, oldState.channelId, oldState.id ?? newState.id);
}

/**
 * On login: rooms that emptied while the bot was off are deleted, records of rooms deleted by hand are
 * dropped, and a room whose owner is gone gets a new owner.
 * @returns {Promise<number>} how many rooms were deleted
 */
export async function sweep(context) {
  const store = storeOf(context);
  let deleted = 0;
  for (const room of store.all()) {
    const guild = guildOf(context, room.guildId);
    if (!guild) continue;
    try {
      if (!channelOf(guild, room.id)) {
        store.remove(room.id); // deleted by hand while the bot was off
        continue;
      }
      if (!isOwnRoom(room, channelOf(guild, room.id))) {
        store.remove(room.id); // not the room it was: forget the record, never touch the channel
        context.logger?.warn?.(L.kayitUymuyor(room.id));
        continue;
      }
      const humans = humansInVoice(guild, room.id);
      if (!humans.length) {
        if (await deleteIfEmpty(context, room.id)) deleted += 1;
      } else if (!humans.includes(room.sahipId)) await handOver(context, guild, room, humans[0]);
    } catch (error) {
      context.logger?.warn?.(L.silinemedi(room.id, error?.message ?? error));
    }
  }
  if (deleted) context.logger?.info?.(L.temizlendi(deleted));
  return deleted;
}

/** The room of a control and the right to use it: its owner, or "Sunucuyu Yönet". */
function controlledRoom(interaction, context, args) {
  if (!interaction.guildId || !interaction.guild) fail(ortak.sunucudaKullan);
  const id = args[0] ?? '';
  const room = SNOWFLAKE.test(id) ? storeOf(context).get(id) : null;
  const channel = room && room.guildId === interaction.guildId ? channelOf(interaction.guild, room.id) : null;
  if (!room || !channel || !isOwnRoom(room, channel)) fail(C.odaYok);
  if (room.sahipId !== interaction.user.id && !canManageGuild(interaction)) fail(C.sahipDegil);
  return { room, channel };
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/** Turns Discord's "Missing Permissions" into the Turkish explanation. */
async function act(work) {
  try {
    return await work();
  } catch (error) {
    if (error?.code === RESTJSONErrorCodes.MissingPermissions || error?.code === RESTJSONErrorCodes.MissingAccess)
      fail(C.izinYok);
    throw error;
  }
}

function textModal(eylem, id, title, label, { value, max }) {
  return new ModalBuilder()
    .setCustomId(ozId(MODUL, eylem, id))
    .setTitle(title)
    .addLabelComponents((l) =>
      l.setLabel(label).setTextInputComponent((input) => {
        input.setCustomId('deger').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max);
        if (value) input.setValue(String(value).slice(0, max));
        return input;
      }),
    );
}

/**
 * Who was picked in a user select menu, checked against the owner and bots. For a kick the member is
 * fetched from Discord when not cached (their permissions must be known) and moderators are refused.
 */
async function pickedUser(interaction, room, { kick = false } = {}) {
  const userId = interaction.values?.[0] ?? '';
  if (!SNOWFLAKE.test(userId)) fail(ortak.eskiDugme);
  if (userId === room.sahipId || userId === interaction.user.id) fail(C.kendini);
  const { guild } = interaction;
  let member = guild?.members?.cache?.get(userId) ?? null;
  if (!member && kick) member = await guild?.members?.fetch?.(userId).catch(() => null);
  if (kick && !member) fail(C.uyeBulunamadi);
  const user = interaction.users?.get?.(userId) ?? member?.user;
  if (user?.bot || userId === guild?.members?.me?.id) fail(C.botOlmaz);
  if (kick && UNKICKABLE.some((flag) => member.permissions?.has?.(flag))) fail(C.yoneticiAtilamaz);
  return userId;
}

const allowsConnect = (overwrite) =>
  (BigInt(overwrite?.allow?.bitfield ?? 0n) & PermissionFlagsBits.Connect) === PermissionFlagsBits.Connect;
const savedOf = (overwrite) => ({
  tip: overwrite.type,
  allow: String(overwrite.allow?.bitfield ?? 0n),
  deny: String(overwrite.deny?.bitfield ?? 0n),
});

/** A stored overwrite as discord.js options ({ Connect: true, Speak: false, ... }). */
function optionsOf(saved) {
  const allow = BigInt(saved.allow);
  const deny = BigInt(saved.deny);
  const options = {};
  for (const [name, bit] of Object.entries(PermissionFlagsBits)) {
    if ((allow & bit) === bit) options[name] = true;
    else if ((deny & bit) === bit) options[name] = false;
  }
  return options;
}

/**
 * What a lock changes: the bot, the owner and the people inside may connect; @everyone and every other role
 * or member overwrite that lets someone connect (also one the room got from its category) may not.
 * @returns {Map<string, { type: number, options: object }>}
 */
export function lockChanges(guild, room, channel) {
  const overwrites = channel.permissionOverwrites?.cache ?? new Map();
  const changes = new Map();
  const botId = guild.members?.me?.id;
  if (botId) changes.set(botId, { type: OverwriteType.Member, options: { ViewChannel: true, Connect: true } });
  for (const id of new Set([room.sahipId, ...humansInVoice(guild, room.id)]))
    changes.set(id, { type: OverwriteType.Member, options: { Connect: true } });
  changes.set(guild.id, { type: OverwriteType.Role, options: { Connect: false } });
  for (const overwrite of overwrites.values()) {
    if (!changes.has(overwrite.id) && allowsConnect(overwrite))
      changes.set(overwrite.id, { type: overwrite.type, options: { Connect: false } });
  }
  return changes;
}

/** Locks a room; what it changes is saved first, so unlocking puts exactly that back. */
async function lockRoom(context, guild, room, channel) {
  const changes = lockChanges(guild, room, channel);
  const overwrites = channel.permissionOverwrites?.cache ?? new Map();
  const before = {};
  for (const id of changes.keys()) before[id] = overwrites.has(id) ? savedOf(overwrites.get(id)) : null;
  const updated = storeOf(context).update(room.id, (r) => {
    r.kilitli = true;
    r.kilitOncesi = before;
  });
  for (const [id, { type, options }] of changes) await channel.permissionOverwrites.edit(id, options, { type });
  return updated;
}

/** Restoring these is skipped: the role, member, user or overwrite is gone (e.g. a role deleted while locked). */
const GONE_TARGETS = new Set([
  RESTJSONErrorCodes.UnknownRole, // 10011
  RESTJSONErrorCodes.UnknownMember, // 10007
  RESTJSONErrorCodes.UnknownUser, // 10013
  10009, // Unknown Overwrite
]);

/**
 * Unlocks a room: only the overwrites the lock changed are put back as they were (or removed), each on its
 * own, so one that is gone does not keep the room locked. Other errors stop the unlock (it can be retried).
 */
async function unlockRoom(context, room, channel) {
  for (const [id, saved] of Object.entries(room.kilitOncesi ?? {})) {
    try {
      if (saved) await channel.permissionOverwrites.create(id, optionsOf(saved), { type: saved.tip });
      else await channel.permissionOverwrites.delete(id);
    } catch (error) {
      if (!GONE_TARGETS.has(error?.code)) throw error;
    }
  }
  return storeOf(context).update(room.id, (r) => {
    r.kilitli = false;
    r.kilitOncesi = {};
  });
}

/** Adds a time to a room's rename history; refuses when Discord would make the rename wait. */
function allowRename(context, roomId) {
  const { renames } = stateOf(context);
  const now = clockOf(context).now();
  const recent = (renames.get(roomId) ?? []).filter((at) => now - at < AD_DEGISTIRME_PENCERESI_MS);
  if (recent.length >= AD_DEGISTIRME_SINIRI) {
    fail(C.adSiniri(Math.ceil((AD_DEGISTIRME_PENCERESI_MS - (now - recent[0])) / 60_000)));
  }
  renames.set(roomId, [...recent, now]);
}

export default defineModule({
  ad: MODUL,
  mesajlar,
  // Rooms are created, renamed and deleted (ManageChannels); people are moved and disconnected (MoveMembers);
  // locking and kicking set the room's permission overwrites, which Discord ties to ManageRoles.
  izinler: ['ManageChannels', 'MoveMembers', 'ManageRoles'],
  ayarlar: {
    kanal: { tur: 'kanal', kanalTurleri: ['ses'] },
    kategori: { tur: 'kanal', kanalTurleri: ['kategori'] },
    limit: { tur: 'sayi', enAz: 0, enFazla: 99, varsayilan: 0 },
    bekleme: { tur: 'sayi', enAz: 0, enFazla: 600, varsayilan: 30 },
  },
  olaylar(context) {
    const { client } = context;
    if (!client?.on) return undefined;
    const onVoice = (oldState, newState) =>
      onVoiceStateUpdate(context, oldState, newState).catch((error) =>
        context.logger?.warn?.(`Geçici oda: ${error?.message ?? error}`),
      );
    const onDelete = (channel) => {
      if (!channel?.id || !storeOf(context).get(channel.id)) return;
      cancelDelete(context, channel.id);
      try {
        storeOf(context).remove(channel.id);
      } catch {
        // the next start drops the record (the channel no longer exists)
      }
    };
    const onReady = () => sweep(context).catch(() => {});
    client.on(Events.VoiceStateUpdate, onVoice);
    client.on(Events.ChannelDelete, onDelete);
    client.once(Events.ClientReady, onReady);
    return () => {
      client.off?.(Events.VoiceStateUpdate, onVoice);
      client.off?.(Events.ChannelDelete, onDelete);
      client.off?.(Events.ClientReady, onReady);
      const state = states.get(context);
      for (const timer of state?.timers.values() ?? []) clockOf(context).clearTimeout(timer);
      state?.timers.clear();
    };
  },
  menu: {
    sira: 91,
    kategori: 'ayarlar',
    gorunurluk: 'yonetici',
    gorunur: ({ yer }) => yer !== 'panel',
    ciz: ({ context, guildId }) => [
      new TextDisplayBuilder().setContent(
        B.metin(
          setting(context, guildId, 'kanal'),
          setting(context, guildId, 'kategori'),
          storeOf(context)
            .all()
            .filter((r) => r.guildId === guildId).length,
        ),
      ),
      new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(ozId(MODUL, 'merkez-kanal'))
          .setPlaceholder(B.kanalSec)
          .addChannelTypes(ChannelType.GuildVoice),
      ),
    ],
  },
  bilesenler: {
    async ad(interaction, context, args) {
      const { room, channel } = controlledRoom(interaction, context, args);
      await interaction.showModal(textModal('ad-kaydet', room.id, F.adBaslik, F.ad, { value: channel.name, max: 100 }));
    },

    async 'ad-kaydet'(interaction, context, args) {
      const { room, channel } = controlledRoom(interaction, context, args);
      const name = String(interaction.fields.getTextInputValue('deger') ?? '').trim();
      if (!name || name.length > NAME_MAX || /[\u0000-\u001F\u007F]/.test(name)) fail(C.adGecersiz);
      allowRename(context, room.id);
      await act(() => channel.setName(name, mesajlar.baslik));
      await interaction.reply(ephemeral(C.adDegisti(name)));
    },

    async limit(interaction, context, args) {
      const { room, channel } = controlledRoom(interaction, context, args);
      await interaction.showModal(
        textModal('limit-kaydet', room.id, F.limitBaslik, F.limit, { value: channel.userLimit ?? 0, max: 2 }),
      );
    },

    async 'limit-kaydet'(interaction, context, args) {
      const { room, channel } = controlledRoom(interaction, context, args);
      const text = String(interaction.fields.getTextInputValue('deger') ?? '').trim();
      const limit = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(limit) || limit < 0 || limit > 99) fail(C.limitGecersiz);
      await act(() => channel.setUserLimit(limit, mesajlar.baslik));
      await refreshControls(context, room, channel);
      await interaction.reply(ephemeral(C.limitDegisti(limit)));
    },

    async kilit(interaction, context, args) {
      const { room, channel } = controlledRoom(interaction, context, args);
      const locking = !room.kilitli;
      const updated = await act(() =>
        locking ? lockRoom(context, interaction.guild, room, channel) : unlockRoom(context, room, channel),
      );
      await interaction.update(renderControls(updated, channel));
      await interaction.followUp(ephemeral(locking ? C.kilitlendi : C.kilitAcildi));
    },

    async at(interaction, context, args) {
      const { room, channel } = controlledRoom(interaction, context, args);
      const userId = await pickedUser(interaction, room, { kick: true });
      const state = interaction.guild.voiceStates?.cache?.get(userId);
      await act(async () => {
        await channel.permissionOverwrites.edit(userId, { Connect: false }, { type: OverwriteType.Member });
        if (state?.channelId === room.id) await state.disconnect(mesajlar.baslik);
      });
      // A kicked member stays barred when the room is unlocked later.
      const updated = room.kilitli
        ? storeOf(context).update(room.id, (r) => {
            r.kilitOncesi = { ...r.kilitOncesi };
            delete r.kilitOncesi[userId];
          })
        : room;
      await interaction.update(renderControls(updated, channel));
      await interaction.followUp(ephemeral(C.atildi(userId)));
    },

    async devret(interaction, context, args) {
      const { room, channel } = controlledRoom(interaction, context, args);
      const userId = await pickedUser(interaction, room);
      if (!humansInVoice(interaction.guild, room.id).includes(userId)) fail(C.odadaDegil(userId));
      const updated = storeOf(context).update(room.id, (r) => (r.sahipId = userId));
      await interaction.update(renderControls(updated, channel));
      await interaction.followUp({ content: C.devredildi(userId), allowedMentions: { users: [userId] } });
    },

    /** Picking the "Oda aç" channel in the control center (Ayarlar). */
    async 'merkez-kanal'(interaction, context) {
      if (!interaction.guildId) fail(ortak.sunucudaKullan);
      if (!canManageGuild(interaction)) fail(C.yoneticiGerekli);
      const channel = interaction.channels?.first?.() ?? null;
      const id = validateValue({ tur: 'kanal', kanalTurleri: ['ses'] }, channel, { guild: interaction.guild });
      context.ozellikler.ayarlar.set(interaction.guildId, MODUL, 'kanal', id);
      await interaction.update(context.ozellikler.menu.payloadFor(interaction, 'ayarlar'));
      await interaction.followUp(ephemeral(C.merkezKaydedildi(id)));
    },
  },
});
