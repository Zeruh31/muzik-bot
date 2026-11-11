// /ayar: subcommands generated from the modules' schemas, validation of every setting type, the
// "Sunucuyu Yönet" rule and the data/ozellikler.json store (atomic, schema version, corrupt file, reserved names).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { defineModule } from '../src/ozellikler/_ortak.js';
import { OzellikHatasi } from '../src/ozellikler/_yonlendirici.js';
import { createFeatureSettings, settingKey } from '../src/ozellikler/ayarlar/depo.js';
import { buildAyarData, createAyarCommand } from '../src/ozellikler/ayarlar/komut.js';
import { checkSchema, validateValue } from '../src/ozellikler/ayarlar/sema.js';

const GUILD = '111111111111111111';
const OTHER_GUILD = '999999999999999999';
const CHANNEL = '222222222222222222';
const ROLE = '333333333333333333';

const dirs = [];
function newFile() {
  const dir = mkdtempSync(join(tmpdir(), 'muzikbot-ayar-'));
  dirs.push(dir);
  return join(dir, 'ozellikler.json');
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const SCHEMA = {
  kanal: { tur: 'kanal', kanalTurleri: ['metin'] },
  'ses-kanali': { tur: 'kanal', kanalTurleri: ['ses'] },
  rol: { tur: 'rol', verilebilir: true },
  mesaj: { tur: 'metin', enAz: 2, enFazla: 20, varsayilan: 'Hoş geldin' },
  sayi: { tur: 'sayi', enAz: 1, enFazla: 10, varsayilan: 3 },
  acik: { tur: 'bayrak', varsayilan: false },
};
const ornek = defineModule({
  ad: 'ornek',
  mesajlar: {
    baslik: 'Örnek',
    emoji: '🧪',
    ayarlar: Object.fromEntries(Object.keys(SCHEMA).map((k) => [k, `${k} açıklaması`])),
  },
  ayarlar: SCHEMA,
});

const textChannel = (extra = {}) => ({
  id: CHANNEL,
  type: ChannelType.GuildText,
  guildId: GUILD,
  permissionsFor: () => ({ has: () => true }),
  ...extra,
});
const guild = (highest = 10) => ({ id: GUILD, members: { me: { roles: { highest: { position: highest } } } } });
const role = (extra = {}) => ({ id: ROLE, position: 5, managed: false, permissions: { has: () => false }, ...extra });

const refused = (fn, pattern) => assert.throws(fn, (e) => e instanceof OzellikHatasi && pattern.test(e.message));

describe('setting validation', () => {
  it('channel: type, other server and missing send permission are refused', () => {
    assert.equal(validateValue(SCHEMA.kanal, textChannel(), { guild: guild() }), CHANNEL);
    refused(
      () => validateValue(SCHEMA.kanal, textChannel({ type: ChannelType.GuildVoice }), { guild: guild() }),
      /metin/,
    );
    refused(() => validateValue(SCHEMA['ses-kanali'], textChannel(), { guild: guild() }), /ses/);
    refused(
      () => validateValue(SCHEMA.kanal, textChannel({ guildId: OTHER_GUILD }), { guild: guild() }),
      /bu sunucuda değil/,
    );
    refused(
      () =>
        validateValue(SCHEMA.kanal, textChannel({ permissionsFor: () => ({ has: () => false }) }), { guild: guild() }),
      /mesaj göremiyor/,
    );
  });

  it('role: @everyone, managed roles, dangerous permissions and roles above the bot are refused', () => {
    assert.equal(validateValue(SCHEMA.rol, role(), { guild: guild() }), ROLE);
    refused(() => validateValue(SCHEMA.rol, role({ id: GUILD }), { guild: guild() }), /@everyone/);
    refused(() => validateValue(SCHEMA.rol, role({ managed: true }), { guild: guild() }), /bota/);
    refused(
      () =>
        validateValue(
          SCHEMA.rol,
          role({ permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator } }),
          {
            guild: guild(),
          },
        ),
      /Yönetici/,
    );
    refused(() => validateValue(SCHEMA.rol, role({ position: 10 }), { guild: guild(10) }), /bot rolünü/);
    // Without "verilebilir" the hierarchy does not matter (e.g. a role that is only mentioned).
    assert.equal(validateValue({ tur: 'rol' }, role({ position: 50 }), { guild: guild(10) }), ROLE);
  });

  it('text, number and on/off', () => {
    assert.equal(validateValue(SCHEMA.mesaj, '  Merhaba  '), 'Merhaba');
    refused(() => validateValue(SCHEMA.mesaj, 'x'), /2-20/);
    refused(() => validateValue(SCHEMA.mesaj, 'x'.repeat(21)), /2-20/);
    refused(() => validateValue(SCHEMA.mesaj, 'a\u0007b'), /denetim/);
    assert.equal(validateValue(SCHEMA.sayi, 10), 10);
    refused(() => validateValue(SCHEMA.sayi, 11), /1 ile 10/);
    refused(() => validateValue(SCHEMA.sayi, 2.5), /tam sayı/);
    assert.equal(validateValue(SCHEMA.acik, true), true);
    refused(() => validateValue(SCHEMA.acik, 'evet'), /True/);
  });

  it('schemas with reserved names, unknown types or missing descriptions are refused', () => {
    const m = { ayarlar: { constructor: 'x' } };
    assert.throws(() => checkSchema('x', { constructor: { tur: 'bayrak' } }, m), /ayrılmış/);
    assert.throws(() => checkSchema('x', { goster: { tur: 'bayrak' } }, { ayarlar: { goster: 'x' } }), /ayrılmış/);
    assert.throws(() => checkSchema('x', { a: { tur: 'renk' } }, { ayarlar: { a: 'x' } }), /tür/);
    assert.throws(() => checkSchema('x', { a: { tur: 'bayrak' } }, { ayarlar: {} }), /açıklama/);
    assert.throws(
      () => checkSchema('x', { a: { tur: 'sayi', enAz: 1, enFazla: 3, varsayilan: 9 } }, { ayarlar: { a: 'x' } }),
      /varsayılan/,
    );
  });
});

