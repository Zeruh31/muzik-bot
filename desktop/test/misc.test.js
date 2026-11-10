'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { GROUPS, FIELDS, validateField, validateValues, restartNeeds } = require('../src/main/envSchema');
const { LogStore, RotatingFileWriter } = require('../src/main/logStore');
const { parseKontrolOutput, summarizeScript } = require('../src/main/toolOutput');
const { downloadVerified, LAVALINK_SHA256, LAVALINK_VERSION, sha256File } = require('../src/main/downloader');
const { SettingsStore } = require('../src/main/settingsStore');
const { parseNetstatListeners, parseTasklistCsv, ctrlCScript } = require('../src/main/winproc');
const { parseEnv } = require('../src/main/envFile');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'muzikbot-misc-'));

test('settings form covers every key of .env.example in the six groups', () => {
  assert.deepEqual(
    GROUPS.map((g) => g.title),
    ['Discord', 'Lavalink', 'YouTube', 'Spotify', 'Müzik davranışı', 'Görünüm', 'Web paneli'],
  );
  for (const field of FIELDS.values()) assert.ok(field.help, `${field.key} has a description`);
  const example = path.join(__dirname, '..', '..', '.env.example');
  if (!fs.existsSync(example)) return;
  const keys = Object.keys(parseEnv(fs.readFileSync(example, 'utf8')));
  for (const key of keys) assert.ok(FIELDS.has(key), `${key} from .env.example is in the form`);
});

