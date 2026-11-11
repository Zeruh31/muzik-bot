// The control center: which sections a viewer sees (/menu), Discord's Components V2 limits, the
// section picker, and the fixed panel (reconnecting after a restart, re-creating a deleted message,
// throttled live updates).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MessageFlags, PermissionFlagsBits, RESTJSONErrorCodes } from 'discord.js';
import { planIntents } from '../src/ozellikler/_intentler.js';
import { createOzellikler, loadModules } from '../src/ozellikler/index.js';
import { buildMenu, countComponents, isVisible, MAX_COMPONENTS, viewerOf } from '../src/ozellikler/menu/merkez.js';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const DJ = '444444444444444444';
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'muzikbot-menu-'));
  dirs.push(dir);
  return dir;
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const PLAYING = {
  current: {
    title: 'Şarkı',
    author: 'Sanatçı',
    uri: 'https://example.com/s',
    duration: 200_000,
    isStream: false,
    artworkUrl: 'https://example.com/a.jpg',
    requester: { id: '555555555555555555' },
  },
  paused: false,
  repeatMode: 'off',
  hasPrevious: true,
  queue: [{ title: 'Sıradaki', author: 'B', uri: 'https://example.com/b', duration: 1000 }],
  position: 10_000,
  positionAt: 1_700_000_000_000,
};

/** A clock driven by the test. */
function fakeClock() {
  let now = 1_000_000;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimeout(fn, ms) {
      timers.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          await t.fn();
        }
      }
    },
  };
}

/** A fake text channel whose messages can be fetched, edited and deleted. */
function fakeChannel(id = CHANNEL) {
  const messages = new Map();
  let nextId = 700000000000000000n;
  const channel = {
    id,
    sent: [],
    messages: {
      async fetch(messageId) {
        const message = messages.get(messageId);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: RESTJSONErrorCodes.UnknownMessage });
        return message;
      },
    },
    async send(payload) {
      const message = {
        id: String(nextId++),
        payload,
        edits: [],
        async edit(next) {
          if (!messages.has(this.id))
            throw Object.assign(new Error('Unknown Message'), { code: RESTJSONErrorCodes.UnknownMessage });
          this.edits.push(next);
        },
        async delete() {
          messages.delete(this.id);
        },
      };
      messages.set(message.id, message);
      channel.sent.push(message);
      return message;
    },
    messageMap: messages,
  };
  return channel;
}

async function makeContext({ state = null, channels = new Map(), dir = tempDir(), clock } = {}) {
  const music = Object.assign(new EventEmitter(), { getState: () => state });
  const context = {
    music,
    settings: { getDjRole: () => null },
    playlists: { list: () => [] },
    client: {
      guilds: { cache: new Map() },
      channels: {
        async fetch(id) {
          if (!channels.has(id))
            throw Object.assign(new Error('Unknown Channel'), { code: RESTJSONErrorCodes.UnknownChannel });
          return channels.get(id);
        },
      },
    },
  };
  const modules = await loadModules();
  createOzellikler({
    context,
    modules,
    intentPlan: planIntents(modules),
    files: {
      ayarlar: join(dir, 'ozellikler.json'),
      zamanlayici: join(dir, 'zamanlayici.json'),
      paneller: join(dir, 'paneller.json'),
    },
    clock,
    logger: silent,
  });
  return { context, music, dir };
}

const asker = ({ manage = false, roles = [] } = {}) => ({
  guildId: GUILD,
  guild: null,
  user: { id: '666666666666666666' },
  member: { roles },
  memberPermissions: { has: (flag) => manage && flag === PermissionFlagsBits.ManageGuild },
});

/** Every custom_id in a message's component JSON. */
function customIds(list, out = []) {
  for (const c of list ?? []) {
    if (c.custom_id) out.push(c.custom_id);
    customIds(c.components, out);
    if (c.accessory) customIds([c.accessory], out);
  }
  return out;
}

