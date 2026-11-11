// The log channel (kayit): the in-memory message cache keeps at most 500 messages per channel for 24 hours
// and never touches the disk, the bot's own messages and the log channel are never logged (no loops),
// deleted messages show their content (or "unknown"), edits show before and after, and without the
// privileged intents the bot keeps running with only the types that need them switched off.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { Events, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { createMessageCache, ICERIK_EN_FAZLA } from '../src/ozellikler/kayit/onbellek.js';
import { cacheOf, isActive, logPaused } from '../src/ozellikler/kayit/index.js';
import { BOT, flush, makeLiveContext, newId, perms } from './yardimci/discordSahte.js';
import { removeTempDirs } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const HOUR = 3_600_000;

function fakeMessage(channel, { author, content = 'merhaba', attachments = [], partial = false, id = newId() } = {}) {
  return {
    id,
    channelId: channel.id,
    guildId: channel.guild.id,
    guild: channel.guild,
    author,
    content,
    partial,
    createdTimestamp: Date.now(),
    editedTimestamp: null,
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    url: `https://discord.com/channels/${channel.guild.id}/${channel.id}/${id}`,
  };
}

async function setup(options = {}) {
  const context = await makeLiveContext(options);
  const { guild } = context;
  const log = guild.addText('kayit');
  const general = guild.addText('genel');
  context.ozellikler.ayarlar.set(guild.id, 'kayit', 'kanal', log.id);
  const user = guild.addMember({ name: 'Ali' });
  const emit = async (event, ...args) => {
    context.client.emit(event, ...args);
    await flush();
  };
  return { context, guild, log, general, user, emit };
}

const descriptionOf = (payload) => payload.embeds[0].toJSON().description;
const titleOf = (payload) => payload.embeds[0].toJSON().title;

describe('message cache limits', () => {
  it('keeps the last 500 messages of a channel, none older than 24 hours, and a total cap', () => {
    let now = 0;
    const cache = createMessageCache({ now: () => now, toplam: 700 });
    const add = (channelId, n) =>
      cache.ekle({ id: `m${channelId}-${n}`, channelId, author: { id: 'a' }, content: `${n}` });
    for (let n = 0; n < 510; n += 1) add('c1', n);
    assert.equal(cache.boyut, 500);
    assert.equal(cache.al('c1', 'mc1-9'), null, 'the oldest ten went');
    assert.equal(cache.al('c1', 'mc1-10').icerik, '10');
    now = 1000;
    for (let n = 0; n < 300; n += 1) add('c2', n);
    assert.equal(cache.boyut, 700, 'total cap: the oldest messages of any channel go first');
    assert.equal(cache.al('c1', 'mc1-109'), null);
    assert.ok(cache.al('c2', 'mc2-0'));
    now = 24 * HOUR + 1;
    assert.equal(cache.al('c1', 'mc1-300'), null, 'older than 24 hours');
    assert.ok(cache.al('c2', 'mc2-0'));
    now = 24 * HOUR + 1001;
    assert.equal(cache.boyut, 0);
  });

  it('stores attachments only as name and size, cuts long texts, and an edit does not extend the 24 hours', () => {
    let now = 0;
    const cache = createMessageCache({ now: () => now });
    const attachments = new Map([
      ['1', { name: 'foto.png', size: 2048, url: 'https://cdn.example/foto.png', proxyURL: 'x' }],
    ]);
    const entry = cache.ekle({ id: '1', channelId: 'c', author: { id: 'a' }, content: 'x'.repeat(5000), attachments });
    assert.deepEqual(entry.ekler, [{ ad: 'foto.png', boyut: 2048 }]);
    assert.equal(entry.icerik.length, ICERIK_EN_FAZLA);
    assert.ok(!JSON.stringify(entry).includes('cdn.example'));
    now = 23 * HOUR;
    cache.ekle({ id: '1', channelId: 'c', author: { id: 'a' }, content: 'yeni' });
    now = 24 * HOUR + 1;
    assert.equal(cache.al('c', '1'), null);
  });
});

