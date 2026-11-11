// Role panels and team search (LFG): roles that must never be self-assigned are refused (everyone, managed,
// moderator permissions, above the bot or the admin), panel buttons give and take roles and still work after
// a restart, a posting fills up and closes, and closes by itself when its time is over (also after a restart).

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { loadCommands } from '../src/commands/index.js';
import { storeOf } from '../src/ozellikler/roller-ve-ara/index.js';
import { roleProblem } from '../src/ozellikler/roller-ve-ara/roller.js';
import { jobIdOf } from '../src/ozellikler/roller-ve-ara/ara.js';
import { errorOf, fakeInteraction, makeLiveContext, newId, perms } from './yardimci/discordSahte.js';
import { fakeClock, idsOf, removeTempDirs, textOf } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const HOUR = 3_600_000;
const commands = await loadCommands();

/** A slash command interaction (/ayar ... or /oyun ...) in a text channel. */
function slash(context, { userId, group = null, sub, values = {}, manage = true, channel }) {
  const guild = context.guild;
  const calls = { replies: [], edits: [] };
  return {
    calls,
    guildId: guild.id,
    guild,
    channelId: channel?.id ?? null,
    user: { id: userId },
    member: guild.members.cache.get(userId),
    memberPermissions: perms(manage ? 'hepsi' : []),
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => sub,
      getChannel: (n) => values[n] ?? null,
      getString: (n) => values[n] ?? null,
      getRole: (n) => values[n] ?? null,
      getBoolean: (n) => values[n] ?? null,
      getInteger: (n) => values[n] ?? null,
      getFocused: () => values.focused ?? '',
    },
    async reply(payload) {
      this.replied = true;
      calls.replies.push(payload);
      const message = channel ? await channel.send(payload) : { id: newId() };
      return { resource: { message: { id: message.id } } };
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      calls.edits.push(payload);
    },
    async respond(choices) {
      calls.replies.push(choices);
    },
  };
}

async function setup({ dir, clock = fakeClock(), guild } = {}) {
  const context = await makeLiveContext({ dir, clock, guild });
  const g = context.guild;
  const text = [...g.channels.cache.values()].find((c) => c.name === 'roller') ?? g.addText('roller');
  const admin = g.members.cache.get('100000000000000010') ?? g.addMember({ userId: '100000000000000010', top: 40 });
  await context.ozellikler.baslat();
  return { context, guild: g, text, admin, clock };
}

const run = async (name, interaction, context) => {
  try {
    await commands.get(name).execute(interaction, context);
  } catch (error) {
    interaction.error = error;
  }
  return interaction;
};

describe('role panels: which roles are allowed', () => {
  it('refuses @everyone, managed, moderator roles and roles above the bot or the admin', async () => {
    const { guild, admin } = await setup();
    const ok = guild.addRole({ name: 'PUBG', position: 10 });
    const cases = [
      [guild.roles.cache.get(guild.id), /@everyone/],
      [guild.addRole({ name: 'Bot', position: 5, managed: true }), /bota ya da sunucu takviyesine/],
      [
        guild.addRole({ name: 'Mod', position: 5, permissions: [PermissionFlagsBits.Administrator] }),
        /'Yönetici' izni var/,
      ],
      [
        guild.addRole({ name: 'Yasak', position: 5, permissions: [PermissionFlagsBits.BanMembers] }),
        /'Üyeleri Yasakla' izni var/,
      ],
      [guild.addRole({ name: 'Üst', position: 60 }), /rolüm ondan aşağıda/],
      [guild.addRole({ name: 'Senden üst', position: 45 }), /en yüksek rolünüzle/],
    ];
    for (const [role, pattern] of cases) assert.match(roleProblem(role, guild, admin) ?? '', pattern, role.name);
    assert.equal(roleProblem(ok, guild, admin), null);
    // The server owner is not limited by their own top role.
    assert.equal(
      roleProblem(guild.addRole({ position: 45 }), guild, { id: guild.ownerId, roles: { highest: { position: 1 } } }),
      null,
    );
  });

  it('/ayar rol-menusu olustur with a refused role posts nothing', async () => {
    const { context, guild, text, admin } = await setup();
    const good = guild.addRole({ name: 'LoL', position: 10 });
    const bad = guild.addRole({ name: 'Üst', position: 60 });
    const interaction = await run(
      'ayar',
      slash(context, {
        userId: admin.id,
        group: 'rol-menusu',
        sub: 'olustur',
        values: { kanal: text, baslik: 'Oyunlar', rol1: good, rol2: bad },
      }),
      context,
    );
    assert.match(interaction.error?.message ?? '', /rolüm ondan aşağıda/);
    assert.equal(text.sent.length, 0);
    assert.deepEqual(storeOf(context).panelsOf(guild.id), []);
  });

  it('only "Sunucuyu Yönet" can set up panels', async () => {
    const { context, guild, text, admin } = await setup();
    const role = guild.addRole({ position: 10 });
    const interaction = await run(
      'ayar',
      slash(context, {
        userId: admin.id,
        manage: false,
        group: 'rol-menusu',
        sub: 'olustur',
        values: { kanal: text, baslik: 'x', rol1: role },
      }),
      context,
    );
    assert.equal(text.sent.length, 0);
    assert.ok(interaction.calls.replies.length || interaction.error);
  });
});

