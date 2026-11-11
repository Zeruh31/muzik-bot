// Levels and XP (seviye): the MEE6 formula, the message cooldown, the voice rules, batched and crash-safe
// writes of data/xp.json, level roles (stacking or only the highest), admin changes with a confirmation and
// the leaderboard pages.

import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { OzellikHatasi } from '../src/ozellikler/_yonlendirici.js';
import { createXpStore, FLUSH_DELAY_MS } from '../src/ozellikler/seviye/depo.js';
import seviye, {
  handleLeave,
  handleMessage,
  renderLeaderboard,
  storeOf,
  syncLevelRoles,
  voiceTick,
} from '../src/ozellikler/seviye/index.js';
import {
  cooldownOver,
  levelForXp,
  levelRoles,
  progressOf,
  randomXp,
  totalXpForLevel,
  voiceEarners,
  xpForLevel,
} from '../src/ozellikler/seviye/xp.js';
import { fakeClock, idsOf, makeContext, removeTempDirs, silent, tempDir, textOf } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const VOICE = '333333333333333333';
const AFK = '444444444444444444';
const ADMIN = '555555555555555555';
const BOT = '666666666666666666';
const OWNER = '999999999999999990';
const user = (i) => `7777777777777${String(i).padStart(5, '0')}`;
const roleId = (i) => `8888888888888888${String(i).padStart(2, '0')}`;

/** An admin ("Sunucuyu Yönet") whose highest role is at `position`. */
const adminMember = (position = 8, { manage = true, id = ADMIN } = {}) => ({
  id,
  permissions: { has: () => manage },
  roles: { highest: { position } },
});

/** A guild with roles at positions 1..12 under the bot's role (position 10); ADMIN is a member (highest 8). */
function fakeGuild({
  voiceStates = new Map(),
  channels = new Map(),
  botPosition = 10,
  manageRoles = true,
  admin = adminMember(),
} = {}) {
  const memberCache = new Map(admin ? [[ADMIN, admin]] : []);
  const roles = new Map();
  for (let i = 1; i <= 12; i += 1) {
    roles.set(roleId(i), { id: roleId(i), position: i, managed: false, permissions: { has: () => false } });
  }
  return {
    id: GUILD,
    ownerId: OWNER,
    name: 'Örnek Sunucu',
    memberCount: 42,
    afkChannelId: AFK,
    roles: { cache: roles },
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
    voiceStates: { cache: voiceStates },
    members: {
      me: { id: BOT, permissions: { has: () => manageRoles }, roles: { highest: { position: botPosition } } },
      cache: memberCache,
      fetch: async (id) => memberCache.get(id) ?? null,
    },
  };
}

function fakeMember(guild, id, roleIds = []) {
  const cache = new Map(roleIds.map((r) => [r, { id: r }]));
  const calls = { add: [], remove: [] };
  return {
    id,
    guild,
    calls,
    displayName: `Üye ${id.slice(-2)}`,
    user: { id, bot: false, username: `uye${id.slice(-2)}` },
    roles: {
      cache,
      async add(ids) {
        if (this.failAdd) throw new Error('Missing Permissions');
        calls.add.push(ids);
        for (const r of ids) cache.set(r, { id: r });
      },
      async remove(ids) {
        calls.remove.push(ids);
        for (const r of ids) cache.delete(r);
      },
    },
  };
}

function textChannel(id = CHANNEL) {
  const sent = [];
  return {
    id,
    sent,
    async send(payload) {
      sent.push(payload);
      return { id: '1' };
    },
  };
}

function message(guild, authorId, { channel = textChannel(), roles = [], bot = false, webhookId = null } = {}) {
  return {
    guild,
    guildId: guild.id,
    channelId: channel.id,
    channel,
    author: { id: authorId, bot },
    member: { roles: { cache: new Map(roles.map((r) => [r, {}])) } },
    webhookId,
    system: false,
  };
}

async function contextWith(guild, { dir, clock = fakeClock() } = {}) {
  const context = await makeContext({ dir, clock });
  context.client.guilds.cache = new Map([[guild.id, guild]]);
  context.client.user = { id: BOT };
  return context;
}