describe('log channel: messages', () => {
  it('a deleted message is logged with its content and attachments; mentions never ping', async () => {
    const { context, log, general, user, emit } = await setup();
    const message = fakeMessage(general, {
      author: user.user,
      content: '@everyone bedava oyun',
      attachments: [{ name: 'a.zip', size: 3 * 1024 * 1024 }],
    });
    await emit(Events.MessageCreate, message);
    assert.ok(cacheOf(context).al(general.id, message.id));
    await emit(Events.MessageDelete, { ...message, partial: true, author: null, content: null });
    const card = log.sent.at(-1);
    assert.match(titleOf(card), /Mesaj silindi/);
    assert.match(descriptionOf(card), /@everyone bedava oyun/);
    assert.match(descriptionOf(card), /a\.zip/);
    assert.match(descriptionOf(card), /3\.0 MB/);
    assert.deepEqual(card.allowedMentions, { parse: [] });
    assert.equal(cacheOf(context).al(general.id, message.id), null, 'removed from the cache');
  });

  it('a deleted message the bot never saw says "içerik bilinmiyor"', async () => {
    const { log, general, emit } = await setup();
    await emit(Events.MessageDelete, { ...fakeMessage(general, { author: null, content: null }), partial: true });
    assert.match(descriptionOf(log.sent.at(-1)), /İçerik bilinmiyor/);
  });

  it('an edit shows before and after; a link preview update (same text) is not logged', async () => {
    const { log, general, user, emit } = await setup();
    const message = fakeMessage(general, { author: user.user, content: 'saat 9da' });
    await emit(Events.MessageCreate, message);
    const edited = { ...message, content: 'saat 10da', editedTimestamp: Date.now() };
    await emit(Events.MessageUpdate, message, edited);
    const card = log.sent.at(-1);
    assert.match(titleOf(card), /düzenlendi/);
    assert.match(descriptionOf(card), /saat 9da[\s\S]*saat 10da/);
    const count = log.sent.length;
    await emit(Events.MessageUpdate, edited, { ...edited });
    assert.equal(log.sent.length, count);
  });

  it('never logs nor caches the bot itself, other bots, or the log channel (no loops)', async () => {
    const { context, guild, log, general, emit } = await setup();
    const ownMessage = fakeMessage(general, { author: { id: BOT, bot: true } });
    const otherBot = fakeMessage(general, { author: { id: newId(), bot: true } });
    const inLog = fakeMessage(log, { author: guild.addMember({ name: 'Mod' }).user });
    for (const m of [ownMessage, otherBot, inLog]) await emit(Events.MessageCreate, m);
    assert.equal(cacheOf(context).boyut, 0);
    for (const m of [ownMessage, otherBot, inLog]) await emit(Events.MessageDelete, m);
    await emit(Events.MessageUpdate, inLog, { ...inLog, content: 'x', editedTimestamp: 1 });
    assert.equal(log.sent.length, 0);
  });

  it('nothing is cached while no log channel is set, and nothing is written to data/', async () => {
    const { context, guild, general, user, emit } = await setup();
    context.ozellikler.ayarlar.set(guild.id, 'kayit', 'kanal', null);
    await emit(Events.MessageCreate, fakeMessage(general, { author: user.user }));
    assert.equal(cacheOf(context).boyut, 0);
    assert.ok(
      readdirSync(context.dir).every((f) => !/kayit|mesaj/.test(f)),
      readdirSync(context.dir).join(','),
    );
  });
});