describe('role panels: clicking', () => {
  async function withPanel({ coklu = true, stil = 'dugme' } = {}) {
    const ctx = await setup();
    const pubg = ctx.guild.addRole({ name: 'PUBG', position: 10 });
    const lol = ctx.guild.addRole({ name: 'LoL', position: 11 });
    await run(
      'ayar',
      slash(ctx.context, {
        userId: ctx.admin.id,
        group: 'rol-menusu',
        sub: 'olustur',
        values: { kanal: ctx.text, baslik: 'Oyunlar', rol1: pubg, rol2: lol, coklu, stil },
      }),
      ctx.context,
    );
    const [panel] = storeOf(ctx.context).panelsOf(ctx.guild.id);
    return { ...ctx, pubg, lol, panel, member: ctx.guild.addMember({ name: 'Oyuncu' }) };
  }
  const click = async (context, customId, userId, values) => {
    const interaction = fakeInteraction(context, { customId, userId, values });
    await context.ozellikler.router.handle(interaction, context);
    return interaction;
  };

  it('a button gives the role, a second click takes it back; the answer is only for that member', async () => {
    const { context, text, pubg, panel, member } = await withPanel();
    assert.deepEqual(idsOf(text.sent[0]), [
      `oz:roller-ve-ara:rol:${panel.id}:${panel.roller[0].id}`,
      `oz:roller-ve-ara:rol:${panel.id}:${panel.roller[1].id}`,
    ]);
    const first = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.ok(member.roleIds.has(pubg.id));
    assert.match(first.calls.edits[0].content, /Verildi/);
    await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.ok(!member.roleIds.has(pubg.id));
  });

  it('single choice: picking another role drops the first', async () => {
    const { context, pubg, lol, panel, member } = await withPanel({ coklu: false });
    await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    await click(context, `oz:roller-ve-ara:rol:${panel.id}:${lol.id}`, member.id);
    assert.deepEqual([...member.roleIds], [lol.id]);
  });

  it('select menu: the panel roles become exactly the picked ones; other roles are not touched', async () => {
    const { context, guild, text, pubg, lol, panel, member } = await withPanel({ stil: 'menu' });
    assert.deepEqual(idsOf(text.sent[0]), [`oz:roller-ve-ara:sec:${panel.id}`]);
    const other = guild.addRole({ position: 3 });
    member.roleIds.add(other.id);
    await click(context, `oz:roller-ve-ara:sec:${panel.id}`, member.id, [pubg.id, lol.id]);
    assert.deepEqual([...member.roleIds].sort(), [other.id, pubg.id, lol.id].sort());
    await click(context, `oz:roller-ve-ara:sec:${panel.id}`, member.id, [lol.id, other.id]);
    assert.deepEqual([...member.roleIds].sort(), [other.id, lol.id].sort(), 'a role outside the panel is ignored');
  });

  it('is checked again on every click: a role moved above the bot is not given and the member is told why', async () => {
    const { context, pubg, panel, member } = await withPanel();
    pubg.position = 70;
    const refused = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.match(refused.calls.edits[0].content, /verilemedi: rol, botun rolünden yukarıda/);
    assert.ok(!member.roleIds.has(pubg.id));
  });

  it('stores who put each role on the panel and checks that person on every click', async () => {
    const { context, guild, admin, pubg, panel, member } = await withPanel();
    assert.deepEqual(
      panel.roller.map((r) => r.kim),
      [admin.id, admin.id],
    );
    // The admin lost "Sunucuyu Yönet": the panel no longer gives roles.
    admin.permissions = perms([]);
    const noRight = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.match(noRight.calls.edits[0].content, /Sunucuyu Yönet/);
    assert.ok(!member.roleIds.has(pubg.id));
    // The admin left the server.
    delete admin.permissions;
    guild.members.cache.delete(admin.id);
    const gone = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.match(gone.calls.edits[0].content, /artık sunucuda değil/);
    assert.ok(!member.roleIds.has(pubg.id));
    // Back, but now the role is above the admin's own top role.
    guild.members.cache.set(admin.id, admin);
    pubg.position = 45;
    const above = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.match(above.calls.edits[0].content, /ayarlayan kişinin en yüksek rolünden/);
    pubg.position = 10;
    await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.ok(member.roleIds.has(pubg.id));
  });

  it('an old panel without setters gives no role, tells the member, still takes roles back; /ayar goster warns', async () => {
    const { context, pubg, lol, panel, member } = await withPanel();
    const store = storeOf(context);
    // The member got LoL while the panel was new; then the panel record loses its setters (an old record).
    await click(context, `oz:roller-ve-ara:rol:${panel.id}:${lol.id}`, member.id);
    assert.ok(member.roleIds.has(lol.id));
    store.setPanel(panel.id, { ...panel, roller: panel.roller.map(({ kim, ...rest }) => rest) });
    const refused = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${pubg.id}`, member.id);
    assert.match(refused.calls.edits[0].content, /Bu panel eski/);
    assert.ok(!member.roleIds.has(pubg.id), 'never given');
    const taken = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${lol.id}`, member.id);
    assert.ok(!member.roleIds.has(lol.id), 'taking back still works (bot hierarchy only)');
    assert.match(taken.calls.edits[0].content, /Bırakıldı/);
    const show = slash(context, { userId: '100000000000000003', sub: 'goster' });
    await commands.get('ayar').execute(show, context);
    const fields = JSON.stringify(show.calls.replies[0].embeds[0].toJSON().fields);
    assert.match(fields, /eski bir panel/);
    assert.match(fields, /verilmiyor/);
  });

  it('still works after a restart (persistent customId and data/roller-ve-ara.json)', async () => {
    const first = await withPanel();
    first.context.ozellikler.kapat();
    const again = await setup({ dir: first.context.dir, guild: first.guild });
    await click(again.context, `oz:roller-ve-ara:rol:${first.panel.id}:${first.lol.id}`, first.member.id);
    assert.ok(first.member.roleIds.has(first.lol.id));
  });

  it('a role that is not on the panel cannot be asked for with a forged customId', async () => {
    const { context, guild, panel, member } = await withPanel();
    const secret = guild.addRole({ position: 2 });
    const forged = await click(context, `oz:roller-ve-ara:rol:${panel.id}:${secret.id}`, member.id);
    assert.match(errorOf(forged), /panel/);
    assert.ok(!member.roleIds.has(secret.id));
  });
});

