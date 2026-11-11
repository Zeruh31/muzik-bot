// Sesli komutun yaşam döngüsü ve kuralları, Discord'suz ve modelsiz: bot kanala girince dinleme ve işçi başlar,
// çıkınca durur; kapalı ya da kurulu olmayan sunucuda bot sağır kalır; hariç tutulanın sesi işlenmez; komutlar
// DJ, aynı kanal, durum, çift kanıt ve hız sınırı kurallarından geçer. Ayrıca GuildPlayer'ın selfDeaf ayarı.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { createSesliKomut, HIZ_SINIRI } from '../src/ozellikler/sesli-komut/yonetici.js';
import { Downsampler48kStereoTo16kMono } from '../src/ozellikler/sesli-komut/pcm.js';

const G = '111111111111111111';
const BOT = '999999999999999999';
const ALI = '222222222222222222';
const AYSE = '333333333333333333';
const DISARIDA = '444444444444444444';
const DJ = '555555555555555555';
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Opus double: a "packet" is already 48 kHz stereo PCM. */
class FakeOpus {
  decode(packet) {
    if (packet.length === 1) throw new Error('still encrypted');
    return packet;
  }
}

function fakeReceiver() {
  return {
    speaking: new EventEmitter(),
    subscribed: [],
    streams: new Map(),
    subscribe(userId) {
      const stream = new PassThrough({ objectMode: true });
      this.subscribed.push(userId);
      this.streams.set(userId, stream);
      return stream;
    },
  };
}

function stubWorkerFactory({ verifyText = null, retryText = () => null } = {}) {
  const made = [];
  const models = [];
  const create = (model) => {
    models.push(model);
    const w = Object.assign(new EventEmitter(), {
      state: 'yeni',
      stderrTail: '',
      sent: [],
      audioFrames: [],
      stopped: false,
      async start() {
        w.state = 'hazir';
        return { model: 'turbo', device: 'cuda', loadSec: 0, warmSec: 0 };
      },
      send: (m) => w.sent.push(m),
      audio: (key, pcm) => w.audioFrames.push([key, pcm.length]),
      verify: async (id) =>
        verifyText === null ? { gone: true } : { t: 'verified', id, text: verifyText(id), nsp: 0, cr: 1 },
      retried: [],
      retry: async (id, options) => {
        w.retried.push([id, options?.hotwords]);
        const text = retryText(id);
        return text === null ? { gone: true } : { t: 'retried', id, text, nsp: 0, cr: 1 };
      },
      ping: async () => ({ t: 'health' }),
      kill() {},
      async stop() {
        w.stopped = true;
        w.state = 'durdu';
      },
    });
    made.push(w);
    return w;
  };
  return { made, models, create };
}