describe('log channel: members, voice, bans and switches', () => {
  it('members joining and leaving, roles and nicknames, voice moves and bans give cards', async () => {
    const { guild, log, user, emit } = await setup();
    await emit(Events.GuildMemberAdd, user);
    assert.match(titleOf(log.sent.at(-1)), /katıldı/);
    const role = guild.addRole({ name: 'PUBG' });
    const before = { ...user, roles: { cache: new Map() }, nickname: null };
    const afterRoles = { ...user, roles: { cache: new Map([[role.id, role]]) }, nickname: 'Ali47' };
    await emit(Events.GuildMemberUpdate, before, afterRoles);
    const titles = log.sent.slice(-2).map(titleOf);
    assert.deepEqual(titles, ['🎭 Roller değişti', '🏷️ Takma ad değişti']);
    const voice = guild.addVoice('Oyun');
    await guild.move(user.id, voice.id);
    assert.match(titleOf(log.sent.at(-1)), /girdi/);
    await emit(Events.GuildBanAdd, { guild, user: user.user });
    assert.match(titleOf(log.sent.at(-1)), /Yasaklandı/);
    await emit(Events.GuildMemberRemove, user);
    assert.match(titleOf(log.sent.at(-1)), /ayrıldı/);
  });

  it('a type switched off with /ayar kayit turler is not written', async () => {
    const { context, guild, log, user, emit } = await setup();
    context.ozellikler.ayarlar.set(guild.id, 'kayit', 'uyeler', false);
    await emit(Events.GuildMemberAdd, user);
    assert.equal(log.sent.length, 0);
  });

  it('without the privileged intents the bot does not crash: member and message types are off, voice still works', async () => {
    for (const allowPrivileged of [false, 'zorunlu']) {
      const { context, guild, log, general, user, emit } = await setup({ allowPrivileged });
      assert.equal(context.ozellikler.disabledReason('kayit'), null, 'the module itself stays on');
      assert.ok(!context.ozellikler.intentPlan.names.includes('MessageContent'));
      // 'zorunlu' keeps Server Members (karşılama cannot work without it): then member types still work.
      const members = context.ozellikler.intentPlan.names.includes('GuildMembers');
      assert.equal(members, allowPrivileged === 'zorunlu');
      assert.equal(isActive(context, guild.id, 'uyeler'), members);
      assert.equal(isActive(context, guild.id, 'silinen'), false);
      await emit(Events.GuildMemberAdd, user);
      assert.equal(log.sent.length, members ? 1 : 0);
      const message = fakeMessage(general, { author: user.user });
      await emit(Events.MessageCreate, message);
      await emit(Events.MessageDelete, message);
      assert.equal(cacheOf(context).boyut, 0);
      assert.equal(log.sent.length, members ? 1 : 0, 'no message cards without Message Content');
      await guild.move(user.id, guild.addVoice('Ses').id);
      assert.match(titleOf(log.sent.at(-1)), /girdi/);
    }
  });

  it('a log channel that cannot be written to does not throw', async () => {
    const { log, user, emit } = await setup();
    log.fail = new Error('Missing Permissions');
    await emit(Events.GuildMemberAdd, user);
    assert.equal(log.sent.length, 0);
  });
});

describe('optional privileged intents at login', () => {
  it('first drops only the optional ones (kayit), then all; the module stays on', async () => {
    const { planIntents, startWithIntentFallback } = await import('../src/ozellikler/_intentler.js');
    const kayit = {
      ad: 'kayit',
      intentler: ['GuildMessages'],
      istegeBagliIntentler: ['GuildMembers', 'MessageContent'],
    };
    const karsilama = { ad: 'karsilama', intentler: ['GuildMembers'] };
    const tried = [];
    const errors = [];
    const result = await startWithIntentFallback({
      start: async ({ allowPrivileged }) => ({ plan: planIntents([kayit, karsilama], { allowPrivileged }) }),
      // The portal has Server Members on, Message Content off.
      login: async ({ plan }) => {
        tried.push(plan.privileged.join(',') || 'yok');
        if (plan.privileged.includes('MessageContent')) throw new Error('Used disallowed intents');
      },
      stop: async () => {},
      planOf: (started) => started.plan,
      logger: { error: (text) => errors.push(text) },
    });
    assert.deepEqual(tried, ['GuildMembers,MessageContent', 'GuildMembers']);
    assert.deepEqual([...result.plan.disabled.keys()], []);
    assert.match(errors[0], /MessageContent/);
    assert.deepEqual(planIntents([kayit], { allowPrivileged: false }).names.sort(), [
      'GuildMessages',
      'GuildVoiceStates',
      'Guilds',
    ]);
  });
});