describe('team search (/oyun ara)', () => {
  async function open(ctx, { kisi = 3, oyun = 'PUBG', not = 'rank' } = {}) {
    const owner = ctx.guild.addMember({ name: 'Ali' });
    const interaction = await run(
      'oyun',
      slash(ctx.context, { userId: owner.id, sub: 'ara', values: { oyun, kisi, not }, channel: ctx.text }),
      ctx.context,
    );
    assert.equal(interaction.error, undefined, interaction.error?.message);
    const [entry] = storeOf(ctx.context).ilanlar();
    return { owner, entry, interaction };
  }
  const click = async (context, customId, userId) => {
    const interaction = fakeInteraction(context, { customId, userId });
    await context.ozellikler.router.handle(interaction, context);
    return interaction;
  };

  it('shows "1/3 aranıyor", fills with Katıl, pings the team once full and closes', async () => {
    const ctx = await setup();
    const { entry, interaction } = await open(ctx);
    const card = interaction.calls.replies[0];
    assert.match(textOf(card), /PUBG • 1\/3 aranıyor/);
    assert.match(textOf(card), /rank/);
    assert.deepEqual(idsOf(card), [
      `oz:roller-ve-ara:katil:${entry.id}`,
      `oz:roller-ve-ara:ayril:${entry.id}`,
      `oz:roller-ve-ara:kapat:${entry.id}`,
    ]);
    const [a, b, c] = [1, 2, 3].map((n) => ctx.guild.addMember({ name: `O${n}` }));
    const joinA = await click(ctx.context, `oz:roller-ve-ara:katil:${entry.id}`, a.id);
    assert.match(textOf(joinA.calls.updates[0]), /2\/3 aranıyor/);
    const again = await click(ctx.context, `oz:roller-ve-ara:katil:${entry.id}`, a.id);
    assert.match(errorOf(again), /zaten katıldınız/);
    const joinB = await click(ctx.context, `oz:roller-ve-ara:katil:${entry.id}`, b.id);
    assert.match(textOf(joinB.calls.updates[0]), /3\/3 takım tamam/);
    assert.deepEqual(idsOf(joinB.calls.updates[0]), [], 'no buttons on a full card');
    assert.deepEqual(joinB.calls.followUps[0].allowedMentions, { users: [entry.sahipId, a.id, b.id] });
    assert.equal(storeOf(ctx.context).ilan(entry.id), null, 'the record is gone');
    assert.ok(!ctx.context.ozellikler.zamanlayici.bekleyenler().some((j) => j.id === jobIdOf(entry.id)));
    const late = await click(ctx.context, `oz:roller-ve-ara:katil:${entry.id}`, c.id);
    assert.match(errorOf(late), /kapandı/);
  });

  it('closes by itself after "ara-sure" hours, also when the bot was off then', async () => {
    const ctx = await setup();
    const { entry } = await open(ctx);
    await ctx.clock.advance(2 * HOUR - 1);
    assert.ok(storeOf(ctx.context).ilan(entry.id));
    await ctx.clock.advance(1);
    assert.equal(storeOf(ctx.context).ilan(entry.id), null);
    assert.match(textOf(ctx.text.edits.at(-1).p), /ilan kapandı/);

    const second = await open(ctx, { oyun: 'LoL' });
    ctx.context.ozellikler.kapat();
    const later = await setup({ dir: ctx.context.dir, guild: ctx.guild, clock: fakeClock(ctx.clock.now() + 5 * HOUR) });
    assert.equal(storeOf(later.context).ilan(second.entry.id), null);
    assert.match(textOf(ctx.text.edits.at(-1).p), /LoL • ilan kapandı/);
  });

  it('Ayrıl leaves; the owner closes with Kapat, others cannot', async () => {
    const ctx = await setup();
    const { entry, owner } = await open(ctx);
    const a = ctx.guild.addMember({ name: 'A' });
    await click(ctx.context, `oz:roller-ve-ara:katil:${entry.id}`, a.id);
    const leave = await click(ctx.context, `oz:roller-ve-ara:ayril:${entry.id}`, a.id);
    assert.match(textOf(leave.calls.updates[0]), /1\/3/);
    const ownerLeave = await click(ctx.context, `oz:roller-ve-ara:ayril:${entry.id}`, owner.id);
    assert.match(errorOf(ownerLeave), /Kapat/);
    const stranger = await click(ctx.context, `oz:roller-ve-ara:kapat:${entry.id}`, a.id);
    assert.match(errorOf(stranger), /yalnız açan kişi/);
    await click(ctx.context, `oz:roller-ve-ara:kapat:${entry.id}`, owner.id);
    assert.equal(storeOf(ctx.context).ilan(entry.id), null);
  });

  it('pings the game role set with /ayar takim-ara oyun-rolu (and only that role)', async () => {
    const ctx = await setup();
    const role = ctx.guild.addRole({ name: 'PUBG', position: 10 });
    await run(
      'ayar',
      slash(ctx.context, {
        userId: ctx.admin.id,
        group: 'takim-ara',
        sub: 'oyun-rolu',
        values: { oyun: 'pubg', rol: role },
      }),
      ctx.context,
    );
    const { interaction } = await open(ctx, { oyun: 'PUBG' });
    const card = interaction.calls.replies[0];
    assert.deepEqual(card.allowedMentions, { roles: [role.id] });
    assert.match(textOf(card), new RegExp(`<@&${role.id}>`));
    // One open posting per person.
    const owner = interaction.user.id;
    const second = await run(
      'oyun',
      slash(ctx.context, { userId: owner, sub: 'ara', values: { oyun: 'LoL', kisi: 2 }, channel: ctx.text }),
      ctx.context,
    );
    assert.match(second.error?.message ?? '', /Açık bir ilanınız zaten var/);
  });
});