function setup({
  acik = true,
  kurulu = true,
  djRole = null,
  verifyText = (id) => `müzik bot ${id}`,
  model = 'otomatik',
  tani = false,
  logger = silent,
  timers = globalThis,
  unknownLog = null,
} = {}) {
  const settings = new Map([
    ['acik', acik],
    ['uyandirma', 'müzik bot'],
    ['bildirim', true],
    ['model', 'otomatik'],
  ]);
  const sent = [];
  const textChannel = { id: 't', send: async (payload) => sent.push(payload.content) };
  const voiceStates = new Map([
    [BOT, { channelId: 'v' }],
    [ALI, { channelId: 'v' }],
    [AYSE, { channelId: 'v' }],
    [DISARIDA, { channelId: 'baska' }],
  ]);
  const member = (id, { bot = false, roles = [], manage = false } = {}) => ({
    id,
    displayName: { [ALI]: 'Ali', [AYSE]: 'Ayşe', [BOT]: 'Bot' }[id] ?? id,
    user: { id, bot, username: id },
    roles: { cache: new Map(roles.map((r) => [r, {}])) },
    permissions: { has: () => manage },
  });
  const guild = {
    id: G,
    voiceStates: { cache: voiceStates },
    members: {
      me: { id: BOT },
      cache: new Map([
        [BOT, member(BOT, { bot: true })],
        [ALI, member(ALI)],
        [AYSE, member(AYSE, { roles: [DJ] })],
      ]),
    },
  };
  const client = Object.assign(new EventEmitter(), {
    user: { id: BOT },
    guilds: { cache: new Map([[G, guild]]) },
    channels: { cache: new Map([['t', textChannel]]) },
  });
  const receiver = fakeReceiver();
  const listening = [];
  const player = {
    voiceReceiver: receiver,
    voiceChannelId: 'v',
    textChannelId: 't',
    connected: true,
    destroyed: false,
    setListening: (on) => listening.push(on),
  };
  const state = { current: { title: 'Şarkı' }, paused: false, volume: 100, hasPrevious: false, queue: [] };
  const calls = [];
  const music = Object.assign(new EventEmitter(), {
    getPlayer: (id) => (id === G && !player.destroyed ? player : null),
    getState: () => state,
    pause: async () => calls.push('pause'),
    resume: async () => calls.push('resume'),
    stop: async () => calls.push('stop'),
    stopKeepChannel: async () => calls.push('stopKeepChannel'),
    skip: async () => (calls.push('skip'), { title: 'Şarkı' }),
    setVolume: async (_g, v) => calls.push(`volume:${v}`),
    mute: async () => (calls.push('mute'), (state.muted = true)),
    unmute: async () => (calls.push('unmute'), (state.muted = false), 70),
    previous: async () => calls.push('previous'),
    shuffle: async () => calls.push('shuffle'),
    toggleTrackLoop: async () => (calls.push('loop'), 'track'),
    setRepeatMode: async (_g, mode) => (calls.push(`repeat:${mode}`), mode),
    setAutoplay: (_g, on) => (calls.push(`autoplay:${on}`), on),
    seek: async (_g, ms) => calls.push(`seek:${ms}`),
    skipTo: async (_g, n) => (calls.push(`skipTo:${n}`), { title: `Şarkı ${n}` }),
    playNext: async (_g, n) => calls.push(`playNext:${n}`),
    playSaved: async ({ playlistName, entries }) => (
      calls.push(`playSaved:${playlistName}`),
      { total: entries.length }
    ),
    resolve: async (query) => (
      calls.push(`resolve:${query}`),
      { kind: 'search', tracks: [{ title: 'Tarkan - Dudu' }] }
    ),
    playResolved: async ({ resolved }) => (
      calls.push('playResolved'),
      { kind: 'search', tracks: resolved.tracks, queuePosition: 0 }
    ),
  });
  const excluded = new Set();
  const retries = new Map(); // utterance id -> text a pass without prompt hears
  const workers = stubWorkerFactory({
    verifyText: verifyText && ((id) => texts.get(id) ?? ''),
    retryText: (id) => retries.get(id) ?? null,
  });
  const texts = new Map(); // utterance id -> text the "second pass" hears
  const context = {
    client,
    music,
    settings: { getDjRole: () => djRole },
    ozellikler: { ayarlar: { get: (_g, _m, key) => settings.get(key) } },
    status: { poke() {} },
    config: { voice: { model, tani } },
    playlists: {
      list: () => [{ name: 'Gece Listesi' }, { name: 'oyun' }],
      get: (_g, name) => ({ name, tracks: [{}, {}, {}] }),
    },
  };
  const clock = { t: 1_000_000 };
  const manager = createSesliKomut({
    now: () => clock.t,
    context,
    exclusions: { has: (g, u) => g === G && excluded.has(u) },
    status: () => ({ kurulu, dizin: 'X' }),
    createWorker: workers.create,
    Opus: FakeOpus,
    logger,
    timers,
    unknownLog,
  });
  let nextId = 0;
  /** The worker hears `text` from `userId`; the second pass hears `second` (default: the same). */
  const hear = async (
    userId,
    text,
    { second = text, nsp = 0.01, age = 0.2, vad = { onsetMs: 0, yapay: false }, promptless = null } = {},
  ) => {
    const id = ++nextId;
    texts.set(id, second);
    if (promptless !== null) retries.set(id, promptless);
    workers.made.at(-1).emit('message', { t: 'utt', id, k: `${G}:${userId}`, dur: 1.5, text, nsp, cr: 1, age, vad });
    await flush(10);
  };
  return {
    clock,
    workerModels: workers.models,
    manager,
    music,
    client,
    player,
    receiver,
    workers,
    sent,
    calls,
    state,
    settings,
    excluded,
    listening,
    voiceStates,
    hear,
    guild,
  };
}