describe('log channel: access errors and private channels', () => {
  it('after a 403 sending pauses (5 minutes, then longer) with one warning, and resumes when it works', async () => {
    const warnings = [];
    const { context, guild, log, user, emit, clock } = await (async () => {
      const ctx = await setup();
      ctx.context.logger = { ...ctx.context.logger, warn: (text) => warnings.push(text), debug() {} };
      return { ...ctx, clock: ctx.context.clock };
    })();
    let tries = 0;
    const send = log.send;
    log.send = async (payload) => {
      tries += 1;
      if (log.blocked)
        throw Object.assign(new Error('Missing Permissions'), {
          code: RESTJSONErrorCodes.MissingPermissions,
          status: 403,
        });
      return send(payload);
    };
    log.blocked = true;
    await emit(Events.GuildMemberAdd, user);
    for (let i = 0; i < 20; i += 1) await emit(Events.GuildMemberAdd, user);
    assert.equal(tries, 1, 'no more tries while paused');
    assert.equal(warnings.filter((w) => /Kayıt kanalına/.test(w)).length, 1);
    assert.ok(logPaused(context, guild.id));
    const { buildMenu } = await import('../src/ozellikler/menu/merkez.js');
    const admin = { guildId: guild.id, guild, userId: '1', canManageGuild: true, isDj: true };
    const menu = JSON.stringify(
      buildMenu(context, admin, { bolum: 'ayarlar' }).payload.components.map((c) => c.toJSON()),
    );
    assert.match(menu, /Kayıt kanalına yazılamıyor/);
    await clock.advance(5 * 60_000);
    await emit(Events.GuildMemberAdd, user); // still blocked: the next pause is 10 minutes
    assert.equal(tries, 2);
    await clock.advance(5 * 60_000);
    await emit(Events.GuildMemberAdd, user);
    assert.equal(tries, 2);
    await clock.advance(5 * 60_000);
    log.blocked = false;
    await emit(Events.GuildMemberAdd, user);
    assert.equal(tries, 3);
    assert.equal(logPaused(context, guild.id), null);
    assert.equal(log.sent.length, 1);
  });

  it('/ayar kayit haric: messages of an excluded channel are never cached nor logged', async () => {
    const { context, guild, log, general, user, emit } = await setup();
    context.ozellikler.ayarlar.set(guild.id, 'kayit', 'haric-1', general.id);
    const message = fakeMessage(general, { author: user.user });
    await emit(Events.MessageCreate, message);
    assert.equal(cacheOf(context).boyut, 0);
    await emit(Events.MessageDelete, message);
    assert.equal(log.sent.length, 0);
  });

  it("a private channel's content is not shown when @everyone can read the log channel", async () => {
    const { context, guild, log, user, emit } = await setup();
    const secret = guild.addText('yonetim');
    secret.permissionsFor = (who) => (String(who?.id ?? who) === guild.id ? perms([]) : perms('hepsi'));
    const message = fakeMessage(secret, { author: user.user, content: 'gizli plan' });
    await emit(Events.MessageCreate, message);
    assert.equal(cacheOf(context).boyut, 0, 'not even cached');
    await emit(Events.MessageDelete, message);
    assert.match(descriptionOf(log.sent.at(-1)), /İçerik gösterilmiyor/);
    assert.ok(!descriptionOf(log.sent.at(-1)).includes('gizli plan'));
    // When the log channel itself is private too, the content is shown.
    log.permissionsFor = secret.permissionsFor;
    const second = fakeMessage(secret, { author: user.user, content: 'ikinci' });
    await emit(Events.MessageCreate, second);
    await emit(Events.MessageDelete, second);
    assert.match(descriptionOf(log.sent.at(-1)), /ikinci/);
    assert.ok(PermissionFlagsBits.ViewChannel);
  });
});