describe('control center sections', () => {
  it('"Takım ara" is under Oyun; rooms, role panels and the log are under Ayarlar (within 40 components)', async () => {
    const { buildMenu, countComponents } = await import('../src/ozellikler/menu/merkez.js');
    const { context, guild } = await setup();
    const admin = { guildId: guild.id, guild, userId: '1', canManageGuild: true, isDj: true };
    const oyun = buildMenu(context, admin, { bolum: 'oyun' }).payload;
    assert.ok(idsOf(oyun).includes('oz:roller-ve-ara:ara-ac'));
    const ayarlar = buildMenu(context, admin, { bolum: 'ayarlar' }).payload;
    for (const id of ['oz:gecici-oda:merkez-kanal', 'oz:roller-ve-ara:panel-ac', 'oz:kayit:turler'])
      assert.ok(idsOf(ayarlar).includes(id), id);
    assert.ok(countComponents(ayarlar.components.map((c) => c.toJSON())) <= 40);
    const everyone = buildMenu(context, { ...admin, canManageGuild: false }, { bolum: 'ayarlar' }).payload;
    assert.ok(!idsOf(everyone).includes('oz:roller-ve-ara:panel-ac'), 'Ayarlar is for "Sunucuyu Yönet" only');
  });

  it('/ayar stays within Discord limits with the new groups; settings marked gizli get no subcommand', () => {
    const json = commands.get('ayar').data.toJSON();
    const names = json.options.map((o) => o.name);
    for (const name of ['gecici-oda', 'roller-ve-ara', 'rol-menusu', 'takim-ara', 'kayit'])
      assert.ok(names.includes(name), name);
    const kayit = json.options.find((o) => o.name === 'kayit');
    assert.deepEqual(
      kayit.options.map((o) => o.name),
      ['kanal', 'turler', 'haric'],
    );
  });
});