describe('sesli komut: yaşam döngüsü', () => {
  it('kapalı sunucuda bot sağır kalır, dinleme ve işçi başlamaz', async () => {
    const t = setup({ acik: false });
    assert.equal(t.manager.listening(G), false);
    t.music.emit('voiceConnected', G);
    await flush();
    assert.equal(t.manager.sessions.size, 0);
    assert.equal(t.workers.made.length, 0);
    assert.deepEqual(t.receiver.subscribed, []);
    assert.deepEqual(t.sent, []);
  });

  it('bileşen kurulu değilse sağır kalır ve bunu bir kez söyler', async () => {
    const t = setup({ kurulu: false });
    assert.equal(t.manager.listening(G), false);
    t.music.emit('voiceConnected', G);
    t.music.emit('voiceConnected', G);
    await flush();
    assert.equal(t.workers.made.length, 0);
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0], /kurulu değil/);
  });

  it('açık sunucuda: kanala girince kanaldakilere abone olur, işçiyi başlatır, bildirim yazar; çıkınca durdurur', async () => {
    const t = setup();
    assert.equal(t.manager.listening(G), true);
    t.music.emit('voiceConnected', G);
    await flush();
    assert.equal(t.manager.sessions.size, 1);
    assert.deepEqual(t.receiver.subscribed.sort(), [ALI, AYSE].sort(), 'not the bot, not someone elsewhere');
    assert.equal(t.workers.made.length, 1);
    const w = t.workers.made[0];
    assert.ok(w.sent.some((m) => m.t === 'config' && m.hotwords));
    assert.ok(w.sent.some((m) => m.t === 'guild' && m.g === G && m.wake === 'müzik bot'));
    assert.match(
      t.sent[0],
      /🎙️ \*\*Sesli komut açık\*\* — kendini hariç tutmak için `\/muzik sesli-komut beni-dinleme`/,
    );
    assert.match(t.sent[0], /beni-dinleme/);
    // A reconnect (move) does not start a second session.
    t.music.emit('voiceConnected', G);
    await flush();
    assert.equal(t.workers.made.length, 1);
    assert.equal(t.sent.length, 1);
    t.music.emit('playerDestroyed', G);
    await flush();
    assert.equal(t.manager.sessions.size, 0);
    assert.equal(w.stopped, true, 'the worker is killed when the bot leaves (VRAM freed)');
    assert.ok(t.receiver.streams.get(ALI).destroyed, 'streams closed');
  });

  it('yeni gelen ve yeni konuşan kişi eklenir, kanaldan çıkan bırakılır', async () => {
    const t = setup();
    t.voiceStates.delete(AYSE);
    t.music.emit('voiceConnected', G);
    await flush();
    assert.deepEqual(t.receiver.subscribed, [ALI]);
    t.receiver.speaking.emit('start', AYSE);
    assert.deepEqual(t.receiver.subscribed, [ALI, AYSE]);
    t.receiver.speaking.emit('start', AYSE); // already subscribed
    assert.equal(t.receiver.subscribed.length, 2);
    // Gateway voice state updates: leaving the bot's channel closes the stream, joining opens one.
    const at = (id, channelId) => ({ id, channelId, guild: { id: G } });
    t.client.emit('voiceStateUpdate', at(ALI, 'v'), at(ALI, 'baska'));
    assert.ok(t.receiver.streams.get(ALI).destroyed);
    t.client.emit('voiceStateUpdate', at(DISARIDA, 'baska'), at(DISARIDA, 'v'));
    assert.deepEqual(t.receiver.subscribed, [ALI, AYSE, DISARIDA]);
    t.client.emit('voiceStateUpdate', at(BOT, 'v'), at(BOT, 'v2')); // the bot's own move: the connection handles it
    assert.equal(t.receiver.subscribed.length, 3);
  });

  it('ses Opus → 16 kHz mono olarak işçiye gider; çözülemeyen paket atlanır; susunca "idle"', async () => {
    const t = setup();
    t.music.emit('voiceConnected', G);
    await flush();
    const stream = t.receiver.streams.get(ALI);
    const frame = Buffer.alloc(960 * 4, 1); // 20 ms of 48 kHz stereo
    stream.write(frame);
    stream.write(Buffer.alloc(1)); // a packet DAVE could not decrypt
    stream.write(frame);
    await flush();
    const w = t.workers.made[0];
    const frames = w.audioFrames.filter(([key]) => key === `${G}:${ALI}`);
    assert.equal(frames.length, 2);
    assert.equal(
      frames[0][1] + frames[1][1],
      new Downsampler48kStereoTo16kMono().push(Buffer.concat([frame, frame])).length,
    );
    t.receiver.speaking.emit('end', ALI);
    await new Promise((r) => setTimeout(r, 450));
    assert.ok(w.sent.some((m) => m.t === 'idle' && m.k === `${G}:${ALI}`));
  });

  it('hariç tutulana abone olunmaz; sonradan hariç tutulanın akışı kapanır ve işçi onu unutur', async () => {
    const t = setup();
    t.excluded.add(AYSE);
    t.music.emit('voiceConnected', G);
    await flush();
    assert.deepEqual(t.receiver.subscribed, [ALI]);
    t.receiver.speaking.emit('start', AYSE);
    assert.deepEqual(t.receiver.subscribed, [ALI], 'packets of an excluded person are never decoded');
    t.excluded.add(ALI);
    t.manager.exclusionChanged(G, ALI, true);
    assert.ok(t.receiver.streams.get(ALI).destroyed);
    assert.ok(t.workers.made[0].sent.some((m) => m.t === 'end' && m.k === `${G}:${ALI}`));
    t.excluded.delete(ALI);
    t.manager.exclusionChanged(G, ALI, false);
    assert.equal(t.receiver.subscribed.filter((id) => id === ALI).length, 2, 'listened to again');
  });

  it('ayar açılınca bot sağırlığı kaldırır ve dinler; kapanınca durur ve yeniden sağır olur', async () => {
    const t = setup({ acik: false });
    t.settings.set('acik', true);
    await t.manager.ayarDegisti(G, 'acik');
    assert.deepEqual(t.listening, [true]);
    assert.equal(t.manager.sessions.size, 1);
    t.settings.set('acik', false);
    await t.manager.ayarDegisti(G, 'acik');
    assert.deepEqual(t.listening, [true, false]);
    assert.equal(t.manager.sessions.size, 0);
    assert.equal(t.workers.made[0].stopped, true);
  });

  it('uyandırma sözü değişince işçiye bildirilir', async () => {
    const t = setup();
    t.music.emit('voiceConnected', G);
    await flush();
    t.settings.set('uyandirma', 'Kutluay bot');
    await t.manager.ayarDegisti(G, 'uyandirma');
    assert.ok(t.workers.made[0].sent.some((m) => m.t === 'guild' && m.wake === 'Kutluay bot'));
    await t.hear(ALI, 'Kutluay bot, karıştır');
    assert.deepEqual(t.calls, [], 'karıştır needs two songs in the queue (state gate)');
    t.state.queue = [1, 2];
    await t.hear(ALI, 'Kutluay bot, karıştır');
    assert.deepEqual(t.calls, ['shuffle']);
  });
});

