// The desktop app (desktop/) starts the bot, reads its console and data/durum.json. These tests pin
// what it relies on: entry points, Lavalink files, .env key names, the console lines it parses, the
// status file schema and the settings bridge (data/sunucu-yapisi/<id>.json, ayar-semasi.json,
// ayarlar-gorunum.json, istekler/, yanitlar/; desktop/src/main/serverConfig.js reads them).
// If one of these fails, the desktop app would break too: change the desktop app together with it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { PROJECT_ROOT } from '../src/config.js';

const read = (file) => readFileSync(join(PROJECT_ROOT, file), 'utf8');

// Same patterns as desktop/src/main/logLine.js and supervisor.js.
const BOT_LINE = /^\[([^\]]+)\]\s+(DEBUG|INFO|WARN|ERROR)\s*\[([^\]]+)\]\s?(.*)$/;
const BOT_READY = /Discord'a giriş yapıldı:\s*(.+?)\s*\((\d+) sunucu\)/;

const ENV_KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'LAVALINK_PASSWORD',
  'LAVALINK_HOST',
  'LAVALINK_PORT',
  'LAVALINK_JAVA_MEMORY',
  'YOUTUBE_OAUTH_REFRESH_TOKEN',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'DEFAULT_VOLUME',
  'TWENTY_FOUR_SEVEN',
  'LEAVE_WHEN_EMPTY_SECONDS',
  'LEAVE_AFTER_QUEUE_END_SECONDS',
  'SEARCH_SOURCE',
  'MAX_QUEUE_SIZE',
  'EMBED_COLOR',
  'LOG_LEVEL',
  'PANEL_ENABLED',
  'DISCORD_CLIENT_SECRET',
  'PANEL_SESSION_SECRET',
  'PANEL_HOST',
  'PANEL_PORT',
  'PANEL_PUBLIC_URL',
  'PANEL_TRUST_PROXY',
  'PLAY_SHOW_CHOICES',
  'BOT_OWNER_IDS',
  'BRAND_SUPPORT_URL',
  'BRAND_AUTHOR_NAME',
  'BRAND_AUTHOR_URL',
];