test('field validation mirrors src/config.js', () => {
  assert.equal(validateField('DISCORD_TOKEN', ''), 'Bu alan zorunlu.');
  assert.equal(validateField('DISCORD_GUILD_ID', ''), null);
  assert.match(validateField('DISCORD_CLIENT_ID', '12ab'), /rakam/);
  assert.equal(validateField('DISCORD_CLIENT_ID', '123456789012345678'), null);
  assert.match(validateField('LAVALINK_PORT', '0'), /1 ile 65535/);
  assert.match(validateField('DEFAULT_VOLUME', '1.5'), /tam sayı/);
  assert.equal(validateField('TWENTY_FOUR_SEVEN', 'evet'), null);
  assert.match(validateField('TWENTY_FOUR_SEVEN', 'belki'), /true/);
  assert.match(validateField('SEARCH_SOURCE', 'spsearch'), /ytmsearch/);
  assert.match(validateField('EMBED_COLOR', '#12345'), /6 haneli/);
  assert.match(validateField('PANEL_PUBLIC_URL', 'http://127.0.0.1:3000/x'), /yol olmamalı/);
  assert.equal(validateField('PANEL_PUBLIC_URL', 'https://panel.example.com'), null);
  assert.match(validateField('UNKNOWN', 'a\nb'), /tek satır/);
  assert.equal(validateField('BOT_OWNER_IDS', ''), null);
  assert.equal(validateField('BOT_OWNER_IDS', '123456789012345678, 234567890123456789'), null);
  assert.match(validateField('BOT_OWNER_IDS', '123456789012345678;abc'), /Virgülle ayrılmış/);
  assert.equal(validateField('PLAY_SHOW_CHOICES', 'false'), null);
  assert.equal(FIELDS.get('PLAY_SHOW_CHOICES').group, 'music');
  assert.equal(FIELDS.get('PLAY_SHOW_CHOICES').default, 'true');
  assert.equal(FIELDS.get('BOT_OWNER_IDS').group, 'discord');
  assert.equal(FIELDS.get('BRAND_SUPPORT_URL').group, 'appearance');
  assert.equal(validateField('BRAND_SUPPORT_URL', ''), null, 'empty: not shown in /help');
  assert.equal(validateField('BRAND_SUPPORT_URL', 'https://discord.com/invite/abc123'), null);
  assert.match(validateField('BRAND_AUTHOR_URL', 'http://example.com'), /https:\/\//);
  assert.match(validateField('BRAND_AUTHOR_URL', 'javascript:alert(1)'), /https:\/\//);
  assert.match(validateField('BRAND_AUTHOR_NAME', 'x'.repeat(65)), /64/);
  assert.deepEqual(restartNeeds(['BRAND_AUTHOR_NAME']), { lavalink: false, bot: true });
  assert.deepEqual(Object.keys(validateValues({ LAVALINK_PORT: 'x', DEFAULT_VOLUME: '80' })), ['LAVALINK_PORT']);
  assert.deepEqual(restartNeeds(['DEFAULT_VOLUME']), { lavalink: false, bot: true });
  assert.deepEqual(restartNeeds(['SPOTIFY_CLIENT_ID']), { lavalink: true, bot: false });
  assert.deepEqual(restartNeeds(['LAVALINK_PASSWORD']), { lavalink: true, bot: true });
});

test('log store filters and rotates files', () => {
  const dir = tempDir();
  try {
    const store = new LogStore({ dir, limit: 3, writerOptions: { maxBytes: 120, keep: 2, flushMs: 0 } });
    const seen = [];
    store.onEntry((e) => seen.push(e.id));
    store.add('bot', 'info', 'Discord’a bağlanılıyor');
    store.add('lavalink', 'warn', 'Suspicious exception');
    store.add('bot', 'error', 'HATA: token geçersiz');
    store.add('app', 'info', 'dördüncü');
    assert.equal(store.entries.length, 3, 'memory limit');
    assert.deepEqual(seen, [1, 2, 3, 4]);
    assert.deepEqual(
      store.query({ sources: ['bot'] }).map((e) => e.id),
      [3],
    );
    assert.deepEqual(
      store.query({ levels: ['warn', 'error'] }).map((e) => e.id),
      [2, 3],
    );
    assert.deepEqual(
      store.query({ search: 'HATA' }).map((e) => e.id),
      [3],
    );
    assert.deepEqual(
      store.query({ search: 'DÖRDÜNCÜ' }).map((e) => e.id),
      [4],
      'Turkish case-insensitive search',
    );

    for (let i = 0; i < 20; i += 1) store.add('bot', 'info', `line ${i} ${'x'.repeat(20)}`);
    store.flush();
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['app.log', 'bot.1.log', 'bot.2.log', 'bot.log', 'lavalink.log']);
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 120, `${f} respects maxBytes`);
    assert.match(fs.readFileSync(path.join(dir, 'bot.log'), 'utf8'), /line 19/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batched writer flushes on demand', () => {
  const dir = tempDir();
  try {
    const writer = new RotatingFileWriter(path.join(dir, 'x.log'), { flushMs: 10_000 });
    writer.write('a');
    writer.write('b');
    assert.equal(fs.existsSync(path.join(dir, 'x.log')), false);
    writer.flush();
    assert.equal(fs.readFileSync(path.join(dir, 'x.log'), 'utf8'), 'a\nb\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kontrol.js output becomes a list', () => {
  const output = [
    '',
    'Müzik botu kurulum kontrolü',
    '',
    '  [TAMAM] Node.js v24.16.0',
    '  [UYARI] Spotify anahtarları boş: Spotify bağlantıları çalışmaz (YouTube çalışır).',
    '  [SORUN] Lavalink\'e ulaşılamadı (http://127.0.0.1:2333). Ayrı bir pencerede "npm run lavalink" açık mı?',
    '',
    '1 sorun bulundu. Yukarıdaki [SORUN] satırlarını düzeltin.',
  ].join('\r\n');
  const parsed = parseKontrolOutput(output);
  assert.deepEqual(
    parsed.items.map((i) => i.status),
    ['ok', 'warn', 'bad'],
  );
  assert.equal(parsed.items[0].text, 'Node.js v24.16.0');
  assert.equal(parsed.problems, 1);
  assert.match(parsed.summary, /1 sorun bulundu/);
});

test('helper script summaries', () => {
  assert.deepEqual(summarizeScript(1, '', "\nHATA: Discord token'ı geçersiz (.env > DISCORD_TOKEN).\n\n"), {
    ok: false,
    message: "Discord token'ı geçersiz (.env > DISCORD_TOKEN).",
  });
  assert.deepEqual(
    summarizeScript(
      0,
      'Komut tanımları geçerli: 2 komut (/play, /skip)\nTamam: 2 komut tüm sunuculara kaydedildi.\n',
      '',
    ),
    { ok: true, message: 'Komut tanımları geçerli: 2 komut (/play, /skip)\nTamam: 2 komut tüm sunuculara kaydedildi.' },
  );
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('download keeps the file only when SHA-256 matches (follows redirects)', async () => {
  const dir = tempDir();
  const content = Buffer.from('fake lavalink jar content');
  const good = crypto.createHash('sha256').update(content).digest('hex');
  const dest = path.join(dir, 'lavalink', 'Lavalink.jar');
  try {
    await withServer(
      (req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/file' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': content.length });
        res.end(content);
      },
      async (base) => {
        const progress = [];
        await assert.rejects(
          downloadVerified({ url: `${base}/redirect`, dest, sha256: '0'.repeat(64) }),
          (error) => error.code === 'SHA_MISMATCH',
        );
        assert.equal(fs.existsSync(dest), false, 'bad file removed');
        assert.equal(fs.existsSync(`${dest}.indiriliyor`), false, 'temp file removed');

        assert.deepEqual(
          await downloadVerified({ url: `${base}/redirect`, dest, sha256: good, onProgress: (p) => progress.push(p) }),
          {
            status: 'downloaded',
          },
        );
        assert.equal(await sha256File(dest), good);
        assert.deepEqual(progress.at(-1), { received: content.length, total: content.length });
        assert.deepEqual(await downloadVerified({ url: `${base}/never-called`, dest, sha256: good }), {
          status: 'present',
        });
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pinned Lavalink release matches lavalink/indir.ps1', () => {
  const script = path.join(__dirname, '..', '..', 'lavalink', 'indir.ps1');
  if (!fs.existsSync(script)) return;
  const text = fs.readFileSync(script, 'utf8');
  assert.equal(/\$Version = '([^']+)'/.exec(text)?.[1], LAVALINK_VERSION);
  assert.equal(/\$ExpectedSha256 = '([^']+)'/.exec(text)?.[1], LAVALINK_SHA256);
});

test('settings store keeps known keys with the right types', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'ayarlar.json');
    const store = new SettingsStore(file);
    assert.equal(store.get('autoRestart'), true);
    store.set({ autoStartBot: true, projectDir: 'D:\\bot', bogus: 1, autoRestart: 'yes' });
    const again = new SettingsStore(file);
    assert.deepEqual(
      {
        autoStartBot: again.get('autoStartBot'),
        projectDir: again.get('projectDir'),
        autoRestart: again.get('autoRestart'),
      },
      { autoStartBot: true, projectDir: 'D:\\bot', autoRestart: true },
    );
    assert.equal('bogus' in again.all(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('netstat / tasklist parsing and the Ctrl+C helper', () => {
  const netstat = [
    '  TCP    127.0.0.1:2333         0.0.0.0:0              LISTENING       31212',
    '  TCP    127.0.0.1:2333         127.0.0.1:53259        ESTABLISHED     31212',
    '  TCP    0.0.0.0:2444           0.0.0.0:0              DİNLEME         777',
    '  TCP    [::]:2444              [::]:0                 LISTENING       777',
    '  TCP    127.0.0.1:23330        0.0.0.0:0              LISTENING       1',
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(netstat, 2333), [31212]);
  assert.deepEqual(parseNetstatListeners(netstat, 2444), [777]);
  assert.deepEqual(parseTasklistCsv('"java.exe","31212","Console","1","364.124 K"\r\n'), {
    name: 'java.exe',
    pid: 31212,
  });
  assert.equal(parseTasklistCsv('INFO: No tasks are running which match the specified criteria.'), null);
  assert.match(ctrlCScript(1234), /\$target = 1234/);
  assert.throws(() => ctrlCScript('1; Remove-Item C:\\'), /Geçersiz PID/);
});