describe('sesli komut: komutların kuralları', () => {
  async function ready(options) {
    const t = setup(options);
    t.music.emit('voiceConnected', G);
    await flush();
    t.sent.length = 0;
    return t;
  }

  it('çalma: arar, sıraya koyar ve kanala yazar', async () => {
    const t = await ready();
    await t.hear(ALI, 'Müzik bot, Tarkan dudu dudu aç.');
    assert.deepEqual(t.calls, ['resolve:tarkan dudu dudu', 'playResolved']);
    assert.deepEqual(t.sent, ['🎙️ **Ali**: ▶️ Tarkan - Dudu çalıyorum']);
  });

  it('çift kanıt: ikinci geçiş aynı komutu vermezse uygulanmaz', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot duraklat', { second: 'müzik bot dur bakalım ne oldu' });
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.sent, []);
    await t.hear(ALI, 'müzik bot duraklat');
    assert.deepEqual(t.calls, ['pause']);
    assert.match(t.sent[0], /^🎙️ \*\*Ali\*\*: ⏸️ duraklatıldı — devam etmek için "Hey .+, devam et"$/);
    assert.equal(t.sent.length, 1);
  });

  it('çift kanıt: "durdur" da ikinci geçişte aynı komutu görmezse uygulanmaz', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot durdur', { second: 'müzik bot geç' });
    assert.deepEqual(t.calls, []);
    await t.hear(ALI, 'müzik bot durdur');
    assert.deepEqual(t.calls, ['pause']);
  });

  it('durum kapısı: duraklatılmışken "durdur" sessizce yok sayılır', async () => {
    const t = await ready();
    t.state.paused = true;
    await t.hear(ALI, 'müzik bot durdur');
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.sent, []);
  });

  it('durum kapısı: duraklatılmamışken "devam et" sessizce yok sayılır', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot devam et');
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.sent, []);
    t.state.paused = true;
    await t.hear(ALI, 'müzik bot devam et');
    assert.deepEqual(t.calls, ['resume']);
  });

  it('akustik kapı ve uyandırma sözü yoksa hiçbir şey olmaz; açık uyandırmada "anlamadım"', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot geç', { nsp: 0.8 });
    await t.hear(ALI, 'abi şu tarafa geç');
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.sent, []);
    await t.hear(ALI, 'müzik bot da var ne');
    assert.deepEqual(t.sent, ['🎙️ **Ali**: anlamadım']);
  });

  it('ses: ±20, sınırlar içinde', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot sesi kıs');
    t.state.volume = 140;
    await t.hear(ALI, 'müzik bot sesi aç');
    assert.deepEqual(t.calls, ['volume:80', 'volume:150']);
  });

  it('sessiz: "sesi kapat" kuyruğu silmez, sesi susturur; "sesi aç" geri açar; zaten sessizken yok sayılır', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot sesi kapat');
    assert.deepEqual(t.calls, ['mute']);
    assert.match(t.sent[0], /sesi kapattım/);
    // already muted: ignored silently
    await t.hear(ALI, 'müzik bot sesi kapat');
    assert.deepEqual(t.calls, ['mute']);
    assert.equal(t.sent.length, 1);
    // "sesi aç" while muted: back to the previous level, not +20
    await t.hear(ALI, 'müzik bot sesi aç');
    assert.deepEqual(t.calls, ['mute', 'unmute']);
    assert.match(t.sent[1], /ses geri açıldı \(70\)/);
    // not muted: "sesi geri aç" means nothing; "sesi aç" raises as before
    await t.hear(ALI, 'müzik bot sesi geri aç');
    assert.deepEqual(t.calls, ['mute', 'unmute']);
    await t.hear(ALI, 'müzik bot sesi aç');
    assert.deepEqual(t.calls.slice(2), ['volume:120']);
    // second pass disagrees: not applied
    await t.hear(ALI, 'müzik bot sesi kapat', { second: 'müzik bot geç' });
    assert.deepEqual(t.calls.slice(3), []);
    // explicit unmute
    await t.hear(ALI, 'müzik bot sesi kapat');
    await t.hear(ALI, 'müzik bot sessizden çıkar');
    assert.deepEqual(t.calls.slice(3), ['mute', 'unmute']);
  });

  it('mutlak konum: iki nokta üst üste yazımı konuma sarar', async () => {
    const t = await ready();
    t.state.current = { title: 'Şarkı', duration: 300_000 };
    await t.hear(ALI, "müzik bot 2:30'a al");
    assert.deepEqual(t.calls, ['seek:150000']);
  });

  it('DJ rolü: kural aynen geçerli (rolü olan, yönetici ya da botla yalnız kalan)', async () => {
    const t = await ready({ djRole: DJ });
    await t.hear(ALI, 'müzik bot geç');
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.sent, [`🎙️ **Ali**: ❌ bunun için <@&${DJ}> rolü gerekiyor`]);
    await t.hear(AYSE, 'müzik bot geç');
    assert.deepEqual(t.calls, ['skip']);
    // Playing a song is not a DJ command.
    await t.hear(ALI, 'müzik bot sezen aksu çal');
    assert.ok(t.calls.includes('playResolved'));
  });

  it('botla aynı kanalda olmayanın ve hariç tutulanın sesi komut olmaz', async () => {
    const t = await ready();
    await t.hear(DISARIDA, 'müzik bot geç');
    t.excluded.add(ALI);
    await t.hear(ALI, 'müzik bot geç');
    assert.deepEqual(t.calls, []);
  });

  it('kişi başına hız sınırı', async () => {
    const t = await ready();
    t.state.queue = [1, 2];
    for (let i = 0; i < HIZ_SINIRI.perUser + 2; i++) await t.hear(ALI, 'müzik bot karıştır');
    assert.equal(t.calls.length, HIZ_SINIRI.perUser);
    await t.hear(AYSE, 'müzik bot karıştır');
    assert.equal(t.calls.length, HIZ_SINIRI.perUser + 1, 'another person still can');
  });

  it('tek cümlede dört komut: yalnız ilki uygulanır', async () => {
    const t = await ready();
    await t.hear(ALI, 'Müzik bot, Tarkan dudu dudu aç. Müzik bot, müziği kapat. Müzik bot, geç. Müzik bot, sesi kıs.');
    assert.deepEqual(t.calls, ['resolve:tarkan dudu dudu', 'playResolved']);
  });

  it('müzik servisinin hatası kanala Türkçe yazılır', async () => {
    const t = await ready();
    const { MusicError, ErrorCodes } = await import('../src/music/errors.js');
    t.music.resolve = async () => {
      throw new MusicError(ErrorCodes.NOT_FOUND, 'Sonuç bulunamadı.');
    };
    await t.hear(ALI, 'müzik bot olmayan şarkı aç');
    assert.deepEqual(t.sent, ['🎙️ **Ali**: ❌ Sonuç bulunamadı.']);
  });
});