describe('contract with the desktop app', () => {
  it('entry points exist and npm scripts still run them', () => {
    for (const file of [
      'src/index.js',
      'scripts/deploy-commands.js',
      'scripts/youtube-token.js',
      'scripts/kontrol.js',
      'lavalink/application.yml',
    ]) {
      assert.ok(existsSync(join(PROJECT_ROOT, file)), file);
    }
    const { scripts } = JSON.parse(read('package.json'));
    assert.equal(scripts.start, 'node src/index.js');
    assert.equal(scripts['deploy-commands'], 'node scripts/deploy-commands.js');
    assert.equal(scripts['youtube-token'], 'node scripts/youtube-token.js');
    assert.equal(scripts.kontrol, 'node scripts/kontrol.js');
    assert.match(read('lavalink/baslat.ps1'), /Lavalink\.jar/);
  });

  it('.env.example keeps every existing key name', () => {
    const keys = Object.keys(parseEnv(read('.env.example')));
    for (const key of ENV_KEYS) assert.ok(keys.includes(key), key);
  });

  it('console lines keep the "[date] LEVEL [scope] message" format', () => {
    const logger = new URL('../src/logger.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createLogger } from ${JSON.stringify(logger)};
         createLogger('bot').info("Discord'a giriş yapıldı: Müzik#1234 (3 sunucu)");
         createLogger('bot').child('lavalink').info('Lavalink bağlandı (yerel).');`,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, LOG_LEVEL: 'info' } },
    );
    const [ready, lavalink] = result.stdout.trim().split(/\r?\n/);
    assert.deepEqual(BOT_LINE.exec(ready).slice(2, 4), ['INFO', 'bot']);
    assert.deepEqual(BOT_READY.exec(ready).slice(1), ['Müzik#1234', '3']);
    assert.deepEqual(BOT_LINE.exec(lavalink).slice(2, 4), ['INFO', 'bot:lavalink']);
  });

  it('the messages the desktop app looks for are still printed', () => {
    assert.ok(
      read('src/app.js').includes(
        "logger.info(`Discord'a giriş yapıldı: ${readyClient.user.tag} (${readyClient.guilds.cache.size} sunucu)`);",
      ),
    );
    const lavalink = read('src/music/lavalink.js');
    for (const text of [
      'Lavalink bağlandı (',
      'Lavalink bağlantısı koptu',
      "Lavalink'e yeniden bağlanılıyor",
      "Lavalink'e ulaşılamıyor",
    ]) {
      assert.ok(lavalink.includes(text), text);
    }
    const panel = read('src/panel/index.js');
    for (const text of ['Web paneli açık: ${panel.publicUrl}', 'Web paneli açılmadı:', 'Web paneli başlatılamadı:']) {
      assert.ok(panel.includes(text), text);
    }
    assert.ok(read('src/index.js').includes('console.error(`\\nHATA: ${message}\\n`);'));
  });

  it('data/durum.json keeps the schema the desktop app reads (schemaVersion 1)', async () => {
    const { STATUS_FILE } = await import('../src/app.js');
    const { buildStatus, STATUS_SCHEMA_VERSION } = await import('../src/bot/durumDosyasi.js');
    assert.equal(STATUS_FILE, join(PROJECT_ROOT, 'data', 'durum.json'));
    assert.equal(STATUS_SCHEMA_VERSION, 1);
    const guild = {
      id: '111111111111111111',
      name: 'Sunucu',
      memberCount: 3,
      joinedTimestamp: 1,
      iconURL: () => null,
      voiceStates: { cache: new Map() },
    };
    const counters = { songsPlayed: 0, commandsUsed: 0, commands: {}, topSongs: [], songsByGuild: {} };
    const status = buildStatus({
      client: { user: null, ws: { ping: -1 }, guilds: { cache: new Map([[guild.id, guild]]) } },
      music: { nodeStats: () => null, getState: () => null },
      settings: { getDjRole: () => null },
      stats: { snapshot: () => ({ toplam: counters, oturum: counters }) },
      startedAt: Date.now(),
    });
    const keys = (object) => Object.keys(object).sort();
    assert.deepEqual(keys(status), [
      'bot',
      'lavalink',
      'pid',
      'running',
      'sayaclar',
      'schemaVersion',
      'sesliKomut', // added for voice commands (the app's status card)
      'sunucular',
      'updatedAt',
    ]);
    assert.deepEqual(keys(status.bot), [
      'avatarUrl',
      'guildCount',
      'id',
      'memberCount',
      'memory',
      'pingMs',
      'startedAt',
      'uptimeMs',
      'username',
      'versions',
    ]);
    assert.deepEqual(keys(status.bot.memory), ['heapTotal', 'heapUsed', 'rss']);
    assert.deepEqual(keys(status.lavalink), [
      'connected',
      'cpuLoad',
      'memoryUsed',
      'players',
      'playingPlayers',
      'uptimeMs',
      'version',
    ]);
    assert.deepEqual(keys(status.sayaclar), ['oturum', 'toplam']);
    assert.deepEqual(keys(status.sayaclar.toplam), [
      'commands',
      'commandsUsed',
      'songsByGuild',
      'songsPlayed',
      'topSongs',
    ]);
    assert.deepEqual(keys(status.sunucular[0]), [
      'djRole',
      'iconUrl',
      'id',
      'joinedAt',
      'memberCount',
      'name',
      'playing',
      'queueLength',
      'repeatMode',
      'songsPlayed',
      'voice',
      'volume',
    ]);
  });

  it('the settings bridge keeps its file names, schemas and request format (schemaVersion 1)', async () => {
    const { DESKTOP_DATA_DIR } = await import('../src/app.js');
    const { DESKTOP_FILES } = await import('../src/ozellikler/_masaustu/kopru.js');
    const { STRUCTURE_SCHEMA_VERSION, guildStructure, guildStructureFile } =
      await import('../src/ozellikler/_masaustu/yapi.js');
    const { SCHEMA_EXPORT_VERSION, VIEW_SCHEMA_VERSION } = await import('../src/ozellikler/_masaustu/gorunum.js');
    const { REQUEST_VERSION, REQUEST_NAME, CLAIMED_NAME, MAX_REQUEST_BYTES, parseRequest } =
      await import('../src/ozellikler/_masaustu/istekler.js');
    const { ChannelType } = await import('discord.js');
    assert.equal(DESKTOP_DATA_DIR, join(PROJECT_ROOT, 'data'));
    assert.deepEqual(
      { ...DESKTOP_FILES },
      {
        yapi: 'sunucu-yapisi',
        sema: 'ayar-semasi.json',
        gorunum: 'ayarlar-gorunum.json',
        istekler: 'istekler',
        yanitlar: 'yanitlar',
      },
    );
    assert.deepEqual(
      [STRUCTURE_SCHEMA_VERSION, SCHEMA_EXPORT_VERSION, VIEW_SCHEMA_VERSION, REQUEST_VERSION],
      [1, 1, 1, 1],
    );
    assert.equal(MAX_REQUEST_BYTES, 16 * 1024);
    assert.ok(REQUEST_NAME.test('0b7c9b2e-3f1d-4c2a-9e8f-1a2b3c4d5e6f.json'));
    assert.ok(!REQUEST_NAME.test('0b7c9b2e-3f1d-4c2a-9e8f-1a2b3c4d5e6f.json.tmp'));
    const istek = parseRequest(
      JSON.stringify({
        surum: 1,
        guildId: '111111111111111111',
        modul: 'karsilama',
        alan: 'hosgeldin-kanal',
        deger: null,
        istenen: new Date().toISOString(),
      }),
    );
    assert.equal(istek.modul, 'karsilama');
    const yes = { has: () => true };
    const guild = {
      id: '111111111111111111',
      name: 'Sunucu',
      ownerId: '1',
      members: { me: { permissions: yes, roles: { highest: { position: 9 } } } },
      channels: {
        cache: new Map([
          [
            '222222222222222222',
            { id: '222222222222222222', name: 'genel', type: ChannelType.GuildText, permissionsFor: () => yes },
          ],
        ]),
      },
      roles: {
        cache: new Map([
          [
            '333333333333333333',
            { id: '333333333333333333', name: 'Üye', position: 1, permissions: { has: () => false } },
          ],
        ]),
      },
    };
    const view = guildStructure(guild);
    assert.deepEqual(Object.keys(guildStructureFile(guild)).sort(), ['guncellendi', 'schemaVersion', 'sunucu']);
    // The bot claims a request by renaming it; the app may only take back the .json name.
    assert.ok(CLAIMED_NAME.test('0b7c9b2e-3f1d-4c2a-9e8f-1a2b3c4d5e6f.isleniyor'));
    const keys = (object) => Object.keys(object).sort();
    assert.deepEqual(keys(view), ['ad', 'botRolPozisyonu', 'id', 'kanallar', 'roller', 'rolleriYonetebilir']);
    assert.deepEqual(keys(view.kanallar[0]), [
      'ad',
      'baglanabilir',
      'id',
      'kategori',
      'kategoriId',
      'tur',
      'yazabilir',
    ]);
    assert.deepEqual(keys(view.roller[0]), [
      'ad',
      'id',
      'neden',
      'pozisyon',
      'renk',
      'tehlikeli',
      'verilebilir',
      'yonetilen',
    ]);
    // The answer file the app waits for.
    assert.match(
      read('src/ozellikler/_masaustu/istekler.js'),
      /surum: REQUEST_VERSION,\s*id,\s*ok: result\.ok,\s*hata: result\.hata,\s*yeniDeger: result\.yeniDeger,/,
    );
  });

  it('getState keeps every field the web panel reads; new fields are only added', async () => {
    const { MusicService } = await import('../src/music/MusicService.js');
    const { TrackQueue } = await import('../src/music/Queue.js');
    const { EventEmitter } = await import('node:events');
    const queue = new TrackQueue();
    queue.current = { info: { title: 'a', duration: 1000 } };
    const player = { guildId: 'g', queue, volume: 80, repeatMode: 'off', position: 0, getData: () => undefined };
    const engine = Object.assign(new EventEmitter(), { players: new Map([['g', player]]), getPlayer: () => player });
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const state = new MusicService({ lavalink: {}, engine, config: { music: {} }, logger: silent }).getState('g');
    assert.deepEqual(Object.keys(state).sort(), [
      'autoplay', // added for /autoplay
      'bassboost',
      'connected',
      'crossfade', // added for the crossfade setting (seconds, 0 = off)
      'current',
      'guildId',
      'hasPrevious', // added for /previous and the "previous" button
      'muted', // added for the voice command "sesi kapat" (volume 0, previous level remembered)
      'paused',
      'playing',
      'position',
      'positionAt',
      'queue',
      'queueDuration',
      'repeatMode',
      'textChannelId',
      'voiceChannelId',
      'volume',
    ]);
    assert.equal(state.autoplay, false);
    assert.equal(state.hasPrevious, false);
    assert.equal(state.crossfade, 0);
  });

  it('the voice command component: the app installs where the bot looks, with the files the bot runs', async () => {
    const { createRequire } = await import('node:module');
    const desktop = createRequire(import.meta.url)('../desktop/src/main/sttInstaller.js');
    const bot = await import('../src/ozellikler/sesli-komut/kurulum.js');
    for (const env of [{ LOCALAPPDATA: 'C:\\L' }, { SESLI_KOMUT_DIZINI: 'D:\\x' }]) {
      assert.equal(desktop.componentDir(env, 'win32'), bot.componentDir({ env, platform: 'win32' }));
    }
    assert.equal(desktop.pythonPath('R', 'win32'), bot.pythonPath('R', 'win32'));
    assert.equal(desktop.MANIFEST_NAME, bot.MANIFEST_NAME);
    assert.equal(desktop.MANIFEST_VERSION, bot.MANIFEST_VERSION);
    assert.deepEqual([...desktop.MODEL_NAMES], [...bot.MODEL_NAMES]);
    for (const file of ['stt/stt_worker.py', 'stt/model_indir.py', 'stt/requirements.txt', 'stt/requirements-gpu.txt'])
      assert.ok(existsSync(join(PROJECT_ROOT, file)), file);
    assert.equal(bot.WORKER_SCRIPT, join(PROJECT_ROOT, 'stt', 'stt_worker.py'));
    // Model names the installer downloads are the ones model_indir.py knows.
    const script = read('stt/model_indir.py');
    for (const name of desktop.MODEL_NAMES) assert.ok(script.includes(`"${name}": (`), name);
  });

  it('a kicked bot closes its player and the engine forgets it', async () => {
    // The voice connection is the bot's own (@discordjs/voice): a kick leaves it Disconnected
    // without a new channel, and GuildPlayer then destroys itself.
    const player = read('src/music/GuildPlayer.js');
    assert.ok(player.includes('VoiceConnectionStatus.Disconnected'));
    assert.ok(player.includes("this.destroy('Ses kanalından çıkarıldı')"));
    const { createVoiceEngine } = await import('../src/music/engine.js');
    const { EventEmitter } = await import('node:events');
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const engine = createVoiceEngine({
      client: { guilds: { cache: new Map() } },
      rest: { connected: true },
      config: { music: { twentyFourSeven: false, leaveAfterQueueEndSeconds: 1 } },
      logger: silent,
    });
    const created = engine.createPlayer({ guildId: '1', voiceChannelId: 'v', textChannelId: 't', volume: 80 });
    const gone = new Promise((resolve) => engine.once('playerDestroy', (p, reason) => resolve([p, reason])));
    await created.destroy('Ses kanalından çıkarıldı');
    assert.deepEqual(await gone, [created, 'Ses kanalından çıkarıldı']);
    assert.equal(engine.getPlayer('1'), null);
    assert.ok(EventEmitter.prototype.isPrototypeOf(engine), 'engine emits player events');
  });
});
