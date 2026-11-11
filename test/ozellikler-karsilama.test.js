// Welcome / goodbye (karşılama): templates, automatic roles (bots apart, hierarchy, membership screening),
// the messages with their cards, and that the bot keeps running when the Server Members Intent is off.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Events, PermissionFlagsBits } from 'discord.js';
import { validateValue } from '../src/ozellikler/ayarlar/sema.js';
import { planIntents } from '../src/ozellikler/_intentler.js';
import { fillTemplate, placeholderKey } from '../src/ozellikler/_sablon.js';
import { createOzellikler, loadModules } from '../src/ozellikler/index.js';
import { roleWarnings, settingsSummary } from '../src/ozellikler/ayarlar/komut.js';
import karsilama, {
  autoRolesOf,
  catchUpPending,
  handleJoin,
  handleLeave,
  handleMemberUpdate,
  pendingOf,
  rawAvatarUrl,
} from '../src/ozellikler/karsilama/index.js';
import { fakeClock, makeContext, removeTempDirs, silent, tempDir } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const GUILD = '111111111111111111';
const WELCOME = '222222222222222222';
const BYE = '333333333333333333';
const BOT = '666666666666666666';
const USER = '777777777777777777';
const ADMIN = '555555555555555555';
const OWNER = '444444444444444444';
const roleId = (i) => `8888888888888888${String(i).padStart(2, '0')}`;

function textChannel(id) {
  const sent = [];
  return {
    id,
    sent,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) {
      sent.push(payload);
    },
  };
}

function fakeGuild() {
  const roles = new Map();
  for (let i = 1; i <= 6; i += 1)
    roles.set(roleId(i), { id: roleId(i), position: i, managed: false, permissions: { has: () => false } });
  const channels = new Map([
    [WELCOME, textChannel(WELCOME)],
    [BYE, textChannel(BYE)],
  ]);
  return {
    id: GUILD,
    name: 'Örnek **Sunucu** @everyone',
    memberCount: 128,
    roles: { cache: roles },
    channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
    ownerId: OWNER,
    members: {
      me: { id: BOT, permissions: { has: () => true }, roles: { highest: { position: 4 } } },
      // ADMIN has "Sunucuyu Yönet" and a highest role at position 3
      cache: new Map([[ADMIN, { id: ADMIN, permissions: { has: () => true }, roles: { highest: { position: 3 } } }]]),
      fetch: async () => null,
    },
  };
}

