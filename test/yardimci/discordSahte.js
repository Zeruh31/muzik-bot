// Fakes for the modules that listen to Discord events (geçici odalar, roller, kayıt): a client that is an
// EventEmitter, a guild with channels, roles, members and voice states, and a bot context wired to a
// temporary data/ folder. Only what those modules touch is faked.

import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { ChannelType, Events, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { planIntents } from '../../src/ozellikler/_intentler.js';
import { createOzellikler, loadModules } from '../../src/ozellikler/index.js';
import { fakeClock, silent, tempDir } from './ozellikBaglami.js';

export const GUILD = '100000000000000001';
export const BOT = '100000000000000002';
export const OWNER = '100000000000000003';

let nextId = 200000000000000000n;
export const newId = () => String(nextId++);
let sequence = 0n;
/** A snowflake made at `ms` (like Discord: time since 2015 in the high bits). */
export const snowflakeAt = (ms) => String(((BigInt(ms) - 1_420_070_400_000n) << 22n) | (sequence++ & 4095n));

/** One permission overwrite as discord.js keeps it ({ id, type, allow: { bitfield }, deny: { bitfield } }). */
export function fakeOverwrite(id, type, { allow = [], deny = [] } = {}) {
  const bits = (list) => list.reduce((all, flag) => all | flag, 0n);
  return { id, type, allow: { bitfield: bits(allow) }, deny: { bitfield: bits(deny) } };
}

/** Applies discord.js-style options ({ Connect: true|false|null }) to an overwrite. */
function applyOptions(overwrite, options) {
  for (const [name, value] of Object.entries(options)) {
    const bit = PermissionFlagsBits[name];
    overwrite.allow.bitfield &= ~bit;
    overwrite.deny.bitfield &= ~bit;
    if (value === true) overwrite.allow.bitfield |= bit;
    if (value === false) overwrite.deny.bitfield |= bit;
  }
  return overwrite;
}

/** Lets async listeners (and the listeners they trigger) finish. */
export async function flush(times = 40) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Waits (a bounded number of event loop turns) until `check()` is true. */
export async function until(check, turns = 2000) {
  for (let i = 0; i < turns && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  return check();
}

/** A set of permission names as discord.js PermissionsBitField-like `has`. */
export const perms = (allowed = []) => ({
  has: (flag) => (Array.isArray(flag) ? flag : [flag]).every((f) => allowed.includes(f) || allowed === 'hepsi'),
});

function fakeTextLike(guild, { id = newId(), type, name, parentId = null }) {
  const messages = new Map();
  const channel = {
    id,
    type,
    name,
    parentId,
    guildId: guild.id,
    guild,
    userLimit: 0,
    sent: [],
    edits: [],
    deleted: false,
    overwrites: [],
    async send(payload) {
      if (channel.fail) throw channel.fail;
      const message = {
        id: newId(),
        payload,
        channelId: id,
        edit: async (p) => {
          channel.edits.push({ id: message.id, p });
          message.payload = p;
          return message;
        },
        delete: async () => messages.delete(message.id),
      };
      messages.set(message.id, message);
      channel.sent.push(payload);
      return message;
    },
    messages: {
      async fetch(messageId) {
        const message = messages.get(messageId);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: RESTJSONErrorCodes.UnknownMessage });
        return message;
      },
    },
    permissionsFor: () => perms('hepsi'),
    async setName(value) {
      channel.name = value;
      return channel;
    },
    async setUserLimit(value) {
      channel.userLimit = value;
      return channel;
    },
    permissionOverwrites: {
      cache: new Map(),
      async edit(target, options, { type = 1 } = {}) {
        const key = String(target?.id ?? target);
        channel.overwrites.push({ target: key, options });
        const cache = channel.permissionOverwrites.cache;
        const current = cache.get(key) ?? fakeOverwrite(key, type);
        cache.set(key, applyOptions(current, options));
      },
      async create(target, options, { type = 1 } = {}) {
        const key = String(target?.id ?? target);
        channel.permissionOverwrites.cache.set(key, applyOptions(fakeOverwrite(key, type), options));
      },
      async delete(target) {
        channel.permissionOverwrites.cache.delete(String(target?.id ?? target));
      },
    },
    async delete() {
      channel.deleted = true;
      guild.channels.cache.delete(id);
      guild.client.emit(Events.ChannelDelete, channel);
      return channel;
    },
  };
  return channel;
}

/**
 * A guild with a bot member. `client` is the EventEmitter the modules listen on.
 * @returns the guild; helpers: addText, addVoice, addCategory, addRole, addMember, move
 */
