// DJ role: the rule, the per-server settings file, the /dj command and the slash command gate.
// (The web panel side of the same rule is tested in panel.test.js.)

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Events } from 'discord.js';
import { DJ_COMMANDS, isDjAllowed, missingDjRole } from '../src/bot/dj.js';
import { registerInteractionHandler } from '../src/bot/interactions.js';
import { createServerSettings, SettingsSaveError } from '../src/bot/serverSettings.js';
import { execute as djCommand } from '../src/commands/dj.js';
import { loadCommands } from '../src/commands/index.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const GUILD = '222222222222222222';
const USER = '111111111111111111';
const OTHER = '333333333333333333';
const BOT = '999999999999999999';
const DJ = '444444444444444444';
const VOICE = '555555555555555555';

const dir = mkdtempSync(join(tmpdir(), 'muzikbot-dj-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let fileNo = 0;
const newFile = () => join(dir, `sunucular-${++fileNo}.json`);

function fakeGuild(voice) {
  return {
    id: GUILD,
    members: { me: { id: BOT, voice: { channelId: VOICE } } },
    voiceStates: { cache: new Map(voice) },
  };
}

/** A slash command interaction from USER, sitting in VOICE with `others`. */
function fakeInteraction(commandName, { roles = [], manage = false, others = [OTHER], options = {} } = {}) {
  const replies = [];
  return {
    commandName,
    guildId: GUILD,
    guild: fakeGuild([
      [USER, { channelId: VOICE }],
      [BOT, { channelId: VOICE }],
      ...others.map((id) => [id, { channelId: VOICE }]),
    ]),
    user: { id: USER },
    member: { roles }, // raw API member: role ids array
    memberPermissions: { has: () => manage },
    replied: false,
    deferred: false,
    replies,
    isChatInputCommand: () => true,
    options: {
      getRole: () => (options.rol ? { id: options.rol } : null),
      getBoolean: () => options.kaldır ?? null,
    },
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
    },
  };
}

const settingsWith = (roleId) => ({ getDjRole: () => roleId });
const music = { getPlayer: () => ({ voiceChannelId: VOICE }) };

describe('DJ rule', () => {
  it('isDjAllowed: no role set, DJ role, server manager, alone with the bot', () => {
    assert.equal(isDjAllowed({ djRoleId: null }), true);
    assert.equal(isDjAllowed({ djRoleId: DJ, roleIds: [] }), false);
    assert.equal(isDjAllowed({ djRoleId: DJ, roleIds: [DJ] }), true);
    assert.equal(isDjAllowed({ djRoleId: DJ, canManageGuild: true }), true);
    assert.equal(isDjAllowed({ djRoleId: DJ, aloneWithBot: true }), true);
  });

  it('gates control commands only, and only when a DJ role is set', () => {
    const settings = settingsWith(DJ);
    assert.equal(missingDjRole(fakeInteraction('skip'), { settings, music }), DJ);
    assert.equal(missingDjRole(fakeInteraction('volume'), { settings, music }), DJ);
    assert.equal(missingDjRole(fakeInteraction('play'), { settings, music }), null, '/play is for everyone');
    assert.equal(missingDjRole(fakeInteraction('queue'), { settings, music }), null);
    assert.equal(missingDjRole(fakeInteraction('skip'), { settings: settingsWith(null), music }), null);
  });

  it('lets DJs, managers and someone alone with the bot through', () => {
    const settings = settingsWith(DJ);
    assert.equal(missingDjRole(fakeInteraction('stop', { roles: [DJ] }), { settings, music }), null);
    assert.equal(missingDjRole(fakeInteraction('stop', { manage: true }), { settings, music }), null);
    assert.equal(missingDjRole(fakeInteraction('stop', { others: [] }), { settings, music }), null, 'alone');
  });

  it('bots in the channel do not count as company', () => {
    const interaction = fakeInteraction('skip', { others: [] });
    interaction.guild.voiceStates.cache.set('888888888888888888', {
      channelId: VOICE,
      member: { user: { bot: true } },
    });
    assert.equal(missingDjRole(interaction, { settings: settingsWith(DJ), music }), null);
  });

  it('every command in the DJ list exists; play, search, queue and help are not in it', async () => {
    const commands = await loadCommands();
    for (const name of DJ_COMMANDS) assert.ok(commands.has(name), name);
    for (const name of ['play', 'search', 'queue', 'help', 'nowplaying', 'dj', 'servers']) {
      assert.ok(!DJ_COMMANDS.has(name), name);
    }
  });

  it('the slash command handler refuses non-DJs in Turkish and does not run the command', async () => {
    const client = new EventEmitter();
    let ran = false;
    const commands = new Map([['skip', { execute: async () => (ran = true) }]]);
    registerInteractionHandler({ client, commands, logger: silent, settings: settingsWith(DJ), music });
    const interaction = fakeInteraction('skip');
    client.emit(Events.InteractionCreate, interaction);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ran, false);
    assert.match(interaction.replies[0].embeds[0].toJSON().description, /Bu komutu kullanma yetkin yok\./);
    assert.ok(interaction.replies[0].flags, 'ephemeral');

    const dj = fakeInteraction('skip', { roles: [DJ] });
    client.emit(Events.InteractionCreate, dj);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ran, true);
  });
});

