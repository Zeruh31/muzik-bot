// The desktop app's settings bridge (src/ozellikler/_masaustu): request file checks, the same path as /ayar,
// role settings recorded for the bot owner, list settings, the request folder watcher and the structure file.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { createAyarCommand } from '../src/ozellikler/ayarlar/komut.js';
import { cevaplar, hatalar as ayarHatalari } from '../src/ozellikler/ayarlar/mesajlar.js';
import { validateValue } from '../src/ozellikler/ayarlar/sema.js';
import { buildSchemaExport, buildSettingsView, labelOf, plainText } from '../src/ozellikler/_masaustu/gorunum.js';
import {
  createRequestProcessor,
  MAX_REQUEST_BYTES,
  parseRequest,
  processRequest,
} from '../src/ozellikler/_masaustu/istekler.js';
import { attachDesktopBridge, DESKTOP_FILES } from '../src/ozellikler/_masaustu/kopru.js';
import { hatalar } from '../src/ozellikler/_masaustu/mesajlar.js';
import {
  createStructureFiles,
  guildStructureFile,
  STRUCTURE_SCHEMA_VERSION,
} from '../src/ozellikler/_masaustu/yapi.js';
import { fakeGuild, GUILD, makeLiveContext, newId, perms } from './yardimci/discordSahte.js';
import { removeTempDirs, silent as silentLogger, tempDir } from './yardimci/ozellikBaglami.js';

const started = [];
after(() => {
  for (const item of started) item.stop();
  removeTempDirs();
});

const BOT_OWNER = '100000000000000009';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = (fields = {}) =>
  JSON.stringify({
    surum: 1,
    guildId: GUILD,
    modul: 'karsilama',
    alan: 'hosgeldin-kanal',
    deger: null,
    istenen: new Date().toISOString(),
    ...fields,
  });
const noTimers = {
  setTimeout: () => null,
  clearTimeout() {},
  setInterval: () => null,
  clearInterval() {},
};

/** A live context whose bot owner is BOT_OWNER; `owner` adds them to the guild. */
async function setup({ owner = { top: 40, manage: true } } = {}) {
  const context = await makeLiveContext();
  context.isOwner = Object.assign(async (id) => id === BOT_OWNER, { ids: async () => [BOT_OWNER] });
  if (owner) {
    const member = context.guild.addMember({ userId: BOT_OWNER, name: 'Sahip', top: owner.top });
    member.permissions = perms(owner.manage ? [PermissionFlagsBits.ManageGuild] : []);
  }
  return context;
}
const run = (context, fields) => processRequest(context, request(fields));
const store = (context) => context.ozellikler.ayarlar;

describe('desktop request file checks', () => {
  const refusedWith = (text, pattern) => assert.throws(() => parseRequest(text), pattern);

  it('refuses broken JSON, a big file, unknown and missing fields', () => {
    refusedWith('{"surum":1,', /bozuk JSON/);
    refusedWith('[]', /JSON nesnesi/);
    refusedWith(request({ deger: 'x'.repeat(MAX_REQUEST_BYTES) }), /çok büyük/);
    refusedWith(request({ yetki: 'admin' }), /bilinmeyen alan "yetki"/);
    const { istenen: _t, ...withoutTime } = JSON.parse(request());
    refusedWith(JSON.stringify(withoutTime), /"istenen" alanı eksik/);
    refusedWith(request({ surum: 2 }), /sürüm/);
    refusedWith(request({ guildId: '123' }), /sunucu kimliği/);
  });

  it('refuses reserved and malformed names (no prototype keys reach the store)', () => {
    for (const [modul, alan] of [
      ['__proto__', 'x'],
      ['karsilama', 'constructor'],
      ['karsilama', '__proto__'],
      ['karsilama', 'goster'],
      ['Karsilama', 'kanal'],
      ['karsilama', '../x'],
    ]) {
      refusedWith(request({ modul, alan }), /ayrılmış/);
    }
    // JSON.parse makes "__proto__" an own key: still an unknown field.
    refusedWith('{"__proto__":{"x":1},' + request().slice(1), /bilinmeyen alan "__proto__"/);
  });

  it('refuses odd values, old requests and requests from the future', () => {
    refusedWith(request({ deger: { id: '1' } }), /değer türü/);
    refusedWith(request({ deger: 1.5 }), /tam sayı/);
    refusedWith(request({ deger: ['abc'] }), /kimlik/);
    refusedWith(request({ istenen: new Date(Date.now() - 10 * 60_000).toISOString() }), /çok eski/);
    refusedWith(request({ istenen: new Date(Date.now() + 10 * 60_000).toISOString() }), /istek zamanı/);
    const ok = parseRequest(request({ deger: true }));
    assert.equal(ok.deger, true);
  });
});