function member(guild, { bot = false, pending = false, id = USER } = {}) {
  const added = [];
  return {
    id,
    guild,
    added,
    pending,
    displayName: 'Gülşen_Öztürk',
    user: { id, bot, username: 'gulsen' },
    displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/abc.png?size=256`,
    roles: {
      cache: new Map(),
      async add(ids) {
        added.push(...ids);
      },
      async remove() {},
    },
  };
}

async function contextWith(guild, { dir, clock } = {}) {
  const context = await makeContext({ dir, clock });
  context.client.guilds.cache = new Map([[GUILD, guild]]);
  context.client.user = { id: BOT };
  const drawn = [];
  context.kartCizici = {
    drawn,
    async karsilamaKarti(data) {
      drawn.push(data);
      return Buffer.from('png');
    },
    arkaPlanKullanilabilir: async () => false,
  };
  // As /ayar stores it: a role setting remembers who set it.
  const set = (key, value, kim = ADMIN) => context.ozellikler.ayarlar.set(GUILD, 'karsilama', key, value, { kim });
  return { context, set, drawn };
}

describe('templates', () => {
  it('fill Turkish and plain placeholders once, leave unknown ones and cut at 2000 characters', () => {
    assert.equal(placeholderKey('Üye Sayısı'), 'uye_sayisi');
    assert.equal(placeholderKey('KULLANICI'), 'kullanici');
    const values = { kullanici: '<@1>', sunucu: 'Örnek', uye_sayisi: 12, ad: '{sunucu}' };
    assert.equal(
      fillTemplate('{kullanıcı} {KULLANICI} {kullanici} {sunucu} {üye_sayısı}. {uye_sayisi} {ad} {bilinmeyen}', values),
      '<@1> <@1> <@1> Örnek 12. 12 {sunucu} {bilinmeyen}',
    );
    const long = fillTemplate('x'.repeat(1990) + '{ad}{ad}', { ad: 'yyyyyy' });
    assert.equal(long.length, 2000);
    assert.ok(long.endsWith('…'));
  });
});

describe('welcome and automatic roles', () => {
  it('gives the automatic roles and sends the welcome with its card, pinging only the newcomer', async () => {
    const guild = fakeGuild();
    const { context, set, drawn } = await contextWith(guild);
    set('hosgeldin-kanal', WELCOME);
    set('otorol-1', roleId(1));
    set('otorol-2', roleId(2));
    set('otorol-3', roleId(5)); // above the bot (position 4): skipped
    set('bot-rol', roleId(2));
    const newcomer = member(guild);
    await handleJoin(context, newcomer);
    assert.deepEqual(newcomer.added, [roleId(1), roleId(2)]);
    const [sent] = guild.channels.cache.get(WELCOME).sent;
    assert.equal(
      sent.content,
      `Hoş geldin <@${USER}>! **Örnek \\*\\*Sunucu\\*\\* @everyone** sunucusunun 128. üyesisin. 🎉`,
    );
    assert.deepEqual(sent.allowedMentions, { users: [USER] });
    assert.equal(sent.files.length, 1);
    assert.equal(drawn[0].ad, 'Gülşen_Öztürk');
    assert.equal(drawn[0].avatarUrl, `https://cdn.discordapp.com/avatars/${USER}/abc.png?size=256`);

    const bot = member(guild, { bot: true, id: '999999999999999999' });
    await handleJoin(context, bot);
    assert.deepEqual(bot.added, [roleId(2)], 'bots get only the bot role');
    assert.deepEqual(autoRolesOf(context, GUILD, false), [roleId(1), roleId(2), roleId(5)]);
  });

  it('gives the roles only to people on the screening list: once, also after a restart', async () => {
    const dir = tempDir();
    const guild = fakeGuild();
    const { context, set } = await contextWith(guild, { dir });
    set('otorol-1', roleId(1));
    const client = Object.assign(new EventEmitter(), context.client);
    const off = karsilama.olaylar({ ...context, client });
    const update = (userId, extra = {}) => ({
      t: 'GUILD_MEMBER_UPDATE',
      d: { guild_id: GUILD, user: { id: userId }, pending: false, roles: [], ...extra },
    });
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    const waiting = member(guild, { pending: true });
    client.emit(Events.GuildMemberAdd, waiting);
    await tick();
    assert.deepEqual(waiting.added, [], 'nothing while screening is pending');
    assert.ok(pendingOf(context).var(GUILD, USER), 'on the list, in data/karsilama-bekleyen.json');
    assert.ok(existsSync(join(dir, 'karsilama-bekleyen.json')));
    guild.members.cache.set(USER, waiting);
    client.emit(Events.Raw, update(USER));
    client.emit(Events.Raw, update(USER));
    await tick();
    assert.deepEqual(waiting.added, [roleId(1)], 'given once');
    assert.ok(!pendingOf(context).var(GUILD, USER), 'off the list');

    // A moderator takes the role away; later updates (nickname, restart) never give it back.
    waiting.added.length = 0;
    client.emit(Events.Raw, update(USER, { nick: 'yeni ad' }));
    await tick();
    assert.deepEqual(waiting.added, []);

    // Someone else on the list passed screening while the bot was off: on ClientReady, after a "restart".
    const other = '777777777777777700';
    pendingOf(context).ekle(GUILD, other, context.ozellikler.saat.now());
    const still = '777777777777777701';
    pendingOf(context).ekle(GUILD, still, context.ozellikler.saat.now());
    off();
    const restarted = await contextWith(guild, { dir });
    restarted.set('otorol-1', roleId(1));
    const accepted = member(guild, { id: other });
    const stillWaiting = member(guild, { id: still, pending: true });
    guild.members.fetch = async (id) => ({ [other]: accepted, [still]: stillWaiting })[id] ?? null;
    guild.members.cache.delete(USER);
    assert.equal(await catchUpPending(restarted.context), 1);
    assert.deepEqual(accepted.added, [roleId(1)]);
    assert.deepEqual(stillWaiting.added, []);
    assert.ok(pendingOf(restarted.context).var(GUILD, still), 'still waiting stays on the list');
    assert.ok(!pendingOf(restarted.context).var(GUILD, other));
    // Not on the list (e.g. USER after the moderator took the role): never given.
    assert.equal(await handleMemberUpdate(restarted.context, update(USER).d), null);
  });

  it('without a screening step the roles come at once and nobody is listed; old entries expire', async () => {
    const clock = fakeClock();
    const guild = fakeGuild();
    const { context, set } = await contextWith(guild, { clock });
    set('otorol-1', roleId(1));
    const newcomer = member(guild);
    await handleJoin(context, newcomer);
    assert.deepEqual(newcomer.added, [roleId(1)]);
    assert.ok(!pendingOf(context).var(GUILD, USER));
    pendingOf(context).ekle(GUILD, USER, clock.now());
    await clock.advance(8 * 86_400_000);
    assert.deepEqual(pendingOf(context).hepsi(), [], 'older than 7 days: forgotten');
  });

  it('shows in /ayar goster and the menu which automatic roles are stopped and why', async () => {
    const guild = fakeGuild();
    const { context, set } = await contextWith(guild);
    set('otorol-1', roleId(1), ADMIN);
    set('otorol-2', roleId(2), '333333333333333334'); // set by someone who has left
    const warnings = await roleWarnings(guild, context.ozellikler);
    assert.deepEqual([...warnings.keys()], ['karsilama.otorol-2']);
    const lines = settingsSummary(GUILD, context.ozellikler, { guild, warnings }).find((x) =>
      x.title.includes('Karşılama'),
    ).lines;
    assert.match(
      lines.find((l) => l.startsWith('`otorol-2`')),
      /verilmiyor:\*\* rolü ayarlayan kişi artık sunucuda değil/,
    );
    assert.ok(!lines.find((l) => l.startsWith('`otorol-1`')).includes('verilmiyor'));
    guild.members.cache.get(ADMIN).permissions = { has: () => false };
    const menu = settingsSummary(GUILD, context.ozellikler, { guild }).find((x) => x.title.includes('Karşılama')).lines;
    assert.match(
      menu.find((l) => l.startsWith('`otorol-1`')),
      /Sunucuyu Yönet/,
      'the menu uses the member cache',
    );
  });

  it('re-checks an automatic role against whoever set it; /ayar refuses a role above the setter', async () => {
    const guild = fakeGuild();
    const { context, set } = await contextWith(guild);
    set('otorol-1', roleId(3), ADMIN); // position 3 is not below the admin's highest (3)
    set('otorol-2', roleId(1), null); // nobody recorded
    set('otorol-3', roleId(2), OWNER);
    const newcomer = member(guild);
    await handleJoin(context, newcomer);
    assert.deepEqual(newcomer.added, [roleId(2)]);
    const role = guild.roles.cache.get(roleId(3));
    const setter = guild.members.cache.get(ADMIN);
    assert.throws(
      () => validateValue({ tur: 'rol', verilebilir: true }, role, { guild, member: setter }),
      /sizin en yüksek rolünüzden aşağıda olmalı/,
    );
    const risky = {
      id: roleId(1),
      position: 1,
      managed: false,
      permissions: { has: (f) => f === PermissionFlagsBits.KickMembers },
    };
    assert.throws(
      () => validateValue({ tur: 'rol', verilebilir: true }, risky, { guild, member: setter }),
      /izni var; bu izin/,
    );
    const owner = { id: OWNER, roles: { highest: { position: 0 } } };
    assert.equal(validateValue({ tur: 'rol', verilebilir: true }, role, { guild, member: owner }), roleId(3));
    assert.equal(context.ozellikler.ayarlar.setBy(GUILD, 'karsilama', 'otorol-3'), OWNER);
    assert.equal(context.ozellikler.ayarlar.setBy(GUILD, 'karsilama', 'otorol-2'), null);
  });

  it('sends nothing without a channel and text only when the card is off or cannot be attached', async () => {
    const guild = fakeGuild();
    const { context, set } = await contextWith(guild);
    await handleJoin(context, member(guild));
    assert.equal(guild.channels.cache.get(WELCOME).sent.length, 0);
    set('hosgeldin-kanal', WELCOME);
    set('hosgeldin-kart', false);
    set('hosgeldin-metni', '{ad} geldi');
    await handleJoin(context, member(guild));
    assert.deepEqual(guild.channels.cache.get(WELCOME).sent[0].files, []);
    assert.equal(guild.channels.cache.get(WELCOME).sent[0].content, 'Gülşen\\_Öztürk geldi');
  });

  it('says goodbye from the raw leave packet, also for members that were never cached', async () => {
    const guild = fakeGuild();
    const { context, set, drawn } = await contextWith(guild);
    set('gulegule-kanal', BYE);
    set('gulegule-kart', true);
    const leaving = handleLeave(context, {
      guild_id: GUILD,
      user: { id: USER, username: 'gulsen', global_name: 'Gülşen', avatar: null },
    });
    guild.memberCount = 127; // discord.js updates the count right after the raw packet
    assert.equal(await leaving, true);
    const [sent] = guild.channels.cache.get(BYE).sent;
    assert.equal(sent.content, '**Gülşen** aramızdan ayrıldı. Şimdi 127 kişiyiz. 👋');
    assert.deepEqual(sent.allowedMentions, { users: [] });
    assert.match(drawn[0].avatarUrl, /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/);
    assert.equal(
      rawAvatarUrl({ id: USER, avatar: 'a_0123456789abcdef0123456789abcdef' }),
      `https://cdn.discordapp.com/avatars/${USER}/a_0123456789abcdef0123456789abcdef.png?size=256`,
    );
    assert.match(rawAvatarUrl({ id: USER, avatar: '../../x' }), /embed\/avatars/);
  });
});

