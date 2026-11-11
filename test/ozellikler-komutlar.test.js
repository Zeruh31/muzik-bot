// Command layout after the control center: music commands moved under /muzik keep their behavior
// (same file, same reply, same DJ rule, autocomplete), module commands are loaded, /help is built from
// the command registry, the invite permission number matches README.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Events } from 'discord.js';
import { missingDjRole } from '../src/bot/dj.js';
import { registerInteractionHandler } from '../src/bot/interactions.js';
import { botPermissions, MUSIC_PERMISSIONS, permissionsValue } from '../src/bot/permissions.js';
import { defineModule } from '../src/ozellikler/_ortak.js';
import { loadModules } from '../src/ozellikler/index.js';
import { loadCommands } from '../src/commands/index.js';
import { commandsByCategory, renderHelp } from '../src/commands/help.js';
import { PROJECT_ROOT } from '../src/config.js';

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const OTHER = '333333333333333333';
const VOICE = '444444444444444444';
const DJ = '555555555555555555';
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function fakeMusic() {
  const calls = [];
  return {
    calls,
    getPlayer: () => ({ voiceChannelId: VOICE }),
    getState: () => ({ volume: 80, current: null, queue: [] }),
    async toggleTrackLoop() {
      calls.push('loop');
      return 'track';
    },
    async shuffle() {
      calls.push('shuffle');
      return 4;
    },
    async setVolume(guildId, level) {
      calls.push(`volume:${level}`);
    },
    async clear() {
      calls.push('clear');
      return 2;
    },
  };
}

/** A /muzik <sub> (or a top-level /<sub>) interaction with the given options. */
function slash(commandName, sub, { group = null, ints = {}, roles = [], others = [OTHER] } = {}) {
  const replies = [];
  return {
    commandName,
    replies,
    guildId: GUILD,
    user: { id: USER },
    member: { roles, voice: { channel: { id: VOICE } } },
    memberPermissions: { has: () => false },
    guild: {
      id: GUILD,
      members: { me: { id: 'bot', voice: { channelId: VOICE } } },
      voiceStates: {
        cache: new Map([[USER, { channelId: VOICE }], ...others.map((id) => [id, { channelId: VOICE }])]),
      },
    },
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => sub,
      getInteger: (name) => ints[name] ?? null,
      getFocused: () => 'yo',
    },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
    },
    async respond(choices) {
      replies.push(choices);
    },
  };
}

const json = (interaction) => interaction.replies.map((r) => (r.embeds ? r.embeds.map((e) => e.toJSON()) : r));

describe('music commands under /muzik', () => {
  it('run the same file and give the same reply as before the move', async () => {
    const commands = await loadCommands();
    const muzik = commands.get('muzik');
    for (const [sub, ints] of [
      ['loop', {}],
      ['shuffle', {}],
      ['volume', { seviye: 120 }],
      ['clear', {}],
    ]) {
      const viaGroup = slash('muzik', sub, { ints });
      const music = fakeMusic();
      await muzik.execute(viaGroup, { music });
      const direct = slash(sub, sub, { ints });
      const music2 = fakeMusic();
      await muzik.subcommands.get(sub).execute(direct, { music: music2 });
      assert.deepEqual(json(viaGroup), json(direct), sub);
      assert.deepEqual(music.calls, music2.calls, sub);
      assert.ok(music.calls.length, sub);
    }
  });

  it('follow the DJ rule of the subcommand ("/muzik loop" is a DJ command, "/muzik lyrics" is not)', async () => {
    const commands = await loadCommands();
    const muzik = commands.get('muzik');
    const settings = { getDjRole: () => DJ };
    const music = fakeMusic();
    const loop = slash('muzik', 'loop');
    assert.equal(missingDjRole(loop, { settings, music }, muzik.djName(loop)), DJ);
    const lyrics = slash('muzik', 'lyrics');
    assert.equal(missingDjRole(lyrics, { settings, music }, muzik.djName(lyrics)), null);

    // Through the real interaction handler: refused in Turkish, the song loop is not touched.
    const client = new EventEmitter();
    registerInteractionHandler({ client, commands, logger: silent, settings, music });
    client.emit(Events.InteractionCreate, loop);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(music.calls, []);
    assert.match(loop.replies[0].embeds[0].toJSON().description, /yetkin yok/);
    const dj = slash('muzik', 'loop', { roles: [DJ] });
    client.emit(Events.InteractionCreate, dj);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(music.calls, ['loop']);
  });

  it('/muzik liste keeps its autocomplete', async () => {
    const commands = await loadCommands();
    const interaction = slash('muzik', 'çal', { group: 'liste' });
    await commands.get('muzik').autocomplete(interaction, { playlists: { suggest: () => ['Yolculuk'] } });
    assert.deepEqual(interaction.replies[0], [{ name: 'Yolculuk', value: 'Yolculuk' }]);
  });

  it('top-level shortcuts stay where they were', async () => {
    const commands = await loadCommands();
    for (const name of [
      'play',
      'skip',
      'stop',
      'queue',
      'nowplaying',
      'pause',
      'resume',
      'dj',
      'servers',
      'invite',
      'stats',
      'help',
    ]) {
      assert.ok(commands.has(name), name);
    }
    for (const name of ['search', 'loop', 'liste', 'gecmis', 'volume']) assert.ok(!commands.has(name), name);
  });
});