describe('GuildPlayer: sesli komut için selfDeaf', () => {
  function playerWith(listening) {
    const joins = [];
    const rejoins = [];
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Signalling },
      joinConfig: null,
      receiver: { marker: true },
      subscribe() {},
      rejoin(config) {
        rejoins.push(config);
        Object.assign(this.joinConfig, config);
        return true;
      },
      destroy() {
        this.state = { status: VoiceConnectionStatus.Destroyed };
      },
    });
    const events = [];
    const voice = {
      joinVoiceChannel: (options) => {
        joins.push(options);
        connection.joinConfig = { channelId: options.channelId, selfDeaf: options.selfDeaf };
        return connection;
      },
      createAudioPlayer: () => Object.assign(new EventEmitter(), { stop() {} }),
      entersState: async () => {
        const old = connection.state;
        connection.state = { status: VoiceConnectionStatus.Ready };
        connection.emit('stateChange', old, connection.state);
        return connection;
      },
    };
    const player = new GuildPlayer({
      guildId: G,
      voiceChannelId: 'v',
      textChannelId: 't',
      volume: 100,
      client: { guilds: { cache: new Map([[G, { voiceAdapterCreator: () => ({}) }]]) } },
      rest: {},
      config: { music: {} },
      logger: silent,
      emit: (name, ...args) => events.push([name, ...args]),
      voice,
      ...(listening === undefined ? {} : { listening }),
    });
    return { player, joins, rejoins, events, connection };
  }

  it('varsayılan ve özellik kapalıyken sağır katılır; alıcı verilmez', async () => {
    for (const listening of [undefined, () => false]) {
      const t = playerWith(listening);
      await t.player.connect();
      assert.equal(t.joins[0].selfDeaf, true);
      assert.equal(t.player.voiceReceiver, null);
    }
  });

  it('yalnız özelliği açık sunucuda sağır olmadan katılır ve hazır olunca haber verir', async () => {
    const asked = [];
    const t = playerWith((guildId) => (asked.push(guildId), guildId === G));
    await t.player.connect();
    assert.deepEqual(asked, [G]);
    assert.equal(t.joins[0].selfDeaf, false);
    assert.equal(t.joins[0].selfMute, false);
    assert.equal(t.player.voiceReceiver, t.connection.receiver);
    assert.deepEqual(
      t.events.filter(([name]) => name === 'voiceReady').map(([, p]) => p),
      [t.player],
    );
  });

  it('kanaldan çıkmadan sağırlığı açıp kapatır', async () => {
    const t = playerWith(() => false);
    await t.player.connect();
    assert.equal(t.player.setListening(true), true);
    assert.deepEqual(t.rejoins, [{ selfDeaf: false, selfMute: false }]);
    assert.equal(t.player.voiceReceiver, t.connection.receiver);
    t.player.setListening(false);
    assert.equal(t.player.voiceReceiver, null);
    await t.player.destroy('test');
    assert.equal(t.player.setListening(true), false, 'no connection any more');
  });
});

describe('sesli komut: denetim düzeltmeleri', () => {
  async function ready(options) {
    const t = setup(options);
    t.music.emit('voiceConnected', G);
    await flush();
    t.sent.length = 0;
    return t;
  }

  it('sesli "durdur" müziği duraklatır, kuyruğa dokunmaz; "devam et" sürdürür', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot müziği durdur');
    assert.deepEqual(t.calls, ['pause']);
    t.state.paused = true;
    await t.hear(ALI, 'müzik bot devam et');
    assert.deepEqual(t.calls, ['pause', 'resume']);
  });

  it('sesli "kapat" kuyruğu temizler ama bot kanalda kalır ve dinlemeye devam eder', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot müziği kapat');
    assert.deepEqual(t.calls, ['stopKeepChannel'], 'not stop(): /stop still leaves, the voice command does not');
    assert.deepEqual(t.sent, ['🎙️ **Ali**: ⏹️ müziği kapattım, kuyruk temizlendi']);
    assert.equal(t.manager.sessions.size, 1, 'still listening');
    assert.equal(t.workers.made[0].stopped, false);
  });

  it('5 sn\'den eski cümle ve söylendikten sonra şarkı değişmişse komut uygulanmaz ("çal" hariç)', async () => {
    const t = await ready();
    await t.hear(ALI, 'müzik bot geç', { age: 6 });
    assert.deepEqual(t.calls, []);
    // The song changed after the sentence ended (it ended 1 s ago, the song started 0.5 s ago).
    t.clock.t += 10_000;
    const startedAt = t.clock.t - 500;
    const real = t.clock.t;
    t.clock.t = startedAt;
    t.music.emit('trackStarted', G, { title: 'Yeni' });
    t.clock.t = real;
    await t.hear(ALI, 'müzik bot geç', { age: 1 });
    assert.deepEqual(t.calls, [], 'would have skipped the new song');
    await t.hear(ALI, 'müzik bot tarkan aç', { age: 1 });
    assert.deepEqual(t.calls, ['resolve:tarkan', 'playResolved'], 'a play command does not depend on the song');
    await t.hear(ALI, 'müzik bot geç', { age: 0.2 });
    assert.equal(t.calls.at(-1), 'skip', 'said after the change: applied');
  });

  it('bildirim: her girişte ve taşınmada, aynı kanalda 10 dakikada bir kez; kapatılamaz', async () => {
    const t = setup();
    t.music.emit('voiceConnected', G);
    await flush();
    assert.equal(t.sent.length, 1);
    // Leaves and comes back to the same channel soon: no second notice.
    t.music.emit('playerDestroyed', G);
    t.music.emit('voiceConnected', G);
    await flush();
    assert.equal(t.sent.length, 1);
    // Moved to another channel: told there.
    t.player.voiceChannelId = 'v2';
    t.client.emit(
      'voiceStateUpdate',
      { id: BOT, channelId: 'v', guild: { id: G } },
      { id: BOT, channelId: 'v2', guild: { id: G } },
    );
    assert.equal(t.sent.length, 2);
    t.music.emit('voiceConnected', G); // the reconnect after the move: same channel, no spam
    await flush();
    assert.equal(t.sent.length, 2);
    // Back in the first channel after 10 minutes: told again.
    t.player.voiceChannelId = 'v';
    t.clock.t += 10 * 60_000 + 1;
    t.music.emit('voiceConnected', G);
    await flush();
    assert.equal(t.sent.length, 3);
    assert.ok(t.sent.every((m) => m.includes('beni-dinleme')));
  });

  it("model sunucu ayarı değil: işçi .env'deki SESLI_KOMUT_MODEL ile başlar", async () => {
    const t = await ready({ model: 'small' });
    assert.deepEqual(t.workerModels, ['small']);
    await t.manager.ayarDegisti(G, 'model'); // no such server setting any more: nothing restarts
    assert.equal(t.workers.made.length, 1);
    const auto = await ready({ model: 'otomatik' });
    assert.deepEqual(auto.workerModels, ['auto']);
  });
});

