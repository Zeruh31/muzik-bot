// Temporary voice rooms: joining "➕ Oda aç" opens "{name} odası" and moves the member there, an empty room
// is deleted 10 seconds later (and never any channel the bot did not open), ownership passes on when the owner
// leaves, rooms that emptied while the bot was off are swept on login, one room per person and a cool-down.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { deleteIfEmpty, isOpening, isOwnRoom, roomName, storeOf } from '../src/ozellikler/gecici-oda/index.js';
import {
  BOT,
  errorOf,
  fakeInteraction,
  fakeOverwrite,
  flush,
  makeLiveContext,
  perms,
  until,
} from './yardimci/discordSahte.js';
import { fakeClock, idsOf, removeTempDirs, textOf } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

async function setup({ dir, clock = fakeClock(), guild } = {}) {
  const context = await makeLiveContext({ dir, clock, guild });
  const g = context.guild;
  let hub = [...g.channels.cache.values()].find((c) => c.name === '➕ Oda aç');
  let category = [...g.channels.cache.values()].find((c) => c.type === ChannelType.GuildCategory);
  if (!hub) {
    category = g.addCategory('Odalar');
    hub = g.addVoice('➕ Oda aç', category.id);
  }
  context.ozellikler.ayarlar.set(g.id, 'gecici-oda', 'kanal', hub.id);
  return { context, guild: g, hub, category, clock };
}

const roomsOf = (context) => storeOf(context).all();
/** Joins the hub and waits until the room (if any) is fully opened. */
async function joinHub(context, guild, userId, hub) {
  await guild.move(userId, hub.id);
  await until(() => !isOpening(context));
}

describe('temporary rooms: open and delete', () => {
  it('joining the hub opens "{name} odası" in its category, moves the member and posts the controls', async () => {
    const { context, guild, hub, category } = await setup();
    const ali = guild.addMember({ name: 'Ali' });
    await joinHub(context, guild, ali.id, hub);
    const [room] = roomsOf(context);
    assert.ok(room, 'the room is recorded');
    const channel = guild.channels.cache.get(room.id);
    assert.ok(await until(() => channel.sent.length > 0 && storeOf(context).get(room.id).kontrolMesajId));
    assert.equal(channel.name, 'Ali odası');
    assert.equal(channel.parentId, category.id);
    assert.equal(guild.voiceStates.cache.get(ali.id).channelId, room.id);
    assert.equal(room.sahipId, ali.id);
    const controls = channel.sent[0];
    assert.match(textOf(controls), new RegExp(`<@${ali.id}>`));
    assert.deepEqual(idsOf(controls), [
      `oz:gecici-oda:ad:${room.id}`,
      `oz:gecici-oda:limit:${room.id}`,
      `oz:gecici-oda:kilit:${room.id}`,
      `oz:gecici-oda:at:${room.id}`,
      `oz:gecici-oda:devret:${room.id}`,
    ]);
  });

  it('an empty room is deleted 10 seconds later; coming back in time keeps it', async () => {
    const { context, guild, hub, clock } = await setup();
    const ali = guild.addMember({ name: 'Ali' });
    await joinHub(context, guild, ali.id, hub);
    const [room] = roomsOf(context);
    const channel = guild.channels.cache.get(room.id);
    await guild.move(ali.id, null);
    await clock.advance(5_000);
    await guild.move(ali.id, room.id); // back within 10 s: the delete is cancelled
    await clock.advance(20_000);
    assert.equal(channel.deleted, false);
    await guild.move(ali.id, null);
    await clock.advance(9_999);
    assert.equal(channel.deleted, false);
    await clock.advance(1);
    await flush();
    assert.equal(channel.deleted, true);
    assert.deepEqual(roomsOf(context), []);
  });

  it('never deletes a channel it did not open, even an empty one', async () => {
    const { context, guild, hub, clock } = await setup();
    const other = guild.addVoice('Sohbet');
    const ali = guild.addMember({ name: 'Ali' });
    await guild.move(ali.id, other.id);
    await guild.move(ali.id, null);
    await clock.advance(60_000);
    assert.equal(other.deleted, false);
    assert.equal(await deleteIfEmpty(context, other.id), false);
    assert.equal(await deleteIfEmpty(context, hub.id), false);
    assert.equal(other.deleted, false);
    assert.equal(hub.deleted, false);
  });

  it('a record pointing to a channel of another guild is not deleted there', async () => {
    const { context, guild } = await setup();
    const foreign = guild.addVoice('Yabancı');
    foreign.guildId = '999999999999999999';
    storeOf(context).add({ id: foreign.id, guildId: guild.id, sahipId: '123456789012345678' });
    assert.equal(await deleteIfEmpty(context, foreign.id), false);
    assert.equal(foreign.deleted, false);
  });
  it('a record whose channel is not a voice channel, sits elsewhere or is too new or old is dropped, not deleted', async () => {
    const { context, guild, hub, clock } = await setup();
    const ali = guild.addMember({ name: 'Ali' });
    await joinHub(context, guild, ali.id, hub);
    const [room] = roomsOf(context);
    const channel = guild.channels.cache.get(room.id);
    const cases = [
      ['type', (c) => (c.type = ChannelType.GuildText)],
      ['category', (c) => (c.parentId = guild.addCategory('Başka').id)],
    ];
    for (const [name, change] of cases) {
      const copy = { ...channel };
      change(copy);
      assert.equal(isOwnRoom(room, copy), false, name);
    }
    assert.equal(isOwnRoom({ ...room, olusma: room.olusma + 60 * 60_000 }, channel), false, 'time');
    assert.equal(isOwnRoom(room, channel), true);
    // A record of an old channel the bot did not make now (e.g. a copied data/ file) is forgotten, the channel kept.
    const old = guild.addVoice('Eski');
    storeOf(context).add({ id: old.id, guildId: guild.id, sahipId: ali.id, olusma: clock.now() });
    assert.equal(await deleteIfEmpty(context, old.id), false);
    assert.equal(old.deleted, false);
    assert.equal(storeOf(context).get(old.id), null);
    channel.type = ChannelType.GuildText;
    await guild.move(ali.id, null);
    await clock.advance(10_000);
    await flush();
    assert.equal(channel.deleted, false);
    assert.deepEqual(roomsOf(context), []);
  });

  it('with "bekleme" 0, joining twice at once still opens one room', async () => {
    const { context, guild, hub } = await setup();
    context.ozellikler.ayarlar.set(guild.id, 'gecici-oda', 'bekleme', 0);
    const ali = guild.addMember({ name: 'Ali' });
    const first = guild.move(ali.id, hub.id);
    const second = guild.move(ali.id, hub.id);
    await Promise.all([first, second]);
    await until(() => !isOpening(context));
    assert.equal(roomsOf(context).length, 1);
    assert.equal([...guild.channels.cache.values()].filter((c) => c.name === 'Ali odası').length, 1);
  });
});