describe('module commands', () => {
  it('/menu, /ayar and the "Bot menüsünü aç" user context menu are loaded', async () => {
    const commands = await loadCommands();
    assert.equal(commands.get('menu').modul, 'menu');
    assert.equal(commands.get('ayar').modul, 'ayarlar');
    const context = commands.get('Bot menüsünü aç');
    assert.equal(context.data.toJSON().type, 2);
    assert.ok(context.data.name.length <= 32);
  });
});

describe('/help', () => {
  const config = { music: { twentyFourSeven: false, leaveWhenEmptySeconds: 60 }, brand: {} };

  it('is built from the command registry, per category, with /muzik subcommands listed', async () => {
    const commands = await loadCommands();
    const categories = [...commandsByCategory(commands).keys()];
    assert.deepEqual(categories, ['muzik', 'oyun', 'genel', 'ayarlar', 'seviye']);
    const music = renderHelp({ commands, config }, 'muzik');
    const text = music.embeds[0].toJSON().description;
    assert.match(text, /`\/play` — /);
    assert.match(text, /`\/muzik loop` — /);
    assert.match(text, /`\/muzik liste kaydet` — /);
    const select = music.components[0].toJSON().components[0];
    assert.equal(select.custom_id, 'oz:yardim:kategori');
    assert.deepEqual(
      select.options.map((o) => o.value),
      ['muzik', 'oyun', 'genel', 'ayarlar', 'seviye'],
    );
    const genel = renderHelp({ commands, config }, 'genel').embeds[0].toJSON().description;
    assert.match(genel, /`\/menu` — /);
    assert.match(genel, /Sağ tık > Uygulamalar > \*\*Bot menüsünü aç\*\*/);
    assert.match(renderHelp({ commands, config }, 'ayarlar').embeds[0].toJSON().description, /`\/ayar goster`/);
  });

  it('the category menu works through the router after a restart (persistent id)', async () => {
    const commands = await loadCommands();
    const { createRouter } = await import('../src/ozellikler/_yonlendirici.js');
    const { loadModules } = await import('../src/ozellikler/index.js');
    const router = createRouter(new Map((await loadModules()).map((m) => [m.ad, m])));
    const updates = [];
    await router.handle(
      { customId: 'oz:yardim:kategori', values: ['genel'], update: async (p) => updates.push(p) },
      { commands, config },
    );
    assert.match(updates[0].embeds[0].toJSON().title, /Genel/);
  });
});

describe('reserved playlist names', () => {
  it('get their own "bu ad kullanılamaz" message instead of the format error', async () => {
    const { normalizeName } = await import('../src/bot/listeler.js');
    assert.throws(
      () => normalizeName('constructor'),
      (e) => e.code === 'INVALID_VALUE' && /kullanılamaz/.test(e.message),
    );
    assert.throws(
      () => normalizeName('kötü!ad'),
      (e) => e.code === 'INVALID_VALUE' && /yalnız harf/.test(e.message),
    );
  });
});

describe('invite permissions', () => {
  it('come from music plus the loaded modules; README and README.en show that number (562950241897488)', async () => {
    const value = permissionsValue(botPermissions(await loadModules()));
    assert.equal(value, '562950241897488');
    assert.equal(permissionsValue(MUSIC_PERMISSIONS), '3165184');
    for (const file of ['README.md', 'README.en.md']) {
      const text = readFileSync(join(PROJECT_ROOT, file), 'utf8');
      assert.ok(text.includes(`permissions=${value}`), file);
      assert.ok(!/permissions=(3165184|288476176)/.test(text), `${file}: old number`);
    }
  });

  it('a module adds its own permissions only when it is registered', () => {
    const roller = defineModule({ ad: 'roller', izinler: ['ManageRoles'] });
    assert.equal(permissionsValue(botPermissions([roller])), String(3165184 + 268435456));
    assert.throws(() => defineModule({ ad: 'kotu', izinler: ['HerSey'] }), /bilinmeyen izin/);
  });
});