describe('/ayar command definition', () => {
  it('has goster, panel and one group per module with one subcommand per setting', () => {
    const json = buildAyarData([ornek, defineModule({ ad: 'bos' })]).toJSON();
    assert.equal(json.name, 'ayar');
    assert.equal(json.default_member_permissions, String(PermissionFlagsBits.ManageGuild));
    const names = json.options.map((o) => o.name);
    assert.deepEqual(names, ['goster', 'panel', 'ornek'], 'modules without settings get no group');
    const group = json.options.find((o) => o.name === 'ornek');
    assert.equal(group.type, 2);
    assert.deepEqual(
      group.options.map((o) => o.name),
      Object.keys(SCHEMA),
    );
    const typeOf = (key) => group.options.find((o) => o.name === key).options.find((o) => o.name === 'deger');
    assert.equal(typeOf('kanal').type, 7);
    assert.deepEqual(typeOf('kanal').channel_types, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
    assert.equal(typeOf('rol').type, 8);
    assert.equal(typeOf('mesaj').max_length, 20);
    assert.equal(typeOf('sayi').min_value, 1);
    assert.equal(typeOf('acik').type, 5);
  });
});

describe('data/ozellikler.json', () => {
  const schemas = new Map([['ornek', SCHEMA]]);

  it('keeps values across restarts with a schema version; unset values give the default', () => {
    const file = newFile();
    const store = createFeatureSettings({ file, schemas });
    assert.equal(store.get(GUILD, 'ornek', 'sayi'), 3);
    assert.equal(store.isSet(GUILD, 'ornek', 'sayi'), false);
    store.set(GUILD, 'ornek', 'sayi', 7);
    store.set(GUILD, 'ornek', 'kanal', CHANNEL);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.sunucular[GUILD]['ornek.sayi'], 7);
    const again = createFeatureSettings({ file, schemas });
    assert.equal(again.get(GUILD, 'ornek', 'sayi'), 7);
    assert.equal(again.get(GUILD, 'ornek', 'kanal'), CHANNEL);
    again.set(GUILD, 'ornek', 'sayi', null);
    assert.equal(createFeatureSettings({ file, schemas }).get(GUILD, 'ornek', 'sayi'), 3);
    assert.ok(!readdirSync(join(file, '..')).some((f) => f.endsWith('.yaziliyor')), 'no temp file left');
  });

  it('a corrupt file is kept as ".bozuk-*" and the bot goes on with defaults', () => {
    const file = newFile();
    writeFileSync(file, '{ yarım');
    const store = createFeatureSettings({ file, schemas });
    assert.equal(store.get(GUILD, 'ornek', 'sayi'), 3);
    assert.ok(readdirSync(join(file, '..')).some((f) => f.startsWith('ozellikler.json.bozuk-')));
  });

  it('values that no longer fit the schema fall back to the default; "__proto__" keys are ignored', () => {
    const file = newFile();
    writeFileSync(
      file,
      `{"schemaVersion":1,"sunucular":{"${GUILD}":{"ornek.sayi":99,"__proto__":{"x":1},"ornek.constructor":1},"__proto__":{"ornek.sayi":5}}}`,
    );
    const store = createFeatureSettings({ file, schemas });
    assert.equal(store.get(GUILD, 'ornek', 'sayi'), 3);
    assert.equal({}.x, undefined);
    assert.throws(() => settingKey('ornek', 'constructor'), /Geçersiz/);
    assert.throws(() => store.set(GUILD, 'ornek', 'sayi', 99), /Geçersiz değer/);
  });

  it('a file from a newer version is never written back: defaults are used, changes are refused', () => {
    const file = newFile();
    const text = JSON.stringify({ schemaVersion: 2, sunucular: { [GUILD]: { 'ornek.sayi': 9, yeni: { x: 1 } } } });
    writeFileSync(file, text);
    const warnings = [];
    const store = createFeatureSettings({ file, schemas, logger: { warn: (t) => warnings.push(t) } });
    assert.equal(store.saltOkunur, true);
    assert.equal(store.get(GUILD, 'ornek', 'sayi'), 3);
    assert.throws(
      () => store.set(GUILD, 'ornek', 'sayi', 5),
      (e) => e instanceof OzellikHatasi && /daha yeni bir bot sürümüne/.test(e.message),
    );
    assert.equal(readFileSync(file, 'utf8'), text);
    assert.match(warnings[0], /şema 2/);
  });

  it('when the file cannot be written nothing changes and a Turkish error is thrown', () => {
    const file = newFile();
    const fs = {
      existsSync,
      readFileSync,
      mkdirSync() {},
      writeFileSync() {
        const error = new Error('busy');
        error.code = 'ENOSPC';
        throw error;
      },
      renameSync() {},
      rmSync() {},
    };
    const store = createFeatureSettings({ file, schemas, fs });
    assert.throws(
      () => store.set(GUILD, 'ornek', 'sayi', 5),
      (e) => e instanceof OzellikHatasi && /kaydedilemedi/.test(e.message),
    );
    assert.equal(store.get(GUILD, 'ornek', 'sayi'), 3);
  });
});

