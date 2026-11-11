// Feature module infrastructure: persistent customIds, the "oz:" router, module definitions and
// loading, and which gateway intents are asked for (with the fallback when Discord refuses one).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { Events, GatewayIntentBits } from 'discord.js';
import { registerInteractionHandler } from '../src/bot/interactions.js';
import { controlId } from '../src/bot/controls.js';
import { MusicError } from '../src/music/errors.js';
import { planIntents, startWithIntentFallback } from '../src/ozellikler/_intentler.js';
import { defineModule, ozId, parseOzId } from '../src/ozellikler/_ortak.js';
import { createRouter, OzellikHatasi } from '../src/ozellikler/_yonlendirici.js';
import { loadModules, moduleCommands } from '../src/ozellikler/index.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

/** A fake component interaction that records what it was answered with. */
function component(customId, extra = {}) {
  const replies = [];
  return {
    customId,
    replies,
    deferred: false,
    replied: false,
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    isButton: () => true,
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
    },
    async followUp(payload) {
      replies.push(payload);
    },
    ...extra,
  };
}

const textOf = (payload) => payload.embeds[0].toJSON().description;

describe('persistent customIds', () => {
  it('build and parse "oz:<modul>:<eylem>:args"', () => {
    const id = ozId('muzik', 'k', 'skip');
    assert.equal(id, 'oz:muzik:k:skip');
    assert.deepEqual(parseOzId(id), { modul: 'muzik', eylem: 'k', args: ['skip'] });
    assert.deepEqual(parseOzId('oz:menu:ac'), { modul: 'menu', eylem: 'ac', args: [] });
  });

  it('refuse ids over 100 characters, bad parts and other prefixes', () => {
    assert.throws(() => ozId('muzik', 'k', 'x'.repeat(100)), /100/);
    assert.throws(() => ozId('Muzik', 'k'));
    assert.throws(() => ozId('muzik', 'k', 'a:b'), /":"/);
    assert.equal(parseOzId('muzikbot-kontrol:skip'), null);
    assert.equal(parseOzId('sayfa:123:next'), null);
    assert.equal(parseOzId(`oz:muzik:${'x'.repeat(100)}`), null);
    assert.equal(parseOzId('oz:__proto__:x'), null);
  });
});

describe('module definitions', () => {
  it('refuse reserved and invalid names, unknown fields and bad menu sections', () => {
    assert.throws(() => defineModule({ ad: 'constructor' }), /ayrılmış/);
    assert.throws(() => defineModule({ ad: 'goster' }), /ayrılmış/);
    assert.throws(() => defineModule({ ad: 'Buyuk' }), /geçersiz/);
    assert.throws(() => defineModule({ ad: 'ornek', bilinmeyen: 1 }), /bilinmeyen alan/);
    assert.throws(() => defineModule({ ad: 'ornek', menu: { gorunurluk: 'herkes' } }), /ciz/);
    assert.throws(() => defineModule({ ad: 'ornek', menu: { gorunurluk: 'kimse', ciz() {} } }), /görünürlüğü/);
    assert.throws(() => defineModule({ ad: 'ornek', bilesenler: { 'Kötü:ad': () => {} } }), /eylemi/);
    assert.ok(defineModule({ ad: 'ornek', bilesenler: { git: () => {} } }));
    assert.throws(() => defineModule({ ad: 'ornek', izinler: ['Administrator'] }), /Administrator/);
    assert.throws(
      () => defineModule({ ad: 'ornek', menu: { kategori: 'yok', ciz() {} }, mesajlar: { baslik: 'x' } }),
      /kategori/,
    );
  });

  it('the bundled modules load; music is a menu section and its commands stay in src/commands', async () => {
    const modules = await loadModules();
    assert.deepEqual(
      modules.map((m) => m.ad),
      [
        'anket',
        'ayarlar',
        'cekilis',
        'gecici-oda',
        'karsilama',
        'kayit',
        'menu',
        'muzik',
        'roller-ve-ara',
        'sans',
        'seviye',
        'takim',
        'ucretsiz-oyunlar',
        'yardim',
      ],
    );
    const muzik = modules.find((m) => m.ad === 'muzik');
    assert.equal(muzik.menu.gorunurluk, 'herkes');
    assert.equal(modules.find((m) => m.ad === 'ayarlar').menu.gorunurluk, 'yonetici');
    const names = moduleCommands(modules).map((c) => c.data.name);
    assert.deepEqual(names.sort(), [
      'Bot menüsünü aç',
      'Seviyesini göster',
      'Takıma ekle',
      'ayar',
      'menu',
      'oyun',
      'seviye',
    ]);
  });
});