describe('desktop requests use the /ayar path', () => {
  it('a channel setting is stored exactly like /ayar stores it', async () => {
    const viaApp = await setup();
    const viaAyar = await setup();
    const channelA = viaApp.guild.addText('genel');
    const channelB = viaAyar.guild.addText('genel');
    const answer = await run(viaApp, { deger: channelA.id });
    assert.deepEqual([answer.ok, answer.hata, answer.yeniDeger], [true, null, channelA.id]);

    const ayar = createAyarCommand([...viaAyar.ozellikler.moduller.values()]);
    const replies = [];
    await ayar.execute(
      {
        guildId: GUILD,
        guild: viaAyar.guild,
        user: { id: BOT_OWNER },
        member: viaAyar.guild.members.cache.get(BOT_OWNER),
        memberPermissions: perms('hepsi'),
        options: {
          getSubcommandGroup: () => 'karsilama',
          getSubcommand: () => 'hosgeldin-kanal',
          getBoolean: () => null,
          getChannel: () => channelB,
        },
        reply: async (payload) => replies.push(payload),
      },
      viaAyar,
    );
    assert.equal(replies.length, 1);
    assert.equal(store(viaAyar).get(GUILD, 'karsilama', 'hosgeldin-kanal'), channelB.id);
    assert.equal(store(viaApp).isSet(GUILD, 'karsilama', 'hosgeldin-kanal'), true);
  });

  it('refusals are the validator texts of /ayar (channel type, send permission)', async () => {
    const context = await setup();
    const voice = context.guild.addVoice('Sohbet');
    const mute = context.guild.addText('duyurular');
    mute.permissionsFor = () => perms([]);
    const alan = context.ozellikler.moduller.get('karsilama').ayarlar['hosgeldin-kanal'];
    for (const channel of [voice, mute]) {
      let expected;
      try {
        validateValue(alan, channel, { guild: context.guild });
      } catch (error) {
        expected = plainText(error.message, context.guild);
      }
      const answer = await run(context, { deger: channel.id });
      assert.equal(answer.ok, false);
      assert.equal(answer.hata, expected);
    }
    assert.match((await run(context, { deger: mute.id })).hata, /#duyurular kanalında mesaj göremiyor/);
    assert.equal((await run(context, { deger: newId() })).hata, hatalar.kanalYok);
    assert.equal(store(context).isSet(GUILD, 'karsilama', 'hosgeldin-kanal'), false);
  });

  it('the source shares one function: /ayar and the request handler both call applySetting', () => {
    const komut = readFileSync(new URL('../src/ozellikler/ayarlar/komut.js', import.meta.url), 'utf8');
    const istekler = readFileSync(new URL('../src/ozellikler/_masaustu/istekler.js', import.meta.url), 'utf8');
    assert.match(komut, /const \{ value \} = applySetting\(context, \{\s*\.\.\.where,\s*raw,/);
    assert.match(istekler, /import \{ applySetting \} from '\.\.\/ayarlar\/komut\.js';/);
    assert.doesNotMatch(istekler, /ayarlar\.set\(/, 'the handler never writes the store itself');
  });

  it('unknown modules and fields, covered and Discord-only settings are refused; null resets', async () => {
    const context = await setup();
    assert.equal((await run(context, { modul: 'yok-boyle' })).hata, hatalar.modulYok);
    assert.equal((await run(context, { alan: 'yok-boyle' })).hata, hatalar.ayarYok);
    assert.equal((await run(context, { modul: 'kayit', alan: 'haric-1', deger: newId() })).hata, hatalar.ayarYok);
    assert.equal(
      (await run(context, { modul: 'seviye', alan: 'roller', deger: [] })).hata,
      hatalar.yalnizDiscord('/seviye rol'),
    );
    assert.equal(
      (await run(context, { modul: 'karsilama', alan: 'hosgeldin-kart', deger: 'evet' })).hata,
      hatalar.deger,
    );
    const other = await setup();
    other.client.guilds.cache.clear();
    assert.equal((await run(other, {})).hata, hatalar.sunucuYok);

    // A hidden setting with no subcommand of its own (kayit kanal) can be set from the app.
    const log = context.guild.addText('kayitlar');
    assert.equal((await run(context, { modul: 'kayit', alan: 'kanal', deger: log.id })).ok, true);
    assert.equal(store(context).get(GUILD, 'kayit', 'kanal'), log.id);
    assert.equal((await run(context, { modul: 'menu', alan: 'panel-aralik', deger: 99 })).ok, false);
    assert.equal((await run(context, { modul: 'menu', alan: 'panel-aralik', deger: 10 })).yeniDeger, 10);
    const reset = await run(context, { modul: 'menu', alan: 'panel-aralik', deger: null });
    assert.deepEqual([reset.ok, reset.yeniDeger], [true, 5]);
    assert.equal(store(context).isSet(GUILD, 'menu', 'panel-aralik'), false);
  });
});

describe('role settings from the desktop app', () => {
  const roleRequest = (roleId) => ({ modul: 'karsilama', alan: 'otorol-1', deger: roleId });

  it('are recorded for the bot owner and checked against them', async () => {
    const context = await setup({ owner: { top: 40, manage: true } });
    const low = context.guild.addRole({ name: 'Üye', position: 5 });
    const answer = await run(context, roleRequest(low.id));
    assert.deepEqual([answer.ok, answer.yeniDeger], [true, low.id]);
    assert.equal(store(context).setBy(GUILD, 'karsilama', 'otorol-1'), BOT_OWNER);

    const aboveOwner = context.guild.addRole({ name: 'Moderatör', position: 45 });
    assert.equal(
      (await run(context, roleRequest(aboveOwner.id))).hata,
      plainText(ayarHatalari.rolKisiHiyerarsi(aboveOwner.id), context.guild),
    );
    const aboveBot = context.guild.addRole({ name: 'Yönetim', position: 60 });
    assert.match((await run(context, roleRequest(aboveBot.id))).hata, /@Yönetim rolünü veremem: rolüm ondan aşağıda/);
    const risky = context.guild.addRole({
      name: 'Yasaklayıcı',
      position: 3,
      permissions: [PermissionFlagsBits.BanMembers],
    });
    assert.match((await run(context, roleRequest(risky.id))).hata, /'Üyeleri Yasakla' izni var/);
    const managed = context.guild.addRole({ name: 'Bot', position: 2, managed: true });
    assert.equal((await run(context, roleRequest(managed.id))).hata, ayarHatalari.rolYonetilen);
    assert.equal((await run(context, roleRequest(newId()))).hata, hatalar.rolYok);
    assert.equal(store(context).get(GUILD, 'karsilama', 'otorol-1'), low.id, 'refusals change nothing');
  });

  it('are refused when the owner is not in the server or lacks "Sunucuyu Yönet"', async () => {
    const away = await setup({ owner: null });
    const role = away.guild.addRole({ name: 'Üye', position: 5 });
    assert.equal((await run(away, roleRequest(role.id))).hata, hatalar.sahipUyeDegil);
    const powerless = await setup({ owner: { top: 40, manage: false } });
    const role2 = powerless.guild.addRole({ name: 'Üye', position: 5 });
    assert.equal((await run(powerless, roleRequest(role2.id))).hata, hatalar.sahipYetkisiz);
    const unknown = await setup();
    unknown.isOwner = Object.assign(async () => false, { ids: async () => [] });
    const role3 = unknown.guild.addRole({ name: 'Üye', position: 5 });
    assert.equal((await run(unknown, roleRequest(role3.id))).hata, hatalar.sahipBilinmiyor);
    // Not a role: no owner needed.
    assert.equal((await run(away, { modul: 'karsilama', alan: 'hosgeldin-kart', deger: false })).ok, true);
  });
});

describe('several bot owners', () => {
  it('the qualifying owner with the highest role is recorded', async () => {
    const context = await setup({ owner: null });
    const [low, high, outsider] = ['100000000000000011', '100000000000000012', '100000000000000013'];
    context.isOwner = Object.assign(async () => true, { ids: async () => [low, high, outsider] });
    for (const [userId, top, manage] of [
      [low, 20, true],
      [high, 40, true],
      [outsider, 45, false],
    ]) {
      const member = context.guild.addMember({ userId, top });
      member.permissions = perms(manage ? [PermissionFlagsBits.ManageGuild] : []);
    }
    const role = context.guild.addRole({ name: 'Orta', position: 30 });
    const answer = await run(context, { modul: 'karsilama', alan: 'otorol-1', deger: role.id });
    assert.equal(answer.ok, true, answer.hata);
    assert.equal(store(context).setBy(GUILD, 'karsilama', 'otorol-1'), high);
  });
});

describe('list settings from the desktop app', () => {
  it('kayit haric replaces the whole list with the /ayar kayit haric check', async () => {
    const context = await setup();
    const [a, b] = [context.guild.addText('yonetim'), context.guild.addText('gizli')];
    const answer = await run(context, { modul: 'kayit', alan: 'haric', deger: [a.id, b.id] });
    assert.deepEqual(answer.yeniDeger, [a.id, b.id]);
    assert.equal(store(context).get(GUILD, 'kayit', 'haric-2'), b.id);
    assert.deepEqual((await run(context, { modul: 'kayit', alan: 'haric', deger: [b.id] })).yeniDeger, [b.id]);
    assert.equal(store(context).get(GUILD, 'kayit', 'haric-2'), null);
    const voice = context.guild.addVoice('ses');
    assert.match((await run(context, { modul: 'kayit', alan: 'haric', deger: [voice.id] })).hata, /metin kanalı/i);
    const six = Array.from({ length: 6 }, () => context.guild.addText('k').id);
    assert.equal((await run(context, { modul: 'kayit', alan: 'haric', deger: six })).hata, hatalar.liste(5));
    assert.deepEqual((await run(context, { modul: 'kayit', alan: 'haric', deger: null })).yeniDeger, []);
  });

  it('seviye haric lists: @everyone is refused, channels of any XP type are fine', async () => {
    const context = await setup();
    const role = context.guild.addRole({ name: 'Bot değil', position: 4 });
    const voice = context.guild.addVoice('Sohbet');
    assert.deepEqual((await run(context, { modul: 'seviye', alan: 'haric-roller', deger: [role.id] })).yeniDeger, [
      role.id,
    ]);
    assert.equal((await run(context, { modul: 'seviye', alan: 'haric-roller', deger: [GUILD] })).ok, false);
    assert.deepEqual((await run(context, { modul: 'seviye', alan: 'haric-kanallar', deger: [voice.id] })).yeniDeger, [
      voice.id,
    ]);
  });
});

describe('the request folder', () => {
  async function folder(options = {}) {
    const context = await setup();
    const dir = join(context.dir, 'istekler');
    const answersDir = join(context.dir, 'yanitlar');
    let clock = Date.now();
    const processor = createRequestProcessor({
      context,
      dir,
      answersDir,
      timers: noTimers,
      now: () => clock,
      ...options,
    });
    processor.start();
    started.push(processor);
    const answers = () =>
      Object.fromEntries(
        readdirSync(answersDir).map((name) => [
          name.slice(0, -5),
          JSON.parse(readFileSync(join(answersDir, name), 'utf8')),
        ]),
      );
    return { context, dir, answersDir, processor, answers, tick: (ms) => (clock += ms) };
  }

  it('answers every request, deletes it and leaves other names alone', async () => {
    const { context, dir, processor, answers } = await folder();
    const channel = context.guild.addText('genel');
    writeFileSync(join(dir, `${uuid(1)}.json`), request({ deger: channel.id }));
    writeFileSync(join(dir, `${uuid(2)}.json`), '{bozuk');
    writeFileSync(join(dir, `${uuid(3)}.json`), 'x'.repeat(MAX_REQUEST_BYTES + 1));
    writeFileSync(join(dir, 'baska-dosya.json'), request());
    writeFileSync(join(dir, `${uuid(4)}.json.tmp`), request());
    await processor.drain();
    const got = answers();
    assert.deepEqual(Object.keys(got).sort(), [uuid(1), uuid(2), uuid(3)]);
    assert.deepEqual([got[uuid(1)].ok, got[uuid(1)].yeniDeger, got[uuid(1)].surum], [true, channel.id, 1]);
    assert.equal(got[uuid(2)].hata, hatalar.bozukDosya);
    assert.equal(got[uuid(3)].hata, hatalar.buyukDosya(16));
    assert.deepEqual(readdirSync(dir).sort(), [`${uuid(4)}.json.tmp`, 'baska-dosya.json']);
    processor.stop();
  });

  it('never follows a link: it is answered and removed, its target stays', async () => {
    const { dir, processor, answers, context } = await folder();
    const target = join(context.dir, 'hedef');
    mkdirSync(target);
    writeFileSync(join(target, 'icerik.txt'), 'dokunulmamalı');
    symlinkSync(target, join(dir, `${uuid(5)}.json`), 'junction');
    await processor.drain();
    assert.equal(answers()[uuid(5)].hata, hatalar.baglanti);
    assert.equal(existsSync(join(dir, `${uuid(5)}.json`)), false);
    assert.equal(readFileSync(join(target, 'icerik.txt'), 'utf8'), 'dokunulmamalı');
    processor.stop();
  });

  it('handles the oldest first, one at a time: two requests for one setting end with the newer value', async () => {
    const { context, dir, processor } = await folder();
    const [first, second] = [context.guild.addText('bir'), context.guild.addText('iki')];
    const newer = join(dir, `${uuid(6)}.json`);
    const older = join(dir, `${uuid(9)}.json`);
    writeFileSync(newer, request({ deger: second.id }));
    writeFileSync(older, request({ deger: first.id }));
    utimesSync(older, new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    await Promise.all([processor.drain(), processor.drain()]);
    assert.equal(store(context).get(GUILD, 'karsilama', 'hosgeldin-kanal'), second.id);
    processor.stop();
  });

  it('claims a request by renaming it before reading; a request taken back is never applied', async () => {
    const opened = [];
    const fsSpy = {
      ...nodeFs,
      promises: {
        ...nodeFs.promises,
        open: async (file, flags) => {
          opened.push([file, existsSync(file.replace(/\.isleniyor$/, '.json'))]);
          return nodeFs.promises.open(file, flags);
        },
      },
    };
    const { context, dir, processor, answers } = await folder({ fs: fsSpy });
    const channel = context.guild.addText('genel');
    writeFileSync(join(dir, `${uuid(21)}.json`), request({ deger: channel.id }));
    // Left claimed by a bot that stopped half-way: handled on the next start.
    writeFileSync(join(dir, `${uuid(22)}.isleniyor`), request({ alan: 'hosgeldin-kart', deger: false }));
    await processor.drain();
    assert.deepEqual(
      opened.map(([file, original]) => [file.endsWith('.isleniyor'), original]),
      [
        [true, false],
        [true, false],
      ],
      'only the claimed name is opened, the .json name is gone by then',
    );
    assert.equal(answers()[uuid(21)].ok, true);
    assert.equal(answers()[uuid(22)].ok, true);
    assert.deepEqual(readdirSync(dir), []);

    // The app renames its request away first (withdraw): the bot's claim fails and nothing happens.
    const racing = {
      ...nodeFs,
      promises: {
        ...nodeFs.promises,
        rename: async (from, to) => {
          if (from.endsWith(`${uuid(23)}.json`)) nodeFs.renameSync(from, `${from}.geri-alindi`);
          return nodeFs.promises.rename(from, to);
        },
      },
    };
    const other = await folder({ fs: racing });
    writeFileSync(join(other.dir, `${uuid(23)}.json`), request({ alan: 'hosgeldin-kart', deger: false }));
    await other.processor.drain();
    assert.deepEqual(other.answers(), {});
    assert.equal(store(other.context).isSet(GUILD, 'karsilama', 'hosgeldin-kart'), false);
  });

  it('looks at the folder asynchronously, at most N files a round, and drops a flood unread', async () => {
    let readdirCalls = 0;
    const warnings = [];
    const fsSpy = {
      ...nodeFs,
      readdirSync: () => assert.fail('the folder is never listed synchronously'),
      promises: {
        ...nodeFs.promises,
        readdir: (...args) => {
          readdirCalls += 1;
          return nodeFs.promises.readdir(...args);
        },
      },
    };
    const { dir, processor, answers } = await folder({
      fs: fsSpy,
      batch: 2,
      backlog: 5,
      perSecond: 100,
      logger: { ...silentLogger, warn: (text) => warnings.push(text) },
    });
    for (let n = 31; n <= 38; n += 1) {
      const file = join(dir, `${uuid(n)}.json`);
      writeFileSync(file, request({ alan: 'hosgeldin-kart', deger: n % 2 === 0 }));
      utimesSync(file, new Date(Date.now() - (40 - n) * 1000), new Date(Date.now() - (40 - n) * 1000));
    }
    await processor.drain();
    assert.deepEqual(Object.keys(answers()).sort(), [34, 35, 36, 37, 38].map(uuid), 'the 3 oldest were dropped');
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(readdirCalls >= 3, `a round handles at most 2 (${readdirCalls} looks)`);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /en eski 3 istek okunmadan silindi/);
  });

  it('handles at most N a second and removes old answers', async () => {
    const scheduled = [];
    const { dir, answersDir, processor, answers, tick } = await folder({
      perSecond: 2,
      timers: {
        ...noTimers,
        setTimeout: (_fn, ms) => {
          scheduled.push(ms);
          return null;
        },
      },
    });
    for (const n of [11, 12, 13])
      writeFileSync(join(dir, `${uuid(n)}.json`), request({ alan: 'hosgeldin-kart', deger: true }));
    await processor.drain();
    assert.equal(Object.keys(answers()).length, 2);
    assert.ok(
      scheduled.some((ms) => ms > 0 && ms <= 1000),
      'the rest is picked up a second later',
    );
    tick(1000);
    await processor.drain();
    assert.equal(Object.keys(answers()).length, 3);
    utimesSync(
      join(answersDir, `${uuid(11)}.json`),
      new Date(Date.now() - 20 * 60_000),
      new Date(Date.now() - 20 * 60_000),
    );
    writeFileSync(join(dir, `${uuid(14)}.geri-alindi`), request());
    await processor.sweep();
    assert.equal(existsSync(join(dir, `${uuid(14)}.geri-alindi`)), false, 'a request the app took back is cleaned up');
    assert.deepEqual(Object.keys(answers()).sort(), [uuid(12), uuid(13)]);
    processor.stop();
  });
});

describe('desktop files', () => {
  it('sunucu-yapisi/<id>.json lists channels and roles with what the bot may do', async () => {
    const context = await setup();
    const { guild } = context;
    const category = guild.addCategory('Oyun');
    const text = guild.addText('genel');
    const mute = guild.addText('salt-okunur');
    mute.permissionsFor = () => perms([PermissionFlagsBits.ViewChannel]);
    const voice = guild.addVoice('Sohbet', category.id);
    const low = guild.addRole({ name: 'Üye', position: 5 });
    const high = guild.addRole({ name: 'Yönetim', position: 70 });
    const risky = guild.addRole({ name: 'Mod', position: 6, permissions: [PermissionFlagsBits.KickMembers] });
    const structure = guildStructureFile(guild);
    assert.equal(structure.schemaVersion, STRUCTURE_SCHEMA_VERSION);
    const view = structure.sunucu;
    const channel = (id) => view.kanallar.find((c) => c.id === id);
    assert.deepEqual(
      [channel(text.id).tur, channel(text.id).yazabilir, channel(mute.id).yazabilir],
      ['metin', true, false],
    );
    assert.deepEqual([channel(voice.id).tur, channel(voice.id).baglanabilir], ['ses', true]);
    assert.equal(channel(category.id).tur, 'kategori');
    const role = (id) => view.roller.find((r) => r.id === id);
    assert.deepEqual([role(low.id).verilebilir, role(low.id).tehlikeli, role(low.id).neden], [true, false, null]);
    assert.equal(role(high.id).verilebilir, false);
    assert.match(role(high.id).neden, /botun rolünden yukarıda/);
    assert.deepEqual([role(risky.id).verilebilir, role(risky.id).tehlikeli], [false, true]);
    assert.equal(
      view.roller.some((r) => r.id === GUILD),
      false,
      '@everyone is left out',
    );
    assert.equal(view.botRolPozisyonu, 50);
    assert.deepEqual(Object.keys(view.kanallar[0]).sort(), [
      'ad',
      'baglanabilir',
      'id',
      'kategori',
      'kategoriId',
      'tur',
      'yazabilir',
    ]);
  });

  it('the bridge writes one structure file per server and rewrites only the server an event is about', async () => {
    const context = await setup();
    const OTHER = '100000000000000077';
    const other = fakeGuild(context.client, { id: OTHER });
    context.client.guilds.cache.set(OTHER, other);
    const dir = tempDir();
    const bridge = attachDesktopBridge(context, { dataDir: dir, structureDelayMs: 5, viewDelayMs: 5 });
    bridge.start();
    started.push(bridge);
    const guildFile = (id) => join(dir, DESKTOP_FILES.yapi, `${id}.json`);
    const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
    for (const name of ['sema', 'gorunum']) assert.equal(read(join(dir, DESKTOP_FILES[name])).schemaVersion, 1, name);
    assert.deepEqual(readdirSync(join(dir, DESKTOP_FILES.yapi)).sort(), [`${GUILD}.json`, `${OTHER}.json`]);
    assert.ok(existsSync(join(dir, 'istekler')) && existsSync(join(dir, 'yanitlar')));
    const before = read(guildFile(GUILD)).sunucu.kanallar.length;
    const otherTime = statSync(guildFile(OTHER)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const added = context.guild.addText('yeni-kanal');
    context.client.emit(Events.ChannelCreate, added);
    context.client.emit(Events.ChannelCreate, added); // two events, one write
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = read(guildFile(GUILD)).sunucu.kanallar;
    assert.equal(after.length, before + 1);
    assert.equal(after.at(-1).ad, 'yeni-kanal');
    assert.equal(statSync(guildFile(OTHER)).mtimeMs, otherTime, 'the other server was not rewritten');
    context.client.guilds.cache.delete(OTHER);
    context.client.emit(Events.GuildDelete, other);
    assert.equal(existsSync(guildFile(OTHER)), false, 'a server the bot left loses its file');
    assert.equal(
      readdirSync(join(dir, DESKTOP_FILES.yapi)).filter((n) => n.includes('.yaziliyor')).length,
      0,
      'atomic writes leave no temporary files',
    );
    bridge.stop();
    assert.equal(context.client.listenerCount(Events.ChannelCreate), 0, 'stop removes its listeners');
  });

  it('a structure file that cannot be removed is logged and tried once more, never thrown', async () => {
    const dir = tempDir();
    const warnings = [];
    const later = [];
    let failures = 1;
    const fsFlaky = {
      ...nodeFs,
      rmSync: (file, options) => {
        if (failures-- > 0) throw Object.assign(new Error('meşgul'), { code: 'EPERM' });
        return nodeFs.rmSync(file, options);
      },
    };
    const files = createStructureFiles({
      dir,
      client: { guilds: { cache: new Map() } },
      logger: { ...silentLogger, warn: (text) => warnings.push(text) },
      fs: fsFlaky,
      timers: { ...noTimers, setTimeout: (fn) => later.push(fn) },
    });
    writeFileSync(join(dir, `${GUILD}.json`), '{}');
    assert.doesNotThrow(() => files.remove(GUILD));
    assert.match(warnings[0], /silinemedi .*EPERM/);
    assert.equal(existsSync(join(dir, `${GUILD}.json`)), true);
    later.forEach((fn) => fn());
    assert.equal(existsSync(join(dir, `${GUILD}.json`)), false, 'the retry removed it');
  });

  it('ayar-semasi.json describes every field; lists and Discord-only settings are marked', async () => {
    const context = await setup();
    const schema = buildSchemaExport(context.ozellikler);
    const module = (ad) => schema.moduller.find((m) => m.ad === ad);
    const field = (ad, key) => module(ad).alanlar.find((f) => f.anahtar === key);
    assert.deepEqual(schema.kategoriler.slice(0, 7), [
      'Müzik',
      'Oyun',
      'Seviye',
      'Karşılama',
      'Kayıt',
      'Odalar',
      'Bildirimler',
    ]);
    assert.equal(module('karsilama').kategori, 'Karşılama');
    assert.deepEqual(field('karsilama', 'hosgeldin-metni'), {
      anahtar: 'hosgeldin-metni',
      tur: 'metin',
      etiket: 'Hoş geldin metni',
      aciklama: 'Hoş geldin metni: {kullanıcı}, {ad}, {sunucu}, {üye_sayısı}',
      varsayilan: context.ozellikler.moduller.get('karsilama').ayarlar['hosgeldin-metni'].varsayilan,
      yalnizDiscord: null,
      enAz: 1,
      enFazla: 500,
    });
    assert.deepEqual(field('gecici-oda', 'kanal').kanalTurleri, ['ses']);
    assert.equal(field('karsilama', 'otorol-1').verilebilir, true);
    assert.equal(field('kayit', 'haric-1'), undefined, 'covered by the "haric" list');
    assert.deepEqual([field('kayit', 'haric').tur, field('kayit', 'haric').enFazla], ['kanal-listesi', 5]);
    assert.equal(field('seviye', 'roller').yalnizDiscord, '/seviye rol');
    assert.equal(field('roller-ve-ara', 'rol-panelleri').yalnizDiscord, '/ayar rol-menusu');
    assert.equal(field('ayarlar', 'kalici-panel').yalnizDiscord, '/ayar panel');
    const view = buildSettingsView(context).sunucular[GUILD];
    assert.equal(view.degerler['menu.panel-aralik'], 5);
    assert.deepEqual(view.listeler['kayit.haric'], []);
    assert.deepEqual(view.listeler['ayarlar.kalici-panel'], ['🎛️ Kalıcı panel: kurulmadı (/ayar panel)']);
  });

  it('plain text and labels for the app', () => {
    const guild = {
      channels: { cache: new Map([['222222222222222222', { name: 'genel' }]]) },
      roles: { cache: new Map() },
    };
    assert.equal(
      plainText('<#222222222222222222> ve <@&333333333333333333> **kalın** `kod`', guild),
      '#genel ve @silinmiş-rol kalın kod',
    );
    assert.equal(labelOf('Yeni odaların kişi sınırı (0 = sınırsız)'), 'Yeni odaların kişi sınırı');
    assert.equal(labelOf('Kartın arka plan rengi, ör. #2b2d31'), 'Kartın arka plan rengi');
    assert.equal(plainText(cevaplar.panelSatiri(null)), '🎛️ Kalıcı panel: kurulmadı (/ayar panel)');
    assert.equal(ChannelType.GuildText, 0);
  });
});