describe('sesli komut: bozuk DAVE akışı', () => {
  it('art arda çözülemeyen paketlerde abonelik kapanır ve artan beklemeyle yeniden açılır', async () => {
    const { createListener, REOPEN_AFTER_ERRORS, REOPEN_BACKOFF_MS } =
      await import('../src/ozellikler/sesli-komut/dinleyici.js');
    const timers = [];
    const fakeTimers = {
      setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: (id) => timers[id - 1] && (timers[id - 1].fn = null),
    };
    const receiver = fakeReceiver();
    const events = [];
    const listener = await createListener({
      guildId: G,
      receiver,
      humans: () => [ALI],
      isBot: () => false,
      isExcluded: () => false,
      sink: { audio: () => events.push('audio'), idle: () => events.push('idle'), end: () => events.push('end') },
      Opus: FakeOpus,
      timers: fakeTimers,
    });
    const breakStream = () => {
      const stream = receiver.streams.get(ALI);
      for (let i = 0; i < REOPEN_AFTER_ERRORS; i++) stream.write(Buffer.alloc(1));
      return stream;
    };
    const fire = () => {
      const t = timers.findLast((x) => x.fn);
      const fn = t.fn;
      t.fn = null;
      fn();
      return t.ms;
    };
    await flush();
    const first = breakStream();
    await flush();
    assert.ok(first.destroyed);
    assert.ok(events.includes('idle'));
    receiver.speaking.emit('start', ALI); // talking on: no resubscribe before the backoff
    assert.equal(receiver.subscribed.length, 1);
    assert.equal(fire(), REOPEN_BACKOFF_MS[0]);
    assert.equal(receiver.subscribed.length, 2);
    breakStream();
    await flush();
    assert.equal(fire(), REOPEN_BACKOFF_MS[1], 'longer the second time');
    // A good packet resets the backoff.
    receiver.streams.get(ALI).write(Buffer.alloc(960 * 4, 1));
    await flush();
    breakStream();
    await flush();
    assert.equal(fire(), REOPEN_BACKOFF_MS[0]);
    listener.stop();
  });
});

describe('sesli komut: ikinci denetim', () => {
  async function ready(options) {
    const t = setup(options);
    t.music.emit('voiceConnected', G);
    await flush();
    t.sent.length = 0;
    return t;
  }

  it('şarkı değişince yalnız şarkıya bağlı komutlar (geç, önceki, tekrarla) reddedilir', async () => {
    const t = await ready();
    t.state.hasPrevious = true;
    t.clock.t += 10_000;
    const real = t.clock.t;
    t.clock.t = real - 500; // the song changed 0.5 s ago ...
    t.music.emit('trackStarted', G, { title: 'Yeni' });
    t.clock.t = real;
    const said = { age: 1 }; // ... after these sentences ended (1 s ago)
    for (const text of ['geç', 'önceki şarkı', 'tekrarla']) await t.hear(ALI, `müzik bot ${text}`, said);
    assert.deepEqual(t.calls, []);
    await t.hear(ALI, 'müzik bot duraklat', said);
    t.state.paused = true;
    await t.hear(ALI, 'müzik bot devam et', said);
    t.state.paused = false;
    await t.hear(ALI, 'müzik bot sesi kıs', said);
    await t.hear(AYSE, 'müzik bot müziği kapat', said);
    assert.deepEqual(t.calls, ['pause', 'resume', 'volume:80', 'stopKeepChannel']);
  });

  it('cümlenin yaşı işçi mesajı gelince sabitlenir: sırada bekleme de yaşa sayılır', async () => {
    const t = await ready();
    // The first command keeps the chain busy for 6 s (a slow search).
    t.music.resolve = async (query) => {
      t.clock.t += 6000;
      t.calls.push(`resolve:${query}`);
      return { kind: 'search', tracks: [{ title: 'A' }] };
    };
    const id1 = 9001;
    const id2 = 9002;
    const w = t.workers.made.at(-1);
    const utt = (id, text) => ({ t: 'utt', id, k: `${G}:${ALI}`, dur: 1.5, text, nsp: 0.01, cr: 1, age: 0.2 });
    w.emit('message', utt(id1, 'müzik bot tarkan aç'));
    w.emit('message', utt(id2, 'müzik bot karıştır')); // arrives now, handled after the 6 s wait
    t.state.queue = [1, 2];
    await flush(20);
    assert.deepEqual(t.calls, ['resolve:tarkan', 'playResolved'], 'the waiting command became too old');
  });
});

