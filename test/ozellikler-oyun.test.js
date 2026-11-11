// The /oyun tools: splitting a voice channel into teams (fair and even), reshuffle and move rules,
// "Takıma ekle", dice, picking, coin flips, polls (Discord's own Poll API) and the /oyun parent command.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { loadCommands } from '../src/commands/index.js';
import { ANKET, anketVerisi, ayir } from '../src/ozellikler/anket/index.js';
import { secenekleriAyir, yaziTura, zarAt, ZAR } from '../src/ozellikler/sans/index.js';
import {
  enKucugeEkle,
  kur,
  takimDeposu,
  takimlaraBol,
  createTeamStore,
  SAKLAMA_MS,
} from '../src/ozellikler/takim/index.js';
import { idsOf, makeContext, removeTempDirs, textOf } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const GUILD = '111111111111111111';
const VOICE = '222222222222222222';
const TEAM1 = '333333333333333331';
const TEAM2 = '333333333333333332';
const OWNER = '444444444444444444';
const BOT = '999999999999999999';
const people = (n) => Array.from({ length: n }, (_, i) => `5555555555555555${String(i).padStart(2, '0')}`);

/** A seeded generator, so a test can repeat thousands of splits quickly and the same way every run. */
function seeded(seed = 42) {
  let s = seed >>> 0;
  // mulberry32
  return (max) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

describe('team split', () => {
  it('everyone is in exactly one team and sizes differ by at most one', () => {
    for (let n = 2; n <= 23; n += 1) {
      for (let count = 2; count <= Math.min(4, n); count += 1) {
        const list = people(n);
        const { takimlar } = takimlaraBol(list, count);
        assert.equal(takimlar.length, count);
        assert.deepEqual(takimlar.flat().sort(), [...list].sort(), `${n}/${count}`);
        const sizes = takimlar.map((t) => t.length);
        assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${n}/${count}: ${sizes}`);
      }
    }
  });

  it('is fair: over many splits each person lands in each team about equally often', () => {
    const list = people(5);
    const random = seeded();
    const counts = list.map(() => [0, 0]);
    const runs = 4000;
    for (let i = 0; i < runs; i += 1) {
      const { takimlar } = takimlaraBol(list, 2, { random });
      takimlar.forEach((team, t) => team.forEach((id) => (counts[list.indexOf(id)][t] += 1)));
    }
    for (const [a, b] of counts) {
      assert.ok(Math.abs(a / runs - 0.5) < 0.05, `${a} vs ${b}`);
    }
  });

  it('with captains, every team gets one of its own members as captain; a duplicate id counts once', () => {
    const { takimlar, kaptanlar } = takimlaraBol([...people(7), people(7)[0]], 3, { kaptanli: true });
    assert.equal(takimlar.flat().length, 7);
    kaptanlar.forEach((captain, i) => assert.ok(takimlar[i].includes(captain)));
    assert.deepEqual(takimlaraBol(people(4), 2).kaptanlar, [null, null]);
    assert.throws(() => takimlaraBol(people(4), 5), RangeError);
  });

  it('"Takıma ekle" puts someone in the smallest team', () => {
    const teams = [['a', 'b'], ['c'], ['d', 'e']];
    assert.equal(enKucugeEkle(teams, 'x'), 1);
    assert.deepEqual(teams[1], ['c', 'x']);
  });

  it('lists are kept in memory for 3 hours only', () => {
    let now = 0;
    const store = createTeamStore({ now: () => now });
    const list = store.ekle({ guildId: GUILD, sahipId: OWNER, takimlar: [] });
    assert.equal(store.al(list.id).id, list.id);
    assert.equal(store.sonListe(GUILD, OWNER).id, list.id);
    now = SAKLAMA_MS + 1;
    assert.equal(store.al(list.id), null);
    assert.equal(store.sonListe(GUILD, OWNER), null);
  });
});

/** A guild with a voice channel holding `ids` (and the bot), plus two team channels. */
function fakeGuild(ids, { botCanMove = true, ownerCanJoin = true, blocked = [] } = {}) {
  const moved = [];
  const states = new Map(
    [...ids, BOT].map((id) => [
      id,
      {
        channelId: VOICE,
        member: { id, user: { bot: id === BOT }, blocked: blocked.includes(id) },
        async setChannel(channel) {
          moved.push([id, channel.id]);
          this.channelId = channel.id;
        },
      },
    ]),
  );
  const voice = (id) => ({
    id,
    type: ChannelType.GuildVoice,
    permissionsFor: (who) => ({
      has: () => (who === 'owner-member' ? ownerCanJoin : who?.id === BOT ? botCanMove : !who?.blocked),
    }),
  });
  return {
    moved,
    guild: {
      id: GUILD,
      voiceStates: { cache: states },
      members: { me: { id: BOT, permissions: { has: () => botCanMove } } },
      channels: { cache: new Map([VOICE, TEAM1, TEAM2].map((id) => [id, voice(id)])) },
    },
  };
}

function interactionIn(guild, { userId = OWNER, manage = false, move = false, customId } = {}) {
  const calls = { replies: [], updates: [], edits: [] };
  return {
    calls,
    customId,
    guildId: GUILD,
    guild,
    channelId: '666666666666666666',
    user: { id: userId },
    member: 'owner-member',
    memberPermissions: {
      has: (flag) =>
        (manage && flag === PermissionFlagsBits.ManageGuild) || (move && flag === PermissionFlagsBits.MoveMembers),
    },
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    deferred: false,
    replied: false,
    message: { id: '777777777777777777' },
    async reply(payload) {
      this.replied = true;
      calls.replies.push(payload);
      return { resource: { message: { id: '777777777777777777' } } };
    },
    async update(payload) {
      calls.updates.push(payload);
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      calls.edits.push(payload);
    },
    async followUp(payload) {
      calls.replies.push(payload);
    },
  };
}

const errorOf = (interaction) => interaction.calls.replies[0]?.embeds?.[0]?.toJSON().description ?? '';

describe('/oyun takim', () => {
  it('splits the voice channel (without bots) and posts the teams with persistent buttons', async () => {
    takimDeposu.temizle();
    const { guild } = fakeGuild([OWNER, ...people(4)]);
    const interaction = interactionIn(guild, { move: true });
    const list = await kur(interaction, { takimSayisi: 2, kaptanli: true, kanallar: [TEAM1, TEAM2] });
    assert.ok(!list.takimlar.flat().includes(BOT));
    assert.equal(list.takimlar.flat().length, 5);
    const payload = interaction.calls.replies[0];
    assert.deepEqual(idsOf(payload), [`oz:takim:karistir:${list.id}`, `oz:takim:tasi:${list.id}`]);
    assert.deepEqual(payload.allowedMentions, { parse: [] }, 'nobody is pinged');
    assert.match(textOf(payload), /👑/);
  });

  it('refuses when not in voice or when there are fewer people than teams', async () => {
    const { guild } = fakeGuild(people(1));
    await assert.rejects(kur(interactionIn(guild, { userId: '888888888888888888' })), /ses kanalına girin/);
    await assert.rejects(kur(interactionIn(fakeGuild([OWNER]).guild), { takimSayisi: 2 }), /en az 2 kişi/);
  });

  it('only the owner or "Sunucuyu Yönet" can reshuffle or move; moving needs the bot\'s permission', async () => {
    takimDeposu.temizle();
    const context = await makeContext();
    const { guild, moved } = fakeGuild([OWNER, ...people(3)]);
    const list = await kur(interactionIn(guild, { move: true }), { takimSayisi: 2, kanallar: [TEAM1, TEAM2] });

    const stranger = interactionIn(guild, { userId: people(3)[0], customId: `oz:takim:karistir:${list.id}` });
    await context.ozellikler.router.handle(stranger, context);
    assert.match(errorOf(stranger), /yalnız takımları kuran/);

    const shuffle = interactionIn(guild, { customId: `oz:takim:karistir:${list.id}` });
    await context.ozellikler.router.handle(shuffle, context);
    assert.equal(shuffle.calls.updates.length, 1);

    const move = interactionIn(guild, { customId: `oz:takim:tasi:${list.id}`, move: true });
    await context.ozellikler.router.handle(move, context);
    assert.equal(moved.length, 4);
    const current = takimDeposu.al(list.id);
    for (const [id, channelId] of moved) assert.equal(channelId, current.takimlar[0].includes(id) ? TEAM1 : TEAM2);
    assert.match(move.calls.edits[0].content, /4 kişi/);

    const noPerm = fakeGuild([OWNER, ...people(3)], { botCanMove: false });
    const list2 = await kur(interactionIn(noPerm.guild, { move: true }), { takimSayisi: 2, kanallar: [TEAM1, TEAM2] });
    const refused = interactionIn(noPerm.guild, { customId: `oz:takim:tasi:${list2.id}`, move: true });
    await context.ozellikler.router.handle(refused, context);
    assert.match(errorOf(refused), /Üyeleri Taşı/);
    assert.equal(noPerm.moved.length, 0);
  });

  it('a member without "Sunucuyu Yönet" cannot move people into a channel they cannot join', async () => {
    takimDeposu.temizle();
    const context = await makeContext();
    const { guild, moved } = fakeGuild([OWNER, ...people(3)], { ownerCanJoin: false });
    const list = await kur(interactionIn(guild, { move: true }), { takimSayisi: 2, kanallar: [TEAM1, TEAM2] });
    const move = interactionIn(guild, { customId: `oz:takim:tasi:${list.id}`, move: true });
    await context.ozellikler.router.handle(move, context);
    assert.match(errorOf(move), /bağlanma izniniz yok/);
    assert.equal(moved.length, 0);
  });

  it('moving needs "Üyeleri Taşı" or "Sunucuyu Yönet"; the owner alone cannot, nor ask for channels', async () => {
    takimDeposu.temizle();
    const context = await makeContext();
    const { guild, moved } = fakeGuild([OWNER, ...people(3)]);
    await assert.rejects(kur(interactionIn(guild), { takimSayisi: 2, kanallar: [TEAM1, TEAM2] }), /Üyeleri Taşı/);
    const list = await kur(interactionIn(guild, { move: true }), { takimSayisi: 2, kanallar: [TEAM1, TEAM2] });
    const owner = interactionIn(guild, { customId: `oz:takim:tasi:${list.id}` });
    await context.ozellikler.router.handle(owner, context);
    assert.match(errorOf(owner), /Üyeleri Taşı/);
    assert.equal(moved.length, 0);
    const admin = interactionIn(guild, {
      userId: '989898989898989898',
      manage: true,
      customId: `oz:takim:tasi:${list.id}`,
    });
    await context.ozellikler.router.handle(admin, context);
    assert.equal(moved.length, 4);
  });

  it('a member who may not join their team channel is skipped and counted; the bot lets nobody in', async () => {
    takimDeposu.temizle();
    const context = await makeContext();
    const blocked = people(3)[1];
    const { guild, moved } = fakeGuild([OWNER, ...people(3)], { blocked: [blocked] });
    const list = await kur(interactionIn(guild, { move: true }), { takimSayisi: 2, kanallar: [TEAM1, TEAM2] });
    const move = interactionIn(guild, { move: true, customId: `oz:takim:tasi:${list.id}` });
    await context.ozellikler.router.handle(move, context);
    assert.equal(moved.length, 3);
    assert.ok(!moved.some(([id]) => id === blocked));
    assert.match(move.calls.edits[0].content, /1 kişinin takım kanalına girme izni olmadığı/);
  });

  it('after a restart the old buttons say the list is gone', async () => {
    takimDeposu.temizle();
    const context = await makeContext();
    const interaction = interactionIn(fakeGuild([OWNER]).guild, { customId: 'oz:takim:karistir:abcdef0123' });
    await context.ozellikler.router.handle(interaction, context);
    assert.match(errorOf(interaction), /artık geçerli değil/);
  });

  it('"Takıma ekle" (right click) adds to the latest list of the one who clicks, never a bot', async () => {
    takimDeposu.temizle();
    const commands = await loadCommands();
    const command = commands.get('Takıma ekle');
    assert.equal(command.data.toJSON().type, 2);
    const { guild } = fakeGuild([OWNER, ...people(3)]);
    const list = await kur(interactionIn(guild), { takimSayisi: 2 });
    const target = '121212121212121212';
    const add = { ...interactionIn(guild), targetUser: { id: target, bot: false } };
    await command.execute(add, { client: { channels: { fetch: async () => null } } });
    assert.ok(takimDeposu.al(list.id).takimlar.flat().includes(target));
    assert.match(add.calls.replies[0].content, /eklendi/);
    await assert.rejects(command.execute({ ...add, targetUser: { id: target, bot: false } }, {}), /zaten bir takımda/);
    await assert.rejects(command.execute({ ...add, targetUser: { id: BOT, bot: true } }, {}), /Botlar/);
    const other = { ...interactionIn(guild, { userId: '343434343434343434' }), targetUser: { id: target } };
    await assert.rejects(command.execute(other, {}), /takım listesi yok/);
  });
});

describe('/oyun zar, sec, yazitura', () => {
  it('dice stay within their faces and limits', () => {
    const { sonuclar, toplam } = zarAt(6, 100);
    assert.equal(sonuclar.length, 100);
    assert.ok(sonuclar.every((n) => n >= 1 && n <= 6));
    assert.equal(
      toplam,
      sonuclar.reduce((a, b) => a + b),
    );
    assert.deepEqual(zarAt(1000, 1, () => 999).sonuclar, [1000]);
    assert.throws(() => zarAt(1, 1), RangeError);
    assert.throws(() => zarAt(6, ZAR.adetEnFazla + 1), RangeError);
  });

  it('"a | b | c" gives the options; too few is a Turkish error; coin flips both ways', () => {
    assert.deepEqual(secenekleriAyir(' pizza | döner || lahmacun '), ['pizza', 'döner', 'lahmacun']);
    assert.deepEqual(secenekleriAyir('pizza, döner,, lahmacun '), ['pizza', 'döner', 'lahmacun']);
    assert.deepEqual(secenekleriAyir('evet, belki | hayır\nolmaz'), ['evet, belki', 'hayır', 'olmaz']);
    assert.throws(() => secenekleriAyir('tek'), /seçenek yazın/);
    assert.equal(
      yaziTura(() => 0),
      'yazi',
    );
    assert.equal(
      yaziTura(() => 1),
      'tura',
    );
  });
});

describe('/oyun anket (Discord Poll API)', () => {
  it('single choice by default; votes can be changed in Discord, so the bot stores none', () => {
    const poll = anketVerisi({ soru: 'Ne zaman?', secenekler: ayir('Cuma | Cumartesi', '|') });
    assert.deepEqual(poll, {
      question: { text: 'Ne zaman?' },
      answers: [{ text: 'Cuma' }, { text: 'Cumartesi' }],
      duration: ANKET.varsayilanSure,
      allowMultiselect: false,
    });
    assert.equal(anketVerisi({ soru: 'x', secenekler: ['a', 'b'], coklu: true, sure: 768 }).allowMultiselect, true);
  });

  it('refuses what Discord would refuse: 2-10 options, 55 characters, 1-768 hours, duplicates', () => {
    const many = Array.from({ length: 11 }, (_, i) => `s${i}`);
    assert.throws(() => anketVerisi({ soru: 'x', secenekler: ['a'] }), /2-10 seçenek/);
    assert.throws(() => anketVerisi({ soru: 'x', secenekler: many }), /2-10 seçenek/);
    assert.throws(() => anketVerisi({ soru: 'x', secenekler: ['a', 'b'.repeat(56)] }), /55 karakter/);
    assert.throws(() => anketVerisi({ soru: 'x', secenekler: ['Evet', 'evet'] }), /iki kez/);
    assert.throws(() => anketVerisi({ soru: 'x', secenekler: ['a', 'b'], sure: 0 }), /1 ile 768/);
    assert.throws(() => anketVerisi({ soru: '', secenekler: ['a', 'b'] }), /Soru/);
    assert.deepEqual(ayir('a\nb\r\nc', /\r?\n/), ['a', 'b', 'c']);
  });

  it('the form from the menu sends a poll; a channel without "Send Polls" gets a Turkish error', async () => {
    const context = await makeContext();
    const replies = [];
    const fields = { soru: 'Hangi oyun?', secenekler: 'PUBG\nCS2\n\n', sure: '' };
    const modal = {
      customId: 'oz:anket:gonder',
      guildId: GUILD,
      user: { id: OWNER },
      isMessageComponent: () => false,
      isModalSubmit: () => true,
      appPermissions: { has: (flag) => flag === PermissionFlagsBits.SendPolls },
      fields: { getTextInputValue: (id) => fields[id] },
      async reply(payload) {
        replies.push(payload);
      },
    };
    await context.ozellikler.router.handle(modal, context);
    assert.deepEqual(
      replies[0].poll.answers.map((a) => a.text),
      ['PUBG', 'CS2'],
    );
    const denied = { ...modal, appPermissions: { has: () => false } };
    replies.length = 0;
    await context.ozellikler.router.handle(denied, context);
    assert.match(replies[0].embeds[0].toJSON().description, /Anket Oluştur/);
  });
});

describe('/oyun', () => {
  it('is one command whose subcommands come from five modules and run through their module', async () => {
    const commands = await loadCommands();
    const oyun = commands.get('oyun');
    const json = oyun.data.toJSON();
    assert.deepEqual(json.options.map((o) => o.name).sort(), [
      'anket',
      'ara',
      'cekilis',
      'sec',
      'takim',
      'yazitura',
      'zar',
    ]);
    assert.ok(json.options.every((o) => o.type === 1 && o.description.length <= 100));
    assert.equal(oyun.kategori, 'oyun');
    const replies = [];
    await oyun.execute(
      {
        options: { getSubcommand: () => 'zar', getInteger: (n) => (n === 'yuz' ? 20 : 3) },
        user: { id: OWNER },
        async reply(payload) {
          replies.push(payload);
        },
      },
      { ozellikler: { disabledReason: () => null } },
    );
    assert.match(replies[0].embeds[0].toJSON().description, /\*\*3d20\*\*/);
    assert.equal(oyun.statName({ options: { getSubcommand: () => 'zar' } }), 'zar');
  });
});