describe('/ayar command', () => {
  function setup() {
    const ayarlar = createFeatureSettings({ file: newFile(), schemas: new Map([['ornek', SCHEMA]]) });
    const ozellikler = {
      moduller: new Map([['ornek', ornek]]),
      ayarlar,
      disabledIntents: () => null,
      disabledReason: () => null,
      panel: { kanalOf: () => null },
    };
    return { ayarlar, context: { ozellikler } };
  }

  function interaction({ manage = true, group = 'ornek', sub, values = {}, sifirla = null } = {}) {
    const replies = [];
    return {
      replies,
      guildId: GUILD,
      guild: guild(),
      memberPermissions: { has: (flag) => manage && flag === PermissionFlagsBits.ManageGuild },
      options: {
        getSubcommandGroup: () => group,
        getSubcommand: () => sub,
        getBoolean: (name) => (name === 'sifirla' ? sifirla : (values[name] ?? null)),
        getInteger: (name) => values[name] ?? null,
        getString: (name) => values[name] ?? null,
        getChannel: (name) => values[name] ?? null,
        getRole: (name) => values[name] ?? null,
      },
      async reply(payload) {
        this.replied = true;
        replies.push(payload);
      },
    };
  }

  const text = (i) => i.replies[0].embeds[0].toJSON().description;

  it('is refused without "Sunucuyu Yönet" and changes nothing', async () => {
    const { ayarlar, context } = setup();
    const command = createAyarCommand([ornek]);
    const i = interaction({ manage: false, sub: 'sayi', values: { deger: 5 } });
    await command.execute(i, context);
    assert.match(text(i), /yetkin yok/);
    assert.equal(ayarlar.get(GUILD, 'ornek', 'sayi'), 3);
  });

  it('stores a valid value, shows the current one, resets to the default', async () => {
    const { ayarlar, context } = setup();
    const command = createAyarCommand([ornek]);
    await command.execute(interaction({ sub: 'sayi', values: { deger: 5 } }), context);
    assert.equal(ayarlar.get(GUILD, 'ornek', 'sayi'), 5);
    const show = interaction({ sub: 'sayi' });
    await command.execute(show, context);
    assert.match(text(show), /ornek sayi\*\*: 5/);
    await command.execute(interaction({ sub: 'sayi', sifirla: true }), context);
    assert.equal(ayarlar.isSet(GUILD, 'ornek', 'sayi'), false);
    await command.execute(interaction({ sub: 'kanal', values: { deger: textChannel() } }), context);
    assert.equal(ayarlar.get(GUILD, 'ornek', 'kanal'), CHANNEL);
  });

  it('a refused value and an unknown setting throw a Turkish error (shown by interactions.js)', async () => {
    const { context } = setup();
    const command = createAyarCommand([ornek]);
    await assert.rejects(
      command.execute(
        interaction({ sub: 'kanal', values: { deger: textChannel({ type: ChannelType.GuildVoice }) } }),
        context,
      ),
      OzellikHatasi,
    );
    await assert.rejects(command.execute(interaction({ sub: 'yok', values: {} }), context), /Böyle bir ayar yok/);
    await assert.rejects(command.execute(interaction({ group: 'toString', sub: 'x' }), context), /Böyle bir ayar yok/);
  });

  it('/ayar goster lists every setting with default marks', async () => {
    const { ayarlar, context } = setup();
    ayarlar.set(GUILD, 'ornek', 'acik', true);
    const command = createAyarCommand([ornek]);
    const i = interaction({ group: null, sub: 'goster' });
    await command.execute(i, context);
    const embed = i.replies[0].embeds[0].toJSON();
    assert.ok(i.replies[0].flags, 'ephemeral');
    const field = embed.fields.find((f) => f.name.includes('Örnek'));
    assert.match(field.value, /`acik`: Açık/);
    assert.match(field.value, /`sayi`: 3 _\(varsayılan\)_/);
    assert.match(field.value, /`kanal`: _ayarlanmadı_/);
  });
});