describe('server settings file', () => {
  it('keeps the DJ role across restarts', () => {
    const file = newFile();
    createServerSettings({ file }).setDjRole(GUILD, DJ);
    assert.equal(createServerSettings({ file }).getDjRole(GUILD), DJ);
    assert.equal(createServerSettings({ file }).getDjRole('other'), null);
  });

  it('removing the DJ role keeps the rest of the server record (old bot deleted all of it)', () => {
    const file = newFile();
    writeFileSync(file, JSON.stringify({ [GUILD]: { djRoleId: DJ, baskaAyar: 5 }, diger: { djRoleId: DJ } }));
    createServerSettings({ file }).setDjRole(GUILD, null);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved[GUILD], { baskaAyar: 5 });
    assert.deepEqual(saved.diger, { djRoleId: DJ });
  });

  it('a broken file does not crash the bot; it is backed up and replaced on the next save', () => {
    const file = newFile();
    writeFileSync(file, '{ bozuk json');
    const warnings = [];
    const settings = createServerSettings({ file, logger: { warn: (m) => warnings.push(m) } });
    assert.equal(settings.getDjRole(GUILD), null);
    assert.equal(warnings.length, 1);
    assert.ok(readdirSync(dir).some((name) => name.startsWith(`sunucular-${fileNo}.json.bozuk-`)));
    settings.setDjRole(GUILD, DJ);
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[GUILD].djRoleId, DJ);
  });

  /** Real fs whose renameSync fails with `code` for the first `failures` calls. */
  function flakyFs(code, failures) {
    let left = failures;
    return {
      ...fs,
      renameSync(from, to) {
        if (left > 0) {
          left -= 1;
          throw Object.assign(new Error(`${code}: operation not permitted`), { code });
        }
        return fs.renameSync(from, to);
      },
    };
  }

  it('retries a briefly locked file on Windows (EPERM/EBUSY)', () => {
    const file = newFile();
    createServerSettings({ file, fs: flakyFs('EPERM', 2) }).setDjRole(GUILD, DJ);
    assert.equal(createServerSettings({ file }).getDjRole(GUILD), DJ);
    const busy = newFile();
    createServerSettings({ file: busy, fs: flakyFs('EBUSY', 1) }).setDjRole(GUILD, DJ);
    assert.equal(createServerSettings({ file: busy }).getDjRole(GUILD), DJ);
  });

  it('when saving keeps failing, memory is unchanged and /dj answers in Turkish', async () => {
    const file = newFile();
    createServerSettings({ file }).setDjRole(GUILD, DJ);
    const settings = createServerSettings({ file, fs: flakyFs('EPERM', 99), logger: { warn() {} } });
    assert.throws(() => settings.setDjRole(GUILD, null), SettingsSaveError);
    assert.equal(settings.getDjRole(GUILD), DJ, 'memory not changed before the file is written');
    assert.equal(createServerSettings({ file }).getDjRole(GUILD), DJ);

    const interaction = fakeInteraction('dj', { manage: true, options: { kaldır: true } });
    await djCommand(interaction, { settings });
    const reply = interaction.replies[0];
    assert.match(reply.embeds[0].toJSON().description, /DJ ayarı kaydedilemedi/);
    assert.ok(reply.flags, 'ephemeral');
    assert.equal(settings.getDjRole(GUILD), DJ);
  });

  it('other write errors are not retried', () => {
    let renames = 0;
    const settings = createServerSettings({
      file: newFile(),
      fs: {
        ...fs,
        renameSync() {
          renames += 1;
          throw Object.assign(new Error('disk dolu'), { code: 'ENOSPC' });
        },
      },
      logger: { warn() {} },
    });
    assert.throws(() => settings.setDjRole(GUILD, DJ), SettingsSaveError);
    assert.equal(renames, 1);
    assert.equal(settings.getDjRole(GUILD), null);
  });

  it('ignores values that are not role ids and a missing file', () => {
    const file = newFile();
    assert.equal(createServerSettings({ file }).getDjRole(GUILD), null);
    assert.equal(existsSync(file), false, 'reading does not create the file');
    writeFileSync(file, JSON.stringify({ [GUILD]: { djRoleId: '<script>' } }));
    assert.equal(createServerSettings({ file }).getDjRole(GUILD), null);
  });
});

describe('/dj', () => {
  const run = async (settings, opts) => {
    const interaction = fakeInteraction('dj', opts);
    await djCommand(interaction, { settings });
    return interaction.replies[0].embeds[0].toJSON().description;
  };

  it('is refused without "Manage Server"', async () => {
    const settings = createServerSettings({ file: newFile() });
    assert.match(await run(settings, { options: { rol: DJ } }), /Bu komutu kullanma yetkin yok\./);
    assert.equal(settings.getDjRole(GUILD), null);
  });

  it('sets, shows, toggles off with the same role and removes with kaldır', async () => {
    const settings = createServerSettings({ file: newFile() });
    const manage = { manage: true };
    assert.match(await run(settings, { ...manage }), /ayarlı değil/);
    assert.match(await run(settings, { ...manage, options: { rol: DJ } }), /ayarlandı/);
    assert.equal(settings.getDjRole(GUILD), DJ);
    assert.match(await run(settings, { ...manage }), new RegExp(DJ));
    assert.match(await run(settings, { ...manage, options: { rol: DJ } }), /kaldırıldı/);
    assert.equal(settings.getDjRole(GUILD), null);
    await run(settings, { ...manage, options: { rol: DJ } });
    assert.match(await run(settings, { ...manage, options: { kaldır: true } }), /kaldırıldı/);
    assert.equal(settings.getDjRole(GUILD), null);
  });
});