describe('XP formula (MEE6)', () => {
  it('matches the MEE6 level table', () => {
    // Total XP needed for a level, as MEE6 lists it.
    const table = { 1: 100, 2: 255, 3: 475, 4: 770, 5: 1150, 10: 4675, 20: 23850, 50: 268375, 100: 1899250 };
    for (const [level, xp] of Object.entries(table)) assert.equal(totalXpForLevel(Number(level)), xp, `level ${level}`);
    assert.equal(xpForLevel(0), 100);
    assert.equal(xpForLevel(10), 1100);
    assert.equal(levelForXp(0), 0);
    assert.equal(levelForXp(99), 0);
    assert.equal(levelForXp(100), 1);
    assert.equal(levelForXp(254), 1);
    assert.equal(levelForXp(255), 2);
    assert.equal(levelForXp(1899249), 99);
    assert.equal(levelForXp(1899250), 100);
    assert.deepEqual(progressOf(300), { seviye: 2, buSeviyede: 45, gereken: 220, toplamXp: 300 });
  });

  it('gives 15-25 XP per message', () => {
    assert.equal(
      randomXp(() => 0),
      15,
    );
    assert.equal(
      randomXp((max) => max - 1),
      25,
    );
    for (let i = 0; i < 2000; i += 1) {
      const xp = randomXp();
      assert.ok(xp >= 15 && xp <= 25 && Number.isInteger(xp), String(xp));
    }
  });
});

describe('message XP', () => {
  it('waits 60 seconds between rewarded messages of the same person', async () => {
    const clock = fakeClock();
    const guild = fakeGuild();
    const context = await contextWith(guild, { clock });
    assert.ok(cooldownOver(1000, 0));
    assert.ok(!cooldownOver(60_999, 1000));
    assert.ok(cooldownOver(61_000, 1000));

    const first = await handleMessage(context, message(guild, user(1)));
    assert.ok(first.xp >= 15 && first.xp <= 25);
    await clock.advance(30_000);
    assert.equal(await handleMessage(context, message(guild, user(1))), null, 'still cooling down');
    assert.ok(await handleMessage(context, message(guild, user(2))), 'someone else is not affected');
    await clock.advance(30_000);
    const third = await handleMessage(context, message(guild, user(1)));
    assert.ok(third.xp >= 30 && third.xp <= 50);
    assert.equal(storeOf(context).kayit(GUILD, user(1)).mesajSon, clock.now());
  });

  it('gives nothing to bots, webhooks, excluded channels and roles, or when switched off', async () => {
    const guild = fakeGuild();
    const context = await contextWith(guild);
    const store = storeOf(context);
    assert.equal(await handleMessage(context, message(guild, user(1), { bot: true })), null);
    assert.equal(await handleMessage(context, message(guild, user(1), { webhookId: '1' })), null);
    store.haricDegistir(GUILD, 'kanal', CHANNEL);
    assert.equal(await handleMessage(context, message(guild, user(1))), null);
    const thread = { ...textChannel('999999999999999999'), parentId: CHANNEL };
    assert.equal(await handleMessage(context, message(guild, user(1), { channel: thread })), null, 'a thread of it');
    store.haricDegistir(GUILD, 'kanal', CHANNEL);
    store.haricDegistir(GUILD, 'rol', roleId(1));
    assert.equal(await handleMessage(context, message(guild, user(1), { roles: [roleId(1)] })), null);
    context.ozellikler.ayarlar.set(GUILD, 'seviye', 'acik', false);
    assert.equal(await handleMessage(context, message(guild, user(1))), null);
    assert.equal(store.kayit(GUILD, user(1)), null);
  });

  it('asks only for GuildMessages, never for Message Content', () => {
    assert.deepEqual(seviye.intentler, ['GuildMessages']);
    assert.ok(seviye.izinler.includes('ManageRoles') && seviye.izinler.includes('AttachFiles'));
  });

  it('announces a level up in the set channel with the template, pinging only that person', async () => {
    const announce = textChannel('121212121212121212');
    const guild = fakeGuild({ channels: new Map([[announce.id, announce]]) });
    const context = await contextWith(guild);
    context.ozellikler.ayarlar.set(GUILD, 'seviye', 'duyuru-kanal', announce.id);
    context.ozellikler.ayarlar.set(GUILD, 'seviye', 'duyuru-metni', '@everyone {kullanıcı} {seviye} oldu ({sunucu})');
    storeOf(context).xpDegistir(GUILD, user(1), 95);
    await handleMessage(context, message(guild, user(1)));
    assert.equal(announce.sent.length, 1);
    assert.equal(announce.sent[0].content, `@everyone <@${user(1)}> 1 oldu (Örnek Sunucu)`);
    assert.deepEqual(announce.sent[0].allowedMentions, { users: [user(1)] });
  });
});