describe('component router', () => {
  const calls = [];
  const modules = new Map([
    [
      'ornek',
      defineModule({
        ad: 'ornek',
        bilesenler: {
          git: async (interaction, context, args) => calls.push(args),
          bozuk: async () => {
            throw new Error('iç hata');
          },
          red: async () => {
            throw new OzellikHatasi('Bunu yapamazsın.');
          },
          muzik: async () => {
            throw new MusicError('NOT_FOUND', 'Şarkı yok.');
          },
        },
      }),
    ],
    ['kapali', defineModule({ ad: 'kapali', bilesenler: { git: async () => calls.push('kapali') } })],
  ]);
  const router = createRouter(modules, {
    disabledReason: (name) => (name === 'kapali' ? 'Özellik kapalı.' : null),
    logger: silent,
  });

  it('calls the module handler with the arguments of the customId', async () => {
    const interaction = component('oz:ornek:git:a:b');
    assert.equal(await router.handle(interaction, {}), true);
    assert.deepEqual(calls.pop(), ['a', 'b']);
  });

  it('leaves other customIds alone', async () => {
    assert.equal(await router.handle(component('muzikbot-kontrol:skip'), {}), false);
    assert.equal(await router.handle(component('secim:1:0'), {}), false);
  });

  it('answers unknown actions, disabled modules and errors in Turkish, ephemerally', async () => {
    const unknown = component('oz:ornek:yok');
    await router.handle(unknown, {});
    assert.match(textOf(unknown.replies[0]), /artık geçerli değil/);
    assert.ok(unknown.replies[0].flags);

    const off = component('oz:kapali:git');
    await router.handle(off, {});
    assert.match(textOf(off.replies[0]), /Özellik kapalı/);
    assert.ok(!calls.includes('kapali'));

    for (const [action, pattern] of [
      ['red', /Bunu yapamazsın/],
      ['muzik', /Şarkı yok/],
      ['bozuk', /Beklenmeyen bir hata/],
    ]) {
      const interaction = component(`oz:ornek:${action}`);
      await router.handle(interaction, {});
      assert.match(textOf(interaction.replies[0]), pattern, action);
    }
  });

  it('interactions.js sends "oz:" ids to the router and keeps "muzikbot-kontrol:" for the music buttons', async () => {
    const client = new EventEmitter();
    const routed = [];
    let skipped = 0;
    const music = {
      getPlayer: () => ({ voiceChannelId: 'v' }),
      skip: async () => {
        skipped += 1;
      },
    };
    registerInteractionHandler({
      client,
      commands: new Map(),
      logger: silent,
      music,
      settings: { getDjRole: () => null },
      nowPlaying: { isCurrent: () => true },
      ozellikler: {
        router: {
          handle: async (interaction) => {
            routed.push(interaction.customId);
            return interaction.customId.startsWith('oz:');
          },
        },
      },
    });
    client.emit(Events.InteractionCreate, component('oz:menu:ac'));
    const button = component(controlId('skip'), {
      guildId: '1',
      guild: { members: { me: { voice: { channelId: 'v' } } }, voiceStates: { cache: new Map() } },
      member: { voice: { channel: { id: 'v' } } },
      user: { id: 'u' },
      message: { id: 'm' },
      deferUpdate: async () => {},
    });
    client.emit(Events.InteractionCreate, button);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(routed, ['oz:menu:ac', 'muzikbot-kontrol:skip']);
    assert.equal(skipped, 1, 'the now-playing button still works');
  });
});

describe('gateway intents', () => {
  const music = { ad: 'muzik', intentler: ['Guilds', 'GuildVoiceStates'] };
  const kayit = { ad: 'kayit', intentler: ['GuildMessages', 'MessageContent'] };
  const uyeler = { ad: 'karsilama', intentler: ['GuildMembers'] };

  it('only what the modules need: music alone asks for no privileged intent', () => {
    const plan = planIntents([music, { ad: 'menu' }]);
    assert.deepEqual(plan.names.sort(), ['GuildVoiceStates', 'Guilds']);
    assert.deepEqual(plan.privileged, []);
    assert.ok(!plan.intents.includes(GatewayIntentBits.GuildPresences));
  });

  it('adds what a module asks for; without privileged intents those modules are off', () => {
    const plan = planIntents([music, kayit, uyeler]);
    assert.deepEqual(plan.privileged.sort(), ['GuildMembers', 'MessageContent']);
    assert.ok(plan.intents.includes(GatewayIntentBits.GuildMessages));
    const fallback = planIntents([music, kayit, uyeler], { allowPrivileged: false });
    assert.deepEqual(fallback.privileged, []);
    assert.deepEqual([...fallback.disabled.keys()].sort(), ['karsilama', 'kayit']);
    assert.ok(!fallback.intents.includes(GatewayIntentBits.GuildMessages), 'GuildMessages only came with kayit');
    assert.throws(() => planIntents([{ ad: 'x', intentler: ['Yok'] }]), /bilinmeyen intent/);
  });

  it('when Discord refuses a privileged intent the bot starts again without it instead of crashing', async () => {
    const log = [];
    const errors = [];
    const result = await startWithIntentFallback({
      start: async ({ allowPrivileged }) => ({ plan: planIntents([music, uyeler], { allowPrivileged }) }),
      login: async (started) => {
        log.push(started.plan.privileged.join(',') || 'yok');
        if (started.plan.privileged.length) throw new Error('Used disallowed intents');
      },
      stop: async () => log.push('stop'),
      planOf: (started) => started.plan,
      logger: { error: (text) => errors.push(text) },
    });
    assert.deepEqual(log, ['GuildMembers', 'stop', 'yok']);
    assert.deepEqual([...result.plan.disabled.keys()], ['karsilama']);
    assert.match(errors[0], /Privileged Gateway Intents/);
    assert.match(errors[0], /karsilama/);
  });

  it('other login errors are not swallowed', async () => {
    await assert.rejects(
      startWithIntentFallback({
        start: async () => ({ plan: planIntents([music]) }),
        login: async () => {
          throw new Error('An invalid token was provided.');
        },
        stop: async () => {},
        planOf: (s) => s.plan,
      }),
      /invalid token/,
    );
  });
});