describe('sesli komut: tanı modu ve dakika sayacı', () => {
  function capture() {
    const lines = [];
    const log = { ...silent, info: (...a) => lines.push(a.join(' ')), child: () => log };
    return { lines, log };
  }
  const fakeInterval = () => {
    const ticks = [];
    return {
      ticks,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: (fn) => (ticks.push(fn), ticks.length),
      clearInterval: () => {},
    };
  };

  it('tanı modunda her cümle için tek satır: metin, ölçüler, uyandırma eşleşmesi ve sonuç', async () => {
    const { lines, log } = capture();
    const t = setup({ tani: true, logger: log });
    t.music.emit('voiceConnected', G);
    await flush();
    await t.hear(ALI, 'zik bot karıştır');
    await t.hear(ALI, 'abi şu tarafa geç');
    const diag = lines.filter((l) => l.startsWith('[sesli-komut tanı]'));
    assert.equal(diag.length, 2);
    assert.match(diag[0], /metin="zik bot karıştır"/);
    assert.match(diag[0], /uyandırma=tam 'zik bot' mesafe 2 konum 0/);
    assert.match(diag[0], /sonuç=yoksay:durum/, 'karıştır with an empty queue');
    assert.match(diag[0], /nsp=0\.01 cr=1/);
    assert.match(diag[0], /kişi=[0-9a-f]{8} /);
    assert.ok(!diag[0].includes(ALI), 'the user id itself is not written');
    assert.match(diag[1], /süre=1\.5sn .*sonuç=yoksay:uyandirma$/);
    assert.ok(!diag[1].includes('tarafa'), 'ordinary talk: never its text, even in diagnosis mode');
    // What the worker dropped is shown too.
    t.workers.made[0].emit('message', {
      t: 'skip',
      k: `${G}:${ALI}`,
      why: 'vad',
      dur: 1.2,
      vad: { bitis: 'tetiklenmedi', tepe: 0.3 },
    });
    assert.match(lines.at(-1), /işçi attı: vad süre=1\.2sn vad=\{"bitis":"tetiklenmedi","tepe":0\.3\}/);
  });

  it('tanı modu kapalıyken metin yazılmaz; dakikada bir yalnız sayılar', async () => {
    const { lines, log } = capture();
    const timers = fakeInterval();
    const t = setup({ logger: log, timers });
    t.music.emit('voiceConnected', G);
    await flush();
    t.receiver.streams.get(ALI).write(Buffer.alloc(960 * 4, 1));
    await flush();
    await t.hear(ALI, 'abi şu tarafa geç');
    await t.hear(ALI, 'müzik bot da var ne');
    t.workers.made[0].emit('message', { t: 'skip', k: `${G}:${ALI}`, why: 'short' });
    assert.ok(!lines.some((l) => l.includes('tarafa') || l.includes('[sesli-komut tanı]')));
    timers.ticks[0]();
    const summary = lines.at(-1);
    assert.match(summary, /Sesli komut \(son 1 dk\): 1 sunucuda dinleniyor, 1 ses çerçevesi, 2 cümle/);
    assert.match(summary, /"yoksay:uyandirma":1/);
    assert.match(summary, /"anlamadim":1/);
    assert.match(summary, /"short":1/);
    assert.ok(!summary.includes('tarafa'));
  });
});