describe('voice XP', () => {
  const state = (userId, extra = {}) => ({ userId, channelId: VOICE, ...extra });

  it('needs two people who can hear; deafened, AFK and bots get nothing', () => {
    assert.deepEqual(voiceEarners([state(user(1))]), [], 'alone');
    assert.deepEqual(voiceEarners([state(user(1)), state(user(2))]).sort(), [user(1), user(2)]);
    assert.deepEqual(voiceEarners([state(user(1)), state(user(2), { selfDeaf: true })]), [], 'the other is deafened');
    assert.deepEqual(voiceEarners([state(user(1)), state(user(2), { serverDeaf: true })]), []);
    assert.deepEqual(voiceEarners([state(user(1)), state(BOT, { bot: true })]), [], 'a bot does not count');
    assert.deepEqual(voiceEarners([state(user(1)), state(user(2)), state(user(3), { selfDeaf: true })]).sort(), [
      user(1),
      user(2),
    ]);
    assert.deepEqual(
      voiceEarners([state(user(1), { channelId: AFK }), state(user(2), { channelId: AFK })], { afkChannelId: AFK }),
      [],
    );
    assert.deepEqual(
      voiceEarners([state(user(1)), state(user(2), { roleIds: [roleId(1)] })], { haricRoller: [roleId(1)] }),
      [],
      'an excluded role earns nothing and does not count as company',
    );
    assert.deepEqual(
      voiceEarners([state(user(1)), state(user(2), { selfMute: true })]),
      [],
      'a muted alt does not count',
    );
    assert.deepEqual(voiceEarners([state(user(1)), state(user(2), { serverMute: true })]), []);
    assert.deepEqual(
      voiceEarners([state(user(1)), state(user(2)), state(user(3), { selfMute: true })]).sort(),
      [user(1), user(2), user(3)],
      'a muted listener still earns when two others count',
    );
    assert.deepEqual(voiceEarners([state(user(1)), state(user(2), { channelId: '919191919191919191' })]), []);
  });

  it('counts every minute and goes on after a restart with whoever is in voice then', async () => {
    const dir = tempDir();
    const voiceStates = () =>
      new Map([
        [user(1), { channelId: VOICE, selfDeaf: false, serverDeaf: false, member: { user: { bot: false } } }],
        [user(2), { channelId: VOICE, selfDeaf: false, serverDeaf: false, member: { user: { bot: false } } }],
        [BOT, { channelId: VOICE, member: { user: { bot: true } } }],
      ]);
    const clock = fakeClock();
    const first = await contextWith(fakeGuild({ voiceStates: voiceStates() }), { dir, clock });
    await clock.advance(60_000); // the module's own minute timer
    await clock.advance(60_000);
    assert.equal(storeOf(first).kayit(GUILD, user(1)).sesDakika, 2);
    assert.equal(storeOf(first).kayit(GUILD, BOT), null);
    first.ozellikler.kapat(); // shutdown writes what is pending

    const clock2 = fakeClock(clock.now() + 3_600_000);
    const second = await contextWith(fakeGuild({ voiceStates: voiceStates() }), { dir, clock: clock2 });
    assert.equal(storeOf(second).kayit(GUILD, user(1)).sesDakika, 2, 'the hour the bot was off is not counted');
    await clock2.advance(60_000);
    assert.equal(storeOf(second).kayit(GUILD, user(1)).sesDakika, 3);
    second.ozellikler.ayarlar.set(GUILD, 'seviye', 'ses', false);
    assert.equal(voiceTick(second), 0, 'voice XP switched off');
    second.ozellikler.kapat();
  });
});