describe('/menu', () => {
  it('members see music, games and levels; "Sunucuyu Yönet" also sees Bildirimler, Karşılama and Ayarlar', async () => {
    const { context } = await makeContext({ state: PLAYING });
    const member = buildMenu(context, viewerOf(asker(), context));
    assert.deepEqual(member.sections, ['muzik', 'oyun', 'seviye']);
    const admin = buildMenu(context, viewerOf(asker({ manage: true }), context));
    assert.deepEqual(admin.sections, ['muzik', 'oyun', 'seviye', 'bildirimler', 'karsilama', 'ayarlar']);
    assert.equal(admin.shown, 'muzik');
    const json = admin.payload.components.map((c) => c.toJSON());
    assert.ok(customIds(json).includes('oz:menu:bolum'), 'the section picker');
    const picker = member.payload.components[0].toJSON().components.find((c) => c.type === 1).components[0];
    assert.deepEqual(
      picker.options.map((o) => [o.value, o.label]),
      [
        ['muzik', 'Müzik'],
        ['oyun', 'Oyun'],
        ['seviye', 'Seviye'],
      ],
    );
  });

  it('"Oyun" gathers the sections of takım, şans and anket (çekiliş only for "Sunucuyu Yönet")', async () => {
    const { context } = await makeContext({ state: PLAYING });
    const idsOf = (payload) => customIds(payload.components.map((c) => c.toJSON()));
    const member = idsOf(buildMenu(context, viewerOf(asker(), context), { bolum: 'oyun' }).payload);
    for (const id of ['oz:takim:kur:2', 'oz:takim:kur:4', 'oz:sans:zar', 'oz:sans:yazitura', 'oz:anket:ac'])
      assert.ok(member.includes(id), id);
    assert.ok(!member.includes('oz:cekilis:ac'));
    const admin = idsOf(buildMenu(context, viewerOf(asker({ manage: true }), context), { bolum: 'oyun' }).payload);
    assert.ok(admin.includes('oz:cekilis:ac'));
    const bildirim = idsOf(
      buildMenu(context, viewerOf(asker({ manage: true }), context), { bolum: 'bildirimler' }).payload,
    );
    assert.deepEqual(
      bildirim.filter((id) => id !== 'oz:menu:bolum'),
      ['oz:ucretsiz-oyunlar:kontrol'],
    );
  });

  it('is ephemeral Components V2 within Discord limits, with persistent ids only', async () => {
    const { context } = await makeContext({ state: PLAYING });
    for (const bolum of ['muzik', 'oyun', 'bildirimler', 'ayarlar']) {
      const { payload } = buildMenu(context, viewerOf(asker({ manage: true }), context), { bolum });
      assert.equal(payload.flags & MessageFlags.IsComponentsV2, MessageFlags.IsComponentsV2);
      assert.equal(payload.flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
      assert.equal(payload.content, undefined);
      assert.equal(payload.embeds, undefined);
      const json = payload.components.map((c) => c.toJSON());
      assert.ok(countComponents(json) <= MAX_COMPONENTS, `${bolum}: ${countComponents(json)}`);
      for (const id of customIds(json)) {
        assert.ok(id.length <= 100 && id.startsWith('oz:'), id);
      }
      for (const row of json[0].components.filter((c) => c.type === 1)) assert.ok(row.components.length <= 5);
    }
  });

  it('the music section reuses the now-playing controls with its own ids', async () => {
    const { context } = await makeContext({ state: PLAYING });
    const { payload } = buildMenu(context, viewerOf(asker(), context));
    const ids = customIds(payload.components.map((c) => c.toJSON()));
    for (const action of ['previous', 'toggle', 'skip', 'stop', 'loop', 'shuffle'])
      assert.ok(ids.includes(`oz:muzik:k:${action}`));
    for (const id of ['oz:muzik:ekle', 'oz:muzik:kuyruk', 'oz:muzik:listeler', 'oz:muzik:gecmis-ac'])
      assert.ok(ids.includes(id));
    const text = JSON.stringify(payload.components[0].toJSON());
    assert.match(text, /Şimdi çalıyor/);
    assert.match(text, /Sırada 1 şarkı/);
  });

  it('nothing playing: controls are disabled but "Şarkı ekle" works', async () => {
    const { context } = await makeContext({ state: null });
    const json = buildMenu(context, viewerOf(asker(), context)).payload.components[0].toJSON();
    const buttons = json.components.filter((c) => c.type === 1).flatMap((r) => r.components);
    assert.ok(buttons.find((b) => b.custom_id === 'oz:muzik:k:skip').disabled);
    assert.ok(!buttons.find((b) => b.custom_id === 'oz:muzik:ekle').disabled);
  });

  it('picking "Ayarlar" without the permission shows music instead (checked again on every click)', async () => {
    const { context } = await makeContext({ state: PLAYING });
    const interaction = {
      ...asker(),
      customId: 'oz:menu:bolum',
      values: ['ayarlar'],
      updates: [],
      async update(payload) {
        this.updates.push(payload);
      },
    };
    assert.equal(await context.ozellikler.router.handle(interaction, context), true);
    const text = JSON.stringify(interaction.updates[0].components[0].toJSON());
    assert.doesNotMatch(text, /Kalıcı panel/);
    assert.match(text, /Şimdi çalıyor/);
    assert.equal(interaction.updates[0].flags, MessageFlags.IsComponentsV2, 'an edit carries no ephemeral flag');
  });

  it('visibility rules', () => {
    const member = { canManageGuild: false, isDj: false };
    assert.equal(isVisible({ gorunurluk: 'herkes' }, member), true);
    assert.equal(isVisible({ gorunurluk: 'dj' }, member), false);
    assert.equal(isVisible({ gorunurluk: 'dj' }, { ...member, isDj: true }), true);
    assert.equal(isVisible({ gorunurluk: 'yonetici' }, { canManageGuild: true }), true);
    assert.equal(isVisible({ gorunurluk: 'dj' }, { herkes: true, isDj: true }), false, 'the public panel');
  });

  it('a DJ role decides the "dj" visibility', async () => {
    const { context } = await makeContext();
    context.settings = { getDjRole: () => DJ };
    assert.equal(viewerOf(asker(), context).isDj, false);
    assert.equal(viewerOf(asker({ roles: [DJ] }), context).isDj, true);
    assert.equal(viewerOf(asker({ manage: true }), context).isDj, true);
  });
});

describe('fixed control panel', () => {
  it('is set up in a channel and its message id is stored in data/paneller.json', async () => {
    const channel = fakeChannel();
    const { context, dir } = await makeContext({ state: PLAYING, channels: new Map([[CHANNEL, channel]]) });
    await context.ozellikler.panel.kur(GUILD, CHANNEL);
    assert.equal(channel.sent.length, 1);
    const saved = JSON.parse(readFileSync(join(dir, 'paneller.json'), 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.deepEqual(saved.paneller[GUILD], { channelId: CHANNEL, messageId: channel.sent[0].id });
    const { payload } = channel.sent[0];
    assert.equal(payload.flags, MessageFlags.IsComponentsV2, 'public, not ephemeral');
    const ids = customIds(payload.components.map((c) => c.toJSON()));
    assert.ok(ids.includes('oz:menu:ac'));
    assert.ok(
      !JSON.stringify(payload.components[0].toJSON()).includes('Kalıcı panel'),
      'no admin section on the public panel',
    );
    assert.ok(!ids.some((id) => /^oz:(takim|sans|anket|cekilis|ucretsiz-oyunlar):/.test(id)), 'games stay in /menu');
  });

  it('after a restart it reconnects to the same message instead of sending a new one', async () => {
    const dir = tempDir();
    const channel = fakeChannel();
    const channels = new Map([[CHANNEL, channel]]);
    const first = await makeContext({ state: null, channels, dir });
    await first.context.ozellikler.panel.kur(GUILD, CHANNEL);
    const messageId = channel.sent[0].id;
    first.context.ozellikler.kapat();

    const second = await makeContext({ state: PLAYING, channels, dir });
    const results = await second.context.ozellikler.panel.baglan();
    assert.deepEqual(results, { [GUILD]: 'baglandi' });
    assert.equal(channel.sent.length, 1, 'no new message');
    assert.equal(channel.sent[0].edits.length, 1, 'the old message shows the current song');
    assert.equal(second.context.ozellikler.panel.mesajOf(GUILD), messageId);
    second.context.ozellikler.kapat();
  });

  it('a deleted panel message is sent again; a deleted channel removes the panel', async () => {
    const dir = tempDir();
    const channel = fakeChannel();
    writeFileSync(
      join(dir, 'paneller.json'),
      JSON.stringify({
        schemaVersion: 1,
        paneller: {
          [GUILD]: { channelId: CHANNEL, messageId: '123456789012345678' },
          '888888888888888888': { channelId: '777777777777777777', messageId: '123456789012345679' },
        },
      }),
    );
    const { context } = await makeContext({ state: null, channels: new Map([[CHANNEL, channel]]), dir });
    const results = await context.ozellikler.panel.baglan();
    assert.deepEqual(results, { [GUILD]: 'yeniden-olusturuldu', '888888888888888888': 'kanal-yok' });
    assert.equal(channel.sent.length, 1);
    const saved = JSON.parse(readFileSync(join(dir, 'paneller.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved.paneller), [GUILD]);
    assert.equal(saved.paneller[GUILD].messageId, channel.sent[0].id);
    context.ozellikler.kapat();
  });

  it('lost access (a permission change) keeps the stored panel instead of deleting or re-sending it', async () => {
    const dir = tempDir();
    const stored = {
      schemaVersion: 1,
      paneller: {
        [GUILD]: { channelId: CHANNEL, messageId: '123456789012345678' },
        '888888888888888888': { channelId: '777777777777777777', messageId: '123456789012345679' },
      },
    };
    writeFileSync(join(dir, 'paneller.json'), JSON.stringify(stored));
    const noHistory = fakeChannel();
    noHistory.messages.fetch = async () => {
      throw Object.assign(new Error('Missing Access'), { code: RESTJSONErrorCodes.MissingAccess });
    };
    const { context } = await makeContext({ channels: new Map([[CHANNEL, noHistory]]), dir });
    const fetchChannel = context.client.channels.fetch;
    context.client.channels.fetch = async (id) => {
      if (id === '777777777777777777') {
        throw Object.assign(new Error('Missing Access'), { code: RESTJSONErrorCodes.MissingAccess });
      }
      return fetchChannel(id);
    };
    const results = await context.ozellikler.panel.baglan();
    assert.deepEqual(results, { [GUILD]: 'erisim-yok', '888888888888888888': 'erisim-yok' });
    assert.equal(noHistory.sent.length, 0, 'no second panel');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'paneller.json'), 'utf8')), stored);
    context.ozellikler.kapat();
  });

  it('/ayar panel refuses a channel where the bot cannot read message history', async () => {
    const { context } = await makeContext({ channels: new Map([[CHANNEL, fakeChannel()]]) });
    const command = context.ozellikler.moduller.get('ayarlar').komutlar([...context.ozellikler.moduller.values()])[0];
    const channel = {
      ...fakeChannel(),
      type: 0,
      guildId: GUILD,
      permissionsFor: () => ({
        has: (flags) => !(Array.isArray(flags) && flags.includes(PermissionFlagsBits.ReadMessageHistory)),
      }),
    };
    const interaction = {
      guildId: GUILD,
      guild: { id: GUILD, members: { me: { id: 'bot' } } },
      memberPermissions: { has: () => true },
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => 'panel',
        getBoolean: () => null,
        getChannel: () => channel,
      },
    };
    await assert.rejects(command.execute(interaction, context), /Mesaj Geçmişini Oku/);
    assert.equal(context.ozellikler.panel.kanalOf(GUILD), null);
  });

  it('live updates are throttled: a burst of player events gives at most one edit per interval', async () => {
    const clock = fakeClock();
    const channel = fakeChannel();
    const state = { ...PLAYING, paused: false };
    const { context, music } = await makeContext({ state, channels: new Map([[CHANNEL, channel]]), clock });
    await context.ozellikler.panel.kur(GUILD, CHANNEL);
    await context.ozellikler.panel.baglan();
    const message = channel.sent.at(-1);
    const before = message.edits.length;

    state.paused = true;
    for (let i = 0; i < 10; i += 1) music.emit('stateChanged', GUILD);
    await clock.advance(4000);
    assert.equal(message.edits.length, before, 'default interval is 5 seconds after the last write');
    await clock.advance(1000);
    assert.equal(message.edits.length, before + 1);

    // The same picture again: no edit at all.
    music.emit('stateChanged', GUILD);
    await clock.advance(10_000);
    assert.equal(message.edits.length, before + 1);
    context.ozellikler.kapat();
  });

  it('removing the panel deletes the message and forgets it', async () => {
    const channel = fakeChannel();
    const { context } = await makeContext({ channels: new Map([[CHANNEL, channel]]) });
    await context.ozellikler.panel.kur(GUILD, CHANNEL);
    await context.ozellikler.panel.kaldir(GUILD);
    assert.equal(channel.messageMap.size, 0);
    assert.equal(context.ozellikler.panel.kanalOf(GUILD), null);
  });
});