describe('Server Members Intent switched off', () => {
  it('turns only this module off: no listeners, Turkish reasons in /ayar, levels keep working', async () => {
    const modules = await loadModules();
    const plan = planIntents(modules, { allowPrivileged: false });
    const client = Object.assign(new EventEmitter(), { guilds: { cache: new Map() } });
    const context = {
      client,
      logger: silent,
      music: Object.assign(new EventEmitter(), { getState: () => null }),
      settings: { getDjRole: () => null },
    };
    const dir = tempDir();
    const registry = createOzellikler({
      context,
      modules,
      intentPlan: plan,
      files: { ayarlar: join(dir, 'o.json'), zamanlayici: join(dir, 'z.json'), paneller: join(dir, 'p.json') },
      clock: fakeClock(),
      logger: silent,
    });
    assert.ok(!plan.names.includes('GuildMembers'));
    assert.ok(plan.names.includes('GuildMessages'), 'level XP needs no privileged intent');
    assert.match(registry.disabledReason('karsilama'), /Server Members|GuildMembers/);
    assert.equal(registry.disabledReason('seviye'), null);
    // The log module (kayit) stays on without privileged intents and listens too (its member types are off).
    const kayit = registry.disabledReason('kayit') === null ? 1 : 0;
    assert.equal(client.listenerCount(Events.GuildMemberAdd), kayit, 'karşılama adds no listener');
    assert.equal(client.listenerCount(Events.MessageCreate), 1 + kayit, 'seviye listens');
    const section = settingsSummary(GUILD, registry).find((s) => s.title.includes('Karşılama'));
    assert.match(section.lines[0], /kapalı \(Developer Portal'da GuildMembers açılmalı\)/);
    registry.kapat();
    assert.equal(client.listenerCount(Events.MessageCreate), 0);
  });
});