describe('data/xp.json', () => {
  /** An fs whose writes can be made to fail; counts renames (one per finished write). */
  function flakyFs() {
    const fs = { ...realFs, fail: false, renames: 0 };
    fs.renameSync = (from, to) => {
      if (fs.fail) throw Object.assign(new Error('EBUSY: busy'), { code: 'EINVAL' });
      fs.renames += 1;
      return realFs.renameSync(from, to);
    };
    return fs;
  }

  it('writes in batches: 1000 people and 100 messages a second give one write per flush interval', async () => {
    const clock = fakeClock();
    const file = join(tempDir(), 'xp.json');
    const store = createXpStore({ file, timers: clock, logger: silent });
    for (let second = 0; second < 10; second += 1) {
      for (let i = 0; i < 100; i += 1) {
        store.mesajXp(GUILD, user((second * 100 + i) % 1000), {
          now: clock.now(),
          amount: 20,
          waitMs: 60_000,
          cooldownOver,
        });
      }
      await clock.advance(1000);
    }
    assert.equal(FLUSH_DELAY_MS, 5000);
    assert.equal(store.yazimSayisi, 2, '10 seconds of messages -> 2 writes (one per 5 s)');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(Object.keys(saved.sunucular[GUILD].kullanicilar).length, 1000);
    assert.deepEqual(Object.keys(saved.sunucular[GUILD].kullanicilar[user(1)]).sort(), [
      'level',
      'mesajSon',
      'sesDakika',
      'xp',
    ]);
  });

  it('keeps the old file and the changes in memory when a write fails, and tries again', async () => {
    const clock = fakeClock();
    const file = join(tempDir(), 'xp.json');
    const fs = flakyFs();
    const store = createXpStore({ file, timers: clock, logger: silent, fs });
    store.sesXp(GUILD, user(1), 20);
    await clock.advance(FLUSH_DELAY_MS);
    const good = readFileSync(file, 'utf8');
    fs.fail = true;
    store.sesXp(GUILD, user(1), 20);
    await clock.advance(FLUSH_DELAY_MS);
    assert.equal(readFileSync(file, 'utf8'), good, 'the last good file is untouched');
    assert.ok(!readdirSync(join(file, '..')).some((f) => f.endsWith('.yaziliyor')), 'no temp file left behind');
    assert.equal(store.kayit(GUILD, user(1)).xp, 40, 'nothing lost in memory');
    fs.fail = false;
    await clock.advance(FLUSH_DELAY_MS);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).sunucular[GUILD].kullanicilar[user(1)].xp, 40);
  });

  it('rolls an admin change back when it cannot be written', () => {
    const file = join(tempDir(), 'xp.json');
    const fs = flakyFs();
    const store = createXpStore({ file, timers: fakeClock(), logger: silent, fs });
    store.xpDegistir(GUILD, user(1), 500);
    fs.fail = true;
    assert.throws(() => store.xpDegistir(GUILD, user(1), 1000), OzellikHatasi);
    assert.throws(() => store.rolAyarla(GUILD, 5, roleId(1), ADMIN), OzellikHatasi);
    assert.equal(store.kayit(GUILD, user(1)).xp, 500);
    assert.equal(store.roller(GUILD).size, 0);
  });

  it('backs up a corrupt file, drops bad ids and reserved names, and never rewrites a newer version', () => {
    const dir = tempDir();
    const file = join(dir, 'xp.json');
    writeFileSync(file, '{"schemaVersion":1,"sunucular":{');
    const empty = createXpStore({ file, timers: fakeClock(), logger: silent });
    assert.equal(empty.liderlik(GUILD).toplam, 0);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('xp.json.bozuk-')));

    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        sunucular: {
          [GUILD]: {
            kullanicilar: {
              [user(1)]: { xp: 300, level: 99 },
              __proto__: { xp: 5 },
              abc: { xp: 5 },
              [user(2)]: { xp: -4 },
            },
            roller: {
              5: { rol: roleId(1), kim: ADMIN },
              constructor: { rol: roleId(2), kim: ADMIN },
              0: { rol: roleId(3), kim: ADMIN },
              7: roleId(4),
            },
            haricKanallar: [CHANNEL, 'x'],
          },
          __proto__: {},
        },
      }),
    );
    const store = createXpStore({ file, timers: fakeClock(), logger: silent });
    assert.deepEqual(store.kayit(GUILD, user(1)), { xp: 300, level: 2, mesajSon: 0, sesDakika: 0 }, 'level recomputed');
    assert.equal(store.kayit(GUILD, user(2)).xp, 0);
    assert.deepEqual([...store.roller(GUILD)], [[5, roleId(1)]]);
    assert.deepEqual([...store.haric(GUILD).kanallar], [CHANNEL]);
    assert.equal(Object.prototype.xp, undefined);

    const newer = JSON.stringify({ schemaVersion: 2, sunucular: {} });
    writeFileSync(file, newer);
    const readOnly = createXpStore({ file, timers: fakeClock(), logger: silent });
    assert.ok(readOnly.saltOkunur);
    assert.equal(readOnly.sesXp(GUILD, user(1), 20), null);
    assert.throws(() => readOnly.xpDegistir(GUILD, user(1), 5), OzellikHatasi);
    readOnly.kapat();
    assert.equal(readFileSync(file, 'utf8'), newer);
  });

  it('deletes the record of someone who leaves only when the guild says so', async () => {
    const context = await contextWith(fakeGuild());
    storeOf(context).xpDegistir(GUILD, user(1), 100);
    assert.equal(handleLeave(context, { guild_id: GUILD, user: { id: user(1) } }), false);
    context.ozellikler.ayarlar.set(GUILD, 'seviye', 'ayrilinca-sil', true);
    assert.equal(handleLeave(context, { guild_id: GUILD, user: { id: user(1) } }), true);
    assert.equal(storeOf(context).kayit(GUILD, user(1)), null);
  });
});