describe('role panels: finding the panel of an /ayar option', () => {
  async function withTitles(titles) {
    const ctx = await setup();
    const base = ctx.guild.addRole({ name: 'Base', position: 10 });
    for (const baslik of titles)
      await run(
        'ayar',
        slash(ctx.context, {
          userId: ctx.admin.id,
          group: 'rol-menusu',
          sub: 'olustur',
          values: { kanal: ctx.text, baslik, rol1: base },
        }),
        ctx.context,
      );
    return { ...ctx, extra: ctx.guild.addRole({ name: 'Valorant', position: 12 }) };
  }
  const add = (ctx, panel, extraValues = {}) =>
    run(
      'ayar',
      slash(ctx.context, {
        userId: ctx.admin.id,
        group: 'rol-menusu',
        sub: 'ekle',
        values: { panel, rol: ctx.extra, ...extraValues },
      }),
      ctx.context,
    );

  it('adds by the typed title, ignoring emoji, case and Turkish i/I', async () => {
    const ctx = await withTitles(['🎮 Oyun Rolleri']);
    for (const typed of ['Oyun Rolleri', 'oyun rolleri', 'OYUN ROLLERI', 'OYUN ROLLERİ', '🎮 oyun', 'rolleri']) {
      const [panel] = storeOf(ctx.context).panelsOf(ctx.guild.id);
      if (panel.roller.length > 1) {
        await run(
          'ayar',
          slash(ctx.context, {
            userId: ctx.admin.id,
            group: 'rol-menusu',
            sub: 'cikar',
            values: { panel: panel.id, rol: ctx.extra },
          }),
          ctx.context,
        );
      }
      const done = await add(ctx, typed);
      assert.equal(done.error, undefined, typed);
      assert.match(done.calls.edits[0].content, /panele eklendi/);
    }
  });

  it('the id from autocomplete still works', async () => {
    const ctx = await withTitles(['Oyunlar']);
    const [panel] = storeOf(ctx.context).panelsOf(ctx.guild.id);
    assert.equal((await add(ctx, panel.id)).error, undefined);
  });

  it('removes and deletes by title too', async () => {
    const ctx = await withTitles(['🎮 Oyun Rolleri']);
    await add(ctx, 'oyun rolleri');
    const cikar = await run(
      'ayar',
      slash(ctx.context, {
        userId: ctx.admin.id,
        group: 'rol-menusu',
        sub: 'cikar',
        values: { panel: 'Oyun Rolleri', rol: ctx.extra },
      }),
      ctx.context,
    );
    assert.match(cikar.calls.edits[0].content, /panelden çıkarıldı/);
    const sil = await run(
      'ayar',
      slash(ctx.context, { userId: ctx.admin.id, group: 'rol-menusu', sub: 'sil', values: { panel: 'oyun' } }),
      ctx.context,
    );
    assert.equal(sil.error, undefined);
    assert.equal(storeOf(ctx.context).panelsOf(ctx.guild.id).length, 0);
  });

  it('an exact title wins over a longer title that contains it', async () => {
    const ctx = await withTitles(['Oyun', 'Oyun Rolleri']);
    assert.equal((await add(ctx, 'oyun')).error, undefined);
    const byTitle = Object.fromEntries(
      storeOf(ctx.context)
        .panelsOf(ctx.guild.id)
        .map((p) => [p.baslik, p]),
    );
    assert.equal(byTitle.Oyun.roller.length, 2);
    assert.equal(byTitle['Oyun Rolleri'].roller.length, 1);
  });

  it('several matches are refused and nothing changes', async () => {
    const ctx = await withTitles(['Oyun Rolleri', 'Oyun Kanalları']);
    const done = await add(ctx, 'oyun');
    assert.match(done.error.message, /Birden çok panel bulundu, listeden seçin/);
    assert.ok(
      storeOf(ctx.context)
        .panelsOf(ctx.guild.id)
        .every((p) => p.roller.length === 1),
    );
  });

  it('an unknown name says to pick from the suggestions', async () => {
    const ctx = await withTitles(['Oyun Rolleri']);
    for (const typed of ['Müzik', '🎮', '   ', 'zzzzzzzz'])
      assert.match((await add(ctx, typed)).error.message, /Bu adla bir rol paneli bulunamadı\. Panel adını yazarken/);
  });

  it('a panel of another server is never found', async () => {
    const ctx = await withTitles(['Oyun Rolleri']);
    const [panel] = storeOf(ctx.context).panelsOf(ctx.guild.id);
    const other = await setup();
    const done = await run(
      'ayar',
      slash(other.context, {
        userId: other.admin.id,
        group: 'rol-menusu',
        sub: 'ekle',
        values: { panel: panel.id, rol: other.guild.addRole({ position: 5 }) },
      }),
      other.context,
    );
    assert.match(done.error.message, /bulunamadı/);
  });

  it('a record whose message was deleted says "artık yok" for ekle, and can still be deleted', async () => {
    const ctx = await withTitles(['Oyun Rolleri']);
    const [panel] = storeOf(ctx.context).panelsOf(ctx.guild.id);
    const channel = await ctx.context.client.channels.fetch(panel.kanalId);
    await (await channel.messages.fetch(panel.mesajId)).delete();
    const done = await add(ctx, 'Oyun Rolleri');
    assert.match(done.error.message, /artık yok/);
    const sil = await run(
      'ayar',
      slash(ctx.context, { userId: ctx.admin.id, group: 'rol-menusu', sub: 'sil', values: { panel: 'Oyun Rolleri' } }),
      ctx.context,
    );
    assert.equal(sil.error, undefined);
  });

  it('autocomplete shows the title and channel, finds by the same loose match, and sends the id', async () => {
    const ctx = await withTitles(['🎮 Oyun Rolleri', 'Müzik']);
    const [oyun] = storeOf(ctx.context).panelsOf(ctx.guild.id);
    const interaction = slash(ctx.context, {
      userId: ctx.admin.id,
      group: 'rol-menusu',
      sub: 'ekle',
      values: { focused: 'OYUN ROLLERI' },
    });
    await commands.get('ayar').autocomplete(interaction, ctx.context);
    assert.deepEqual(interaction.calls.replies[0], [{ name: '🎮 Oyun Rolleri — #roller', value: oyun.id }]);
  });
});