describe('temporary rooms: owner, limits and restart', () => {
  it('when the owner leaves, someone still inside becomes the owner', async () => {
    const { context, guild, hub } = await setup();
    const ali = guild.addMember({ name: 'Ali' });
    const ayse = guild.addMember({ name: 'Ayşe' });
    await joinHub(context, guild, ali.id, hub);
    const [room] = roomsOf(context);
    await guild.move(ayse.id, room.id);
    await guild.move(ali.id, null);
    assert.equal(storeOf(context).get(room.id).sahipId, ayse.id);
    const channel = guild.channels.cache.get(room.id);
    assert.match(channel.sent.at(-1).content, new RegExp(`<@${ayse.id}>`));
    assert.match(textOf(channel.edits.at(-1).p), new RegExp(`Sahip: <@${ayse.id}>`));
    assert.equal(channel.deleted, false);
  });

  it('one room per person, and a cool-down before the next one', async () => {
    const { context, guild, hub, clock } = await setup();
    const ali = guild.addMember({ name: 'Ali' });
    await joinHub(context, guild, ali.id, hub);
    const [room] = roomsOf(context);
    await joinHub(context, guild, ali.id, hub); // back to the hub: sent to the own room again
    assert.equal(roomsOf(context).length, 1);
    assert.equal(guild.voiceStates.cache.get(ali.id).channelId, room.id);
    await guild.move(ali.id, null);
    await clock.advance(10_000);
    await flush();
    assert.deepEqual(roomsOf(context), []);
    await joinHub(context, guild, ali.id, hub); // 10 s after the first room: still in the 30 s cool-down
    assert.deepEqual(roomsOf(context), []);
    assert.match(hub.sent.at(-1).content, /saniye bekleyin/);
    await clock.advance(30_000);
    await guild.move(ali.id, null);
    await joinHub(context, guild, ali.id, hub);
    assert.equal(roomsOf(context).length, 1);
  });

  it('after a restart, rooms that emptied while the bot was off are deleted and lost ones forgotten', async () => {
    const first = await setup();
    const { guild, hub } = first;
    const ali = guild.addMember({ name: 'Ali' });
    const veli = guild.addMember({ name: 'Veli' });
    await joinHub(first.context, guild, ali.id, hub);
    await joinHub(first.context, guild, veli.id, hub);
    const [aliRoom, veliRoom] = roomsOf(first.context).map((r) => guild.channels.cache.get(r.id));
    first.context.ozellikler.kapat();
    // While the bot was off: Ali left, Veli's room was deleted by hand.
    guild.voiceStates.cache.delete(ali.id);
    guild.channels.cache.delete(veliRoom.id);
    const again = await makeLiveContext({ dir: first.context.dir, guild });
    again.client.emit(Events.ClientReady);
    await flush();
    assert.equal(aliRoom.deleted, true);
    assert.deepEqual(storeOf(again).all(), []);
    assert.equal(hub.deleted, false);
  });

  it('names stay within Discord limits and without control characters', () => {
    assert.equal(roomName('Ali\u0007'), 'Ali odası');
    assert.ok(roomName('x'.repeat(300)).length <= 100);
    assert.ok(roomName('x'.repeat(300)).endsWith(' odası'));
  });
});