describe('level roles', () => {
  const mapping = new Map([
    [5, roleId(1)],
    [10, roleId(2)],
    [20, roleId(3)],
  ]);

  it('stack by default, or only the highest stays', () => {
    assert.deepEqual(levelRoles(mapping, 3), { ver: [], al: [roleId(1), roleId(2), roleId(3)] });
    assert.deepEqual(levelRoles(mapping, 12), { ver: [roleId(1), roleId(2)], al: [roleId(3)] });
    assert.deepEqual(levelRoles(mapping, 12, { yalnizEnYuksek: true }), {
      ver: [roleId(2)],
      al: [roleId(1), roleId(3)],
    });
    assert.deepEqual(levelRoles({ 20: roleId(3), 5: roleId(1) }, 25, { yalnizEnYuksek: true }).ver, [roleId(3)]);
  });

  it('are given and taken on a level change; a role above the bot is skipped without a crash', async () => {
    const guild = fakeGuild({ botPosition: 2 });
    const context = await contextWith(guild);
    const store = storeOf(context);
    store.rolAyarla(GUILD, 5, roleId(1), ADMIN);
    store.rolAyarla(GUILD, 10, roleId(5), ADMIN); // position 5 >= the bot's 2: cannot be given
    const member = fakeMember(guild, user(1));
    const result = await syncLevelRoles(context, guild, user(1), 12, member);
    assert.deepEqual(result.verilen, [roleId(1)]);
    assert.deepEqual(
      result.atlanan.map((s) => s.rolId),
      [roleId(5)],
    );

    context.ozellikler.ayarlar.set(GUILD, 'seviye', 'yalniz-en-yuksek', true);
    guild.members.me.roles.highest.position = 10;
    const highest = await syncLevelRoles(context, guild, user(1), 12, member);
    assert.deepEqual(highest.verilen, [roleId(5)]);
    assert.deepEqual(highest.alinan, [roleId(1)]);

    member.roles.failAdd = true;
    store.rolAyarla(GUILD, 20, roleId(6), ADMIN);
    const failed = await syncLevelRoles(context, guild, user(1), 25, member);
    assert.deepEqual(failed.verilen, [], 'an API error is logged, not thrown');

    const noPermission = fakeGuild({ manageRoles: false });
    const ctx2 = await contextWith(noPermission);
    storeOf(ctx2).rolAyarla(GUILD, 5, roleId(1), ADMIN);
    const none = await syncLevelRoles(ctx2, noPermission, user(1), 6, fakeMember(noPermission, user(1)));
    assert.equal(none.verilen.length, 0);
    assert.match(none.atlanan[0].neden, /Rolleri Yönet/);
  });

  it('are taken away with only the bot hierarchy checked (setter gone, or a role that became unsafe)', async () => {
    const guild = fakeGuild();
    const context = await contextWith(guild);
    context.ozellikler.ayarlar.set(GUILD, 'seviye', 'yalniz-en-yuksek', true);
    const store = storeOf(context);
    store.rolAyarla(GUILD, 5, roleId(1), ADMIN);
    store.rolAyarla(GUILD, 10, roleId(2), ADMIN);
    const member = fakeMember(guild, user(1), [roleId(1), roleId(2)]);
    guild.members.cache.delete(ADMIN); // whoever linked them left
    guild.roles.cache.get(roleId(1)).permissions = { has: (flag) => flag === PermissionFlagsBits.KickMembers };
    const result = await syncLevelRoles(context, guild, user(1), 12, member);
    assert.deepEqual(result.alinan, [roleId(1)], 'the lower (now unsafe) role is taken away');
    assert.deepEqual(result.verilen, [], 'roleId(2) is already there');
    const reset = await syncLevelRoles(context, guild, user(1), 0, member);
    assert.deepEqual(reset.alinan, [roleId(2)], 'after sifirla the role goes even though its setter left');
    guild.roles.cache.get(roleId(2)).position = 11; // above the bot now
    member.roles.cache.set(roleId(2), {});
    const above = await syncLevelRoles(context, guild, user(1), 0, member);
    assert.deepEqual(above.alinan, [], 'the bot hierarchy still applies');
  });

  it('are checked against whoever linked them, again when given; forbidden permissions are never given', async () => {
    const admin = adminMember(4);
    const guild = fakeGuild({ admin });
    const context = await contextWith(guild);
    const store = storeOf(context);
    store.rolAyarla(GUILD, 5, roleId(3), ADMIN); // below the admin (4): fine
    store.rolAyarla(GUILD, 6, roleId(7), ADMIN); // above the admin (e.g. the role was moved up later)
    store.rolAyarla(GUILD, 7, roleId(9), OWNER); // the owner may link any role below the bot
    const member = fakeMember(guild, user(1));
    const result = await syncLevelRoles(context, guild, user(1), 8, member);
    assert.deepEqual(result.verilen, [roleId(3), roleId(9)]);
    assert.deepEqual(
      result.atlanan.map((a) => a.rolId),
      [roleId(7)],
    );
    assert.match(result.atlanan[0].neden, /ayarlayan kişinin en yüksek rolünden/);

    // The admin loses "Sunucuyu Yönet", then leaves the server: the roles they linked are no longer given.
    const fresh = () => fakeMember(guild, user(2));
    admin.permissions.has = () => false;
    assert.match((await syncLevelRoles(context, guild, user(2), 5, fresh())).atlanan[0].neden, /Sunucuyu Yönet/);
    guild.members.cache.delete(ADMIN);
    assert.match((await syncLevelRoles(context, guild, user(2), 5, fresh())).atlanan[0].neden, /artık sunucuda değil/);

    // A role that got a moderation permission after it was linked is refused when given.
    guild.roles.cache.get(roleId(9)).permissions = { has: (flag) => flag === PermissionFlagsBits.BanMembers };
    const banned = await syncLevelRoles(context, guild, user(3), 8, fakeMember(guild, user(3)));
    assert.ok(!banned.verilen.includes(roleId(9)));
    assert.match(banned.atlanan.find((a) => a.rolId === roleId(9)).neden, /izni var; bu izin/);
  });
});