export function fakeGuild(client, { id = GUILD, botTop = 50 } = {}) {
  const guild = {
    id,
    ownerId: OWNER,
    client,
    channels: { cache: new Map() },
    voiceStates: { cache: new Map() },
    roles: { cache: new Map() },
    members: { cache: new Map(), me: null },
    now: () => Date.now(),
  };
  guild.roles.everyone = { id };
  guild.roles.cache.set(id, { id, name: '@everyone', position: 0, permissions: perms([]) });
  guild.members.me = {
    id: BOT,
    user: { id: BOT, bot: true },
    permissions: perms('hepsi'),
    roles: { highest: { id: newId(), position: botTop } },
  };
  guild.channels.create = async ({ name, type, parent = null, userLimit = 0 }) => {
    if (guild.createFail) throw guild.createFail;
    const channel = fakeTextLike(guild, { id: snowflakeAt(guild.now()), type, name, parentId: parent });
    channel.userLimit = userLimit;
    guild.channels.cache.set(channel.id, channel);
    return channel;
  };
  guild.addText = (name = 'genel') => {
    const channel = fakeTextLike(guild, { type: ChannelType.GuildText, name });
    guild.channels.cache.set(channel.id, channel);
    return channel;
  };
  guild.addVoice = (name = 'ses', parentId = null) => {
    const channel = fakeTextLike(guild, { type: ChannelType.GuildVoice, name, parentId });
    guild.channels.cache.set(channel.id, channel);
    return channel;
  };
  guild.addCategory = (name = 'Oyun') => {
    const channel = fakeTextLike(guild, { type: ChannelType.GuildCategory, name });
    guild.channels.cache.set(channel.id, channel);
    return channel;
  };
  guild.addRole = ({ name = 'rol', position = 10, permissions = [], managed = false, mentionable = true } = {}) => {
    const role = { id: newId(), name, position, permissions: perms(permissions), managed, mentionable };
    guild.roles.cache.set(role.id, role);
    return role;
  };
  guild.addMember = ({ userId = newId(), name = 'Kişi', bot = false, top = 1 } = {}) => {
    const roleIds = new Set();
    const member = {
      id: userId,
      displayName: name,
      nickname: null,
      guild,
      user: { id: userId, bot, username: name, tag: name, createdTimestamp: Date.parse('2020-01-01') },
      roles: {
        cache: { keys: () => roleIds.values(), has: (r) => roleIds.has(r) },
        highest: { position: top },
        async add(ids) {
          for (const r of [ids].flat()) roleIds.add(r);
        },
        async remove(ids) {
          for (const r of [ids].flat()) roleIds.delete(r);
        },
      },
      roleIds,
    };
    guild.members.cache.set(userId, member);
    return member;
  };
  /** Moves a member to a voice channel (null = leaves) and emits voiceStateUpdate like discord.js. */
  guild.move = async (userId, channelId) => {
    const member = guild.members.cache.get(userId);
    const old = guild.voiceStates.cache.get(userId) ?? voiceState(guild, member, null);
    const oldCopy = { ...old };
    const next = voiceState(guild, member, channelId);
    if (channelId) guild.voiceStates.cache.set(userId, next);
    else guild.voiceStates.cache.delete(userId);
    client.emit(Events.VoiceStateUpdate, oldCopy, next);
    await flush();
  };
  return guild;
}

function voiceState(guild, member, channelId) {
  return {
    id: member.id,
    guild,
    member,
    channelId,
    async setChannel(channel) {
      await guild.move(member.id, channel?.id ?? channel ?? null);
    },
    async disconnect() {
      await guild.move(member.id, null);
    },
  };
}

/**
 * A bot context with every bundled module, listening on a fake client. Reuse `dir` to simulate a restart.
 * @param {{ allowPrivileged?: boolean|'zorunlu' }} options false: Discord refused the privileged intents
 */
export async function makeLiveContext({ dir = tempDir(), clock = fakeClock(), allowPrivileged = true, guild } = {}) {
  const client = new EventEmitter();
  client.user = { id: BOT };
  const theGuild = guild ?? fakeGuild(client);
  theGuild.client = client;
  theGuild.now = () => clock.now();
  client.guilds = { cache: new Map([[theGuild.id, theGuild]]) };
  client.channels = {
    async fetch(channelId) {
      const channel = theGuild.channels.cache.get(channelId);
      if (!channel) throw Object.assign(new Error('Unknown Channel'), { code: RESTJSONErrorCodes.UnknownChannel });
      return channel;
    },
  };
  const context = {
    client,
    music: Object.assign(new EventEmitter(), { getState: () => null }),
    settings: { getDjRole: () => null },
    playlists: { list: () => [] },
    logger: silent,
  };
  const modules = await loadModules();
  createOzellikler({
    context,
    modules,
    intentPlan: planIntents(modules, { allowPrivileged }),
    files: {
      ayarlar: join(dir, 'ozellikler.json'),
      zamanlayici: join(dir, 'zamanlayici.json'),
      paneller: join(dir, 'paneller.json'),
    },
    clock,
    logger: silent,
  });
  Object.assign(context, { dir, clock, guild: theGuild });
  return context;
}

/** A component or modal interaction as the router gets it. */
export function fakeInteraction(context, { customId, userId, values = [], manage = false, fields = {} } = {}) {
  const guild = context.guild;
  const calls = { updates: [], followUps: [], replies: [], modals: [], edits: [] };
  return {
    calls,
    customId,
    guildId: guild.id,
    guild,
    channelId: null,
    user: { id: userId },
    member: guild.members.cache.get(userId) ?? null,
    memberPermissions: perms(manage ? 'hepsi' : []),
    values,
    users: { get: (id) => guild.members.cache.get(id)?.user },
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    deferred: false,
    replied: false,
    async update(payload) {
      this.replied = true;
      calls.updates.push(payload);
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      calls.edits.push(payload);
    },
    async followUp(payload) {
      calls.followUps.push(payload);
    },
    async reply(payload) {
      this.replied = true;
      calls.replies.push(payload);
      return { resource: { message: { id: newId() } } };
    },
    async showModal(modal) {
      calls.modals.push(modal);
    },
  };
}

/** The Turkish error text a refused interaction got. */
export const errorOf = (interaction) =>
  [...interaction.calls.replies, ...interaction.calls.followUps]
    .map((p) => p.embeds?.[0]?.toJSON?.().description)
    .find(Boolean) ?? '';