describe('sesli komut: yeni niyetler müzik servisine gider', () => {
  async function ready(options) {
    const t = setup(options);
    t.music.emit('voiceConnected', G);
    await flush();
    t.sent.length = 0;
    return t;
  }

  it('ses yüzdesi, sarma, başa sarma, sıraya atlama, döngü ve otomatik çalma', async () => {
    const t = await ready();
    t.state.current = { title: 'Şarkı', author: 'Sanatçı', duration: 200_000, isStream: false };
    t.state.position = 50_000;
    t.state.queue = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
    t.state.repeatMode = 'track';
    t.state.autoplay = false;
    await t.hear(ALI, 'müzik bot sesi yüzde elli yap');
    await t.hear(ALI, 'müzik bot otuz saniye ileri sar');
    await t.hear(ALI, 'müzik bot 1 dakika geri al');
    await t.hear(ALI, 'müzik bot başa sar');
    await t.hear(ALI, 'müzik bot üçüncü şarkıya geç');
    await t.hear(AYSE, 'müzik bot listeyi tekrarla'); // Ali reached 5 commands in 30 s
    await t.hear(AYSE, 'müzik bot döngüyü kapat');
    await t.hear(AYSE, 'müzik bot otomatik çalmayı aç');
    assert.deepEqual(t.calls, [
      'volume:50',
      'seek:80000',
      'seek:0',
      'seek:0',
      'skipTo:3',
      'repeat:queue',
      'repeat:off',
      'autoplay:true',
    ]);
    assert.match(t.sent[1], /01:20|1:20/);
    assert.match(t.sent[4], /3\. şarkıya geçtim: Şarkı 3/);
  });

  it('bilgi niyetleri yalnız yazar, çift kanıt ve DJ istemez', async () => {
    const t = await ready({ djRole: DJ, verifyText: null });
    t.state.current = { title: 'Gülümse', author: 'Sezen Aksu' };
    t.state.queue = [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }];
    await t.hear(ALI, 'müzik bot çalan şarkı ne');
    await t.hear(ALI, 'müzik bot sırada ne var');
    await t.hear(ALI, 'müzik bot kaç şarkı var');
    assert.deepEqual(t.calls, []);
    assert.match(t.sent[0], /şu an Gülümse — Sezen Aksu çalıyor/);
    assert.match(t.sent[1], /sırada 1\. A, 2\. B, 3\. C ve 1 şarkı daha/);
    assert.match(t.sent[2], /sırada 4 şarkı var/);
  });

  it('kuyruğa ekle, hemen çal (/playfirst gibi) ve kayıtlı liste', async () => {
    const t = await ready();
    t.music.playResolved = async () => (
      t.calls.push('playResolved'),
      { kind: 'search', tracks: [{ title: 'X' }], queuePosition: 4 }
    );
    await t.hear(ALI, "müzik bot Tarkan'ı sıraya ekle");
    await t.hear(ALI, 'müzik bot hemen Sezen Aksu çal');
    await t.hear(ALI, 'müzik bot gece listesi listesini çal');
    await t.hear(ALI, 'müzik bot olmayan listemi çal');
    assert.deepEqual(t.calls, [
      'resolve:tarkan',
      'playResolved',
      'resolve:sezen aksu',
      'playResolved',
      'playNext:4',
      'playSaved:Gece Listesi',
    ]);
    assert.match(t.sent[0], /X sıraya eklendi \(4\.\)/);
    assert.match(t.sent[1], /X sıradaki şarkı oldu/);
    assert.match(t.sent[2], /Gece Listesi listesi çalıyor \(3 şarkı\)/);
    assert.match(t.sent[3], /"olmayan" adında bir liste bulamadım/);
  });

  it('anlaşılmayan ama yakın bir cümlede öneri; tanı modunda anlaşılmayanlar kaydedilir, kapalıyken asla', async () => {
    for (const tani of [true, false]) {
      const added = [];
      const t = setup({ tani, unknownLog: { add: (text) => added.push(text) } });
      t.music.emit('voiceConnected', G);
      await flush();
      t.sent.length = 0;
      await t.hear(ALI, 'müzik bot sesi kıss');
      await t.hear(ALI, 'müzik bot naber');
      assert.deepEqual(t.sent, ['🎙️ **Ali**: anlamadım — "sesi kıs" mı dediniz?', '🎙️ **Ali**: anlamadım']);
      assert.deepEqual(added, tani ? ['müzik bot sesi kıss', 'müzik bot naber'] : [], `tanı ${tani}`);
    }
  });
});

describe('sesli komut: üçüncü denetim', () => {
  async function ready(options) {
    const t = setup(options);
    t.music.emit('voiceConnected', G);
    await flush();
    t.sent.length = 0;
    return t;
  }

  it('ipucusuz geçiş yalnız metin uyandırma sözü olmadan bir komutsa istenir', async () => {
    const t = await ready();
    t.state.queue = [{ title: 'A' }];
    await t.hear(ALI, 'abi şu tarafa geç', { promptless: 'müzik bot sırada ne var' });
    assert.deepEqual(t.workers.made[0].retried, [], 'ordinary talk: no second pass');
    await t.hear(ALI, 'Sırada ne var?', { promptless: 'müzik bot sırada ne var' });
    assert.deepEqual(
      t.workers.made[0].retried.map(([, hw]) => hw),
      [true],
    );
    assert.match(t.sent[0], /sırada 1\. A/);
    await t.hear(ALI, 'Sırada ne var?', { promptless: 'sırada ne var' }); // still no wake phrase: nothing
    assert.equal(t.sent.length, 1);
  });

  it('tanı modu kapalıyken eski anlaşılmayan dosyası açılışta silinir; açıkken kalır', async () => {
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { createSesliKomut } = await import('../src/ozellikler/sesli-komut/yonetici.js');
    const dir = mkdtempSync(join(tmpdir(), 'sk-anl-'));
    const file = join(dir, 'sesli-komut-anlasilmayan.json');
    const make = (tani) =>
      createSesliKomut({
        context: { music: new EventEmitter(), client: new EventEmitter(), config: { voice: { tani } } },
        exclusions: { has: () => false },
        status: () => ({ kurulu: true }),
        createWorker: () => null,
        logger: silent,
        unknownFile: file,
        timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout, clearTimeout },
      });
    writeFileSync(file, '{}');
    make(true);
    assert.equal(existsSync(file), true);
    make(false);
    assert.equal(existsSync(file), false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('kişi etiketi her açılışta başka tuzla üretilir', async () => {
    const tags = [];
    for (let i = 0; i < 2; i++) {
      const lines = [];
      const log = { ...silent, info: (...a) => lines.push(a.join(' ')), child: () => log };
      const t = setup({ tani: true, logger: log });
      t.music.emit('voiceConnected', G);
      await flush();
      await t.hear(ALI, 'abi şu tarafa geç');
      tags.push(/kişi=([0-9a-f]{8})/.exec(lines.find((l) => l.includes('[sesli-komut tanı]')))[1]);
    }
    assert.notEqual(tags[0], tags[1]);
  });
});