describe('temporary rooms: owner controls', () => {
  async function withRoom() {
    const ctx = await setup();
    const ali = ctx.guild.addMember({ name: 'Ali' });
    const ayse = ctx.guild.addMember({ name: 'Ayşe' });
    await joinHub(ctx.context, ctx.guild, ali.id, ctx.hub);
    const [room] = roomsOf(ctx.context);
    await ctx.guild.move(ayse.id, room.id);
    return { ...ctx, ali, ayse, room, channel: ctx.guild.channels.cache.get(room.id) };
  }
  const route = async (context, interaction) => {
    await context.ozellikler.router.handle(interaction, context);
    return interaction;
  };

  it('only the owner (or "Sunucuyu Yönet") can use them', async () => {
    const { context, ayse, room } = await withRoom();
    const click = await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:kilit:${room.id}`, userId: ayse.id }),
    );
    assert.match(errorOf(click), /yalnız odanın sahibi/);
    assert.equal(storeOf(context).get(room.id).kilitli, false);
  });

  it('lock denies Connect to @everyone and to every overwrite that allowed it; unlock restores exactly', async () => {
    const { context, guild, ali, ayse, room, channel } = await withRoom();
    // As if copied from the category: @everyone may not see, a role and an outsider may connect (and speak).
    const role = guild.addRole({ name: 'Üye' });
    const outsider = guild.addMember({ name: 'Dışarıdaki' });
    const cache = channel.permissionOverwrites.cache;
    cache.set(guild.id, fakeOverwrite(guild.id, 0, { deny: [PermissionFlagsBits.ViewChannel] }));
    cache.set(role.id, fakeOverwrite(role.id, 0, { allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }));
    cache.set(outsider.id, fakeOverwrite(outsider.id, 1, { allow: [PermissionFlagsBits.Connect] }));
    const before = structuredClone([...cache.entries()]);
    const click = () =>
      route(context, fakeInteraction(context, { customId: `oz:gecici-oda:kilit:${room.id}`, userId: ali.id }));
    const lock = await click();
    assert.equal(storeOf(context).get(room.id).kilitli, true);
    assert.match(textOf(lock.calls.updates[0]), /Kilitli/);
    const connect = (id) => {
      const o = cache.get(id);
      if ((o.allow.bitfield & PermissionFlagsBits.Connect) !== 0n) return true;
      return (o.deny.bitfield & PermissionFlagsBits.Connect) !== 0n ? false : null;
    };
    for (const id of [guild.id, role.id, outsider.id]) assert.equal(connect(id), false, id);
    for (const id of [ali.id, ayse.id, BOT]) assert.equal(connect(id), true, id);
    assert.equal(
      cache.get(role.id).allow.bitfield & PermissionFlagsBits.Speak,
      PermissionFlagsBits.Speak,
      'Speak kept',
    );
    assert.equal(cache.get(guild.id).deny.bitfield & PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ViewChannel);
    await click();
    assert.deepEqual(structuredClone([...cache.entries()]), before, 'everything the lock touched is back as it was');
    assert.equal(storeOf(context).get(room.id).kilitli, false);
  });

  it('a member kicked while the room is locked stays barred after unlocking', async () => {
    const { context, ali, ayse, room, channel } = await withRoom();
    const kilit = `oz:gecici-oda:kilit:${room.id}`;
    await route(context, fakeInteraction(context, { customId: kilit, userId: ali.id }));
    await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:at:${room.id}`, userId: ali.id, values: [ayse.id] }),
    );
    await route(context, fakeInteraction(context, { customId: kilit, userId: ali.id }));
    const o = channel.permissionOverwrites.cache.get(ayse.id);
    assert.equal(o.deny.bitfield & PermissionFlagsBits.Connect, PermissionFlagsBits.Connect);
  });

  it('unlocking skips an overwrite whose role was deleted meanwhile and the room is unlocked anyway', async () => {
    const { context, guild, ali, room, channel } = await withRoom();
    const role = guild.addRole({ name: 'Silinecek' });
    channel.permissionOverwrites.cache.set(
      role.id,
      fakeOverwrite(role.id, 0, { allow: [PermissionFlagsBits.Connect] }),
    );
    const kilit = `oz:gecici-oda:kilit:${room.id}`;
    await route(context, fakeInteraction(context, { customId: kilit, userId: ali.id }));
    const create = channel.permissionOverwrites.create;
    channel.permissionOverwrites.create = async (id, ...rest) => {
      if (id === role.id) throw Object.assign(new Error('Unknown Role'), { code: 10011 });
      return create(id, ...rest);
    };
    const unlock = await route(context, fakeInteraction(context, { customId: kilit, userId: ali.id }));
    assert.equal(errorOf(unlock), '');
    assert.equal(storeOf(context).get(room.id).kilitli, false);
    const everyone = channel.permissionOverwrites.cache.get(guild.id);
    assert.equal(everyone, undefined, 'the @everyone deny the lock added is gone');
  });

  it('a kick target that is not cached is fetched; when it cannot be, the kick is refused', async () => {
    const { context, guild, ali, room } = await withRoom();
    const mod = guild.addMember({ name: 'Mod' });
    mod.permissions = perms([PermissionFlagsBits.ManageGuild]);
    guild.members.cache.delete(mod.id);
    guild.members.fetch = async (id) => {
      if (id === mod.id) return mod;
      throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    };
    const kickMod = await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:at:${room.id}`, userId: ali.id, values: [mod.id] }),
    );
    assert.match(errorOf(kickMod), /atılamaz/);
    const kickNobody = await route(
      context,
      fakeInteraction(context, {
        customId: `oz:gecici-oda:at:${room.id}`,
        userId: ali.id,
        values: ['123456789012345678'],
      }),
    );
    assert.match(errorOf(kickNobody), /bulunamadı/);
  });

  it('the owner cannot kick moderators ("Sunucuyu Yönet" / "Üyeleri Taşı") or bots', async () => {
    const { context, guild, ali, room } = await withRoom();
    const mod = guild.addMember({ name: 'Mod' });
    mod.permissions = perms([PermissionFlagsBits.MoveMembers]);
    const bot = guild.addMember({ name: 'Bot', bot: true });
    for (const target of [mod, bot]) {
      await guild.move(target.id, room.id);
      const kick = await route(
        context,
        fakeInteraction(context, { customId: `oz:gecici-oda:at:${room.id}`, userId: ali.id, values: [target.id] }),
      );
      assert.match(errorOf(kick), /atılamaz|bot seçilemez/);
      assert.equal(guild.voiceStates.cache.get(target.id).channelId, room.id);
    }
  });

  it('kick disconnects and bars; hand over makes the picked member the owner', async () => {
    const { context, guild, ali, ayse, room, channel } = await withRoom();
    await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:at:${room.id}`, userId: ali.id, values: [ayse.id] }),
    );
    assert.equal(guild.voiceStates.cache.get(ayse.id), undefined);
    assert.deepEqual(channel.overwrites.at(-1), { target: ayse.id, options: { Connect: false } });
    const notIn = await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:devret:${room.id}`, userId: ali.id, values: [ayse.id] }),
    );
    assert.match(errorOf(notIn), /bu odada değil/);
    await guild.move(ayse.id, room.id);
    await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:devret:${room.id}`, userId: ali.id, values: [ayse.id] }),
    );
    assert.equal(storeOf(context).get(room.id).sahipId, ayse.id);
  });

  it('rename goes through a form; Discord allows two renames in ten minutes', async () => {
    const { context, ali, room, channel, clock } = await withRoom();
    const open = await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:ad:${room.id}`, userId: ali.id }),
    );
    assert.equal(open.calls.modals.length, 1);
    const rename = (name) =>
      route(
        context,
        fakeInteraction(context, {
          customId: `oz:gecici-oda:ad-kaydet:${room.id}`,
          userId: ali.id,
          fields: { deger: name },
        }),
      );
    await rename('Rank odası');
    await rename('Gece odası');
    const third = await rename('Üçüncü');
    assert.equal(channel.name, 'Gece odası');
    assert.match(errorOf(third), /10 dakikada en fazla 2/);
    await clock.advance(10 * 60_000);
    await rename('Üçüncü');
    assert.equal(channel.name, 'Üçüncü');
    const limit = await route(
      context,
      fakeInteraction(context, {
        customId: `oz:gecici-oda:limit-kaydet:${room.id}`,
        userId: ali.id,
        fields: { deger: '5' },
      }),
    );
    assert.equal(channel.userLimit, 5);
    assert.match(limit.calls.replies[0].content, /5/);
  });

  it('a button of a channel the bot did not open is refused', async () => {
    const { context, ali, hub } = await withRoom();
    const click = await route(
      context,
      fakeInteraction(context, { customId: `oz:gecici-oda:kilit:${hub.id}`, userId: ali.id, manage: true }),
    );
    assert.match(errorOf(click), /artık yok ya da bot tarafından açılmadı/);
    assert.equal(hub.overwrites.length, 0);
  });
});