describe('/seviye', () => {
  function slash(sub, { options = {}, manage = true } = {}) {
    const replies = [];
    return {
      replies,
      guildId: GUILD,
      guild: fakeGuild(),
      user: { id: ADMIN },
      member: adminMember(8),
      memberPermissions: { has: () => manage },
      options: {
        getSubcommand: () => sub,
        getUser: (name) => options[name] ?? null,
        getInteger: (name) => options[name] ?? null,
        getMember: () => null,
        getRole: (name) => options[name] ?? null,
        getChannel: (name) => options[name] ?? null,
      },
      async reply(payload) {
        replies.push(payload);
      },
    };
  }
  function click(customId, { manage = true } = {}) {
    const updates = [];
    return {
      customId,
      updates,
      guildId: GUILD,
      guild: fakeGuild(),
      user: { id: ADMIN },
      memberPermissions: { has: () => manage },
      async update(p) {
        updates.push(p);
      },
    };
  }
  const run = (context, interaction) => seviye.komutlar[0].execute(interaction, context);
  const buttonsOf = (payload) => payload.components[0].toJSON().components.map((c) => c.custom_id);

  it('/seviye ver asks first, then gives the XP once; a second click is refused', async () => {
    const context = await contextWith(fakeGuild());
    const ask = slash('ver', { options: { kullanici: { id: user(1), bot: false }, xp: 300 } });
    await run(context, ask);
    assert.equal(storeOf(context).kayit(GUILD, user(1)), null, 'nothing before the confirmation');
    const [confirm, cancel] = buttonsOf(ask.replies[0]);
    assert.match(confirm, /^oz:seviye:onay:ver:\d+:300:[0-9a-f]{8}$/);
    assert.match(cancel, /^oz:seviye:iptal:/);
    const args = confirm.split(':').slice(3);
    const first = click(confirm);
    await seviye.bilesenler.onay(first, context, args);
    assert.equal(storeOf(context).kayit(GUILD, user(1)).xp, 300);
    assert.match(first.updates[0].content, /seviye \*\*2\*\*/);
    await assert.rejects(seviye.bilesenler.onay(click(confirm), context, args), /süresi doldu ya da zaten kullanıldı/);
    assert.equal(storeOf(context).kayit(GUILD, user(1)).xp, 300);
  });

  it('nobody but the owner gives XP to themselves (XP buys level roles)', async () => {
    const context = await contextWith(fakeGuild());
    await assert.rejects(
      run(context, slash('ver', { options: { kullanici: { id: ADMIN, bot: false }, xp: 5000 } })),
      /Kendinize XP veremezsiniz/,
    );
    const owner = slash('ver', { options: { kullanici: { id: ADMIN, bot: false }, xp: 50 } });
    owner.guild.ownerId = ADMIN;
    await run(context, owner);
    assert.equal(owner.replies.length, 1, 'the owner gets the confirmation');
  });

  it('admin subcommands and confirmations need "Sunucuyu Yönet"; old confirmations expire', async () => {
    const clock = fakeClock();
    const context = await contextWith(fakeGuild(), { clock });
    await assert.rejects(
      run(context, slash('ver', { manage: false, options: { kullanici: { id: user(1) }, xp: 5 } })),
      /Sunucuyu Yönet/,
    );
    const ask = slash('sifirla');
    await run(context, ask);
    const [confirm] = buttonsOf(ask.replies[0]);
    const args = confirm.split(':').slice(3);
    await assert.rejects(seviye.bilesenler.onay(click(confirm, { manage: false }), context, args), /Sunucuyu Yönet/);
    await clock.advance(5 * 60_000 + 1);
    await assert.rejects(seviye.bilesenler.onay(click(confirm), context, args), /süresi doldu/);
  });

  it('/seviye al takes XP away (never below zero) and sifirla deletes everyone after confirming', async () => {
    const context = await contextWith(fakeGuild());
    const store = storeOf(context);
    store.xpDegistir(GUILD, user(1), 300);
    store.xpDegistir(GUILD, user(2), 50);
    const take = slash('al', { options: { kullanici: { id: user(1), bot: false }, xp: 1000 } });
    await run(context, take);
    const id = buttonsOf(take.replies[0])[0];
    await seviye.bilesenler.onay(click(id), context, id.split(':').slice(3));
    assert.equal(store.kayit(GUILD, user(1)).xp, 0);
    const reset = slash('sifirla');
    await run(context, reset);
    const all = buttonsOf(reset.replies[0])[0];
    assert.match(all, /:hepsi:-:0:/);
    await seviye.bilesenler.onay(click(all), context, all.split(':').slice(3));
    assert.equal(store.liderlik(GUILD).toplam, 0);
  });

  it('/seviye rol checks the role like /ayar and /seviye haric toggles', async () => {
    const context = await contextWith(fakeGuild());
    const managed = { id: roleId(2), position: 1, managed: true, permissions: { has: () => false } };
    await assert.rejects(
      run(context, slash('rol', { options: { seviye: 5, rol: managed } })),
      /bota ya da sunucu takviyesine/,
    );
    const high = { id: roleId(11), position: 11, managed: false, permissions: { has: () => false } };
    await assert.rejects(run(context, slash('rol', { options: { seviye: 5, rol: high } })), /rolüm ondan aşağıda/);
    const aboveMe = { id: roleId(9), position: 9, managed: false, permissions: { has: () => false } };
    await assert.rejects(
      run(context, slash('rol', { options: { seviye: 5, rol: aboveMe } })),
      /sizin en yüksek rolünüzden aşağıda olmalı/,
      'an admin cannot link a role above their own highest role',
    );
    for (const name of [
      'BanMembers',
      'KickMembers',
      'ManageChannels',
      'ModerateMembers',
      'MentionEveryone',
      'ViewAuditLog',
    ]) {
      const risky = {
        id: roleId(2),
        position: 2,
        managed: false,
        permissions: { has: (f) => f === PermissionFlagsBits[name] },
      };
      await assert.rejects(
        run(context, slash('rol', { options: { seviye: 5, rol: risky } })),
        /izni var; bu izin/,
        name,
      );
    }
    const ok = { id: roleId(1), position: 1, managed: false, permissions: { has: () => false } };
    await run(context, slash('rol', { options: { seviye: 5, rol: ok } }));
    assert.deepEqual([...storeOf(context).roller(GUILD)], [[5, roleId(1)]]);
    assert.equal(storeOf(context).rolAyarlayan(GUILD, roleId(1)), ADMIN);
    const toggle = slash('haric', { options: { kanal: { id: CHANNEL, type: ChannelType.GuildText } } });
    await run(context, toggle);
    assert.match(toggle.replies[0].content, /artık XP almıyor/);
    await run(context, slash('haric', { options: { kanal: { id: CHANNEL, type: ChannelType.GuildText } } }));
    assert.equal(storeOf(context).haric(GUILD).kanallar.size, 0);
  });

  it('the leaderboard shows 10 a page with page buttons', async () => {
    const context = await contextWith(fakeGuild());
    for (let i = 1; i <= 25; i += 1) storeOf(context).xpDegistir(GUILD, user(i), i * 100);
    const page1 = renderLeaderboard(context, GUILD, 'Örnek', 1);
    const text = textOf(page1);
    assert.match(text, new RegExp(`🥇 <@${user(25)}> • Seviye 7 • 2.500 XP`));
    assert.match(text, /Sayfa 1\/3 • 25 kişi/);
    assert.deepEqual(idsOf(page1), ['oz:seviye:sayfa:0', 'oz:seviye:sayfa:2']);
    const page3 = renderLeaderboard(context, GUILD, 'Örnek', 99);
    assert.match(textOf(page3), /\*\*21\.\*\* <@/);
    assert.match(textOf(page3), /Sayfa 3\/3/);
    assert.equal(
      textOf(page3)
        .split('\n')
        .filter((l) => l.includes('<@')).length,
      5,
    );
    assert.equal(storeOf(context).sira(GUILD, user(25)), 1);
    assert.equal(storeOf(context).sira(GUILD, user(1)), 25);
  });

  it('/seviye rank sends a PNG card (text only when the card cannot be drawn)', async () => {
    const context = await contextWith(fakeGuild());
    const drawn = [];
    context.kartCizici = {
      async rankKarti(data) {
        drawn.push(data);
        return Buffer.from('png');
      },
    };
    storeOf(context).xpDegistir(GUILD, user(1), 300);
    const interaction = slash('rank', {
      options: {
        kullanici: {
          id: user(1),
          bot: false,
          username: 'çağrı',
          displayAvatarURL: () => 'https://cdn.discordapp.com/a.png',
        },
      },
    });
    const edits = [];
    Object.assign(interaction, { deferReply: async () => {}, editReply: async (p) => edits.push(p) });
    await run(context, interaction);
    assert.equal(drawn[0].seviye, 2);
    assert.equal(drawn[0].buSeviyede, 45);
    assert.equal(drawn[0].sira, 1);
    assert.equal(drawn[0].avatarUrl, 'https://cdn.discordapp.com/a.png');
    assert.equal(edits[0].files.length, 1);
    assert.match(edits[0].content, /Seviye \*\*2\*\*/);
    context.kartCizici.rankKarti = async () => {
      throw new Error('boom');
    };
    await run(context, interaction);
    assert.equal(edits[1].files, undefined);
    assert.match(edits[1].content, /çizilemedi/);
    await assert.rejects(run(context, slash('rank', { options: { kullanici: { id: BOT, bot: true } } })), /Botların/);
  });
});

it('the xp file is only created when something is earned', async () => {
  const dir = tempDir();
  const context = await contextWith(fakeGuild(), { dir });
  context.ozellikler.kapat();
  assert.ok(!existsSync(join(dir, 'xp.json')));
});