describe('abuse limits', () => {
  it('every moderator permission keeps a role off a panel', async () => {
    const { guild, admin } = await setup();
    const { FORBIDDEN_ROLE_PERMISSIONS: DANGEROUS_PERMISSIONS } = await import('../src/ozellikler/_roller.js');
    const names = Object.entries(PermissionFlagsBits)
      .filter(([, bit]) => DANGEROUS_PERMISSIONS.includes(bit))
      .map(([name]) => name);
    for (const name of ['MoveMembers', 'MuteMembers', 'DeafenMembers', 'ManageThreads', 'ManageEvents', 'ViewAuditLog'])
      assert.ok(names.includes(name), name);
    for (const flag of DANGEROUS_PERMISSIONS) {
      const role = guild.addRole({ position: 5, permissions: [flag] });
      assert.match(roleProblem(role, guild, admin) ?? '', /izni var; bu izin/);
    }
  });

  it('one posting per person every 5 minutes, one ping per game every 15 minutes', async () => {
    const ctx = await setup();
    const role = ctx.guild.addRole({ name: 'PUBG', position: 10 });
    await run(
      'ayar',
      slash(ctx.context, {
        userId: ctx.admin.id,
        group: 'takim-ara',
        sub: 'oyun-rolu',
        values: { oyun: 'PUBG', rol: role },
      }),
      ctx.context,
    );
    const ali = ctx.guild.addMember({ name: 'Ali' });
    const veli = ctx.guild.addMember({ name: 'Veli' });
    const openAs = (member, oyun = 'PUBG') =>
      run(
        'oyun',
        slash(ctx.context, { userId: member.id, sub: 'ara', values: { oyun, kisi: 4 }, channel: ctx.text }),
        ctx.context,
      );
    const first = await openAs(ali);
    assert.deepEqual(first.calls.replies[0].allowedMentions, { roles: [role.id] });
    const [entry] = storeOf(ctx.context).ilanlar();
    await ctx.context.ozellikler.router.handle(
      fakeInteraction(ctx.context, { customId: `oz:roller-ve-ara:kapat:${entry.id}`, userId: ali.id }),
      ctx.context,
    );
    const again = await openAs(ali, 'LoL');
    assert.match(again.error?.message ?? '', /dakika bekleyin/);
    const other = await openAs(veli);
    assert.equal(other.error, undefined);
    assert.deepEqual(other.calls.replies[0].allowedMentions, { parse: [] }, 'the PUBG role was pinged 0 minutes ago');
    await ctx.clock.advance(15 * 60_000);
    const later = await openAs(ali);
    assert.equal(later.error, undefined);
    assert.deepEqual(later.calls.replies[0].allowedMentions, { roles: [role.id] });
  });
});
