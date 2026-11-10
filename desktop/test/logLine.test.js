'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBotLine, parseLavalinkLine, redact } = require('../src/main/logLine');
const { detectYoutubeAuth } = require('../src/main/youtubeAuth');

test('bot logger lines', () => {
  assert.deepEqual(parseBotLine("[10.11.2026 09:31:59] INFO  [bot] Discord'a giriş yapıldı: Müzik#1234 (3 sunucu)"), {
    level: 'info',
    time: '10.11.2026 09:31:59',
    scope: 'bot',
    message: "Discord'a giriş yapıldı: Müzik#1234 (3 sunucu)",
    structured: true,
  });
  assert.equal(parseBotLine('[10.11.2026 09:31:59] WARN  [bot:panel] Web paneli açılmadı: x').level, 'warn');
  assert.equal(parseBotLine('[10.11.2026 09:31:59] ERROR [bot] Lavalink şifreyi reddetti.').scope, 'bot');
  assert.equal(parseBotLine('[10.11.2026 09:31:59] DEBUG [bot:kurtarma] x').level, 'debug');
});

test('bot fatal "HATA:" lines are errors; other lines have no level', () => {
  const fatal = parseBotLine('HATA: Discord token\'ı geçersiz. Developer Portal > Bot > "Reset Token"');
  assert.equal(fatal.level, 'error');
  assert.match(fatal.message, /^HATA: Discord token'ı geçersiz/);
  assert.equal(parseBotLine('    at Client.login (file:///x.js:1:1)').level, null);
  assert.equal(parseBotLine('\x1b[31mcolored\x1b[0m').message, 'colored');
});

test('Lavalink Spring Boot lines', () => {
  const line =
    '2026-11-10T09:05:32.803+03:00  INFO 27764 --- [Lavalink] [main] lavalink.server.Launcher                 : Lavalink is ready to accept connections.';
  assert.deepEqual(parseLavalinkLine(line), {
    level: 'info',
    time: '2026-11-10T09:05:32.803+03:00',
    scope: 'lavalink.server.Launcher',
    message: 'Lavalink is ready to accept connections.',
    structured: true,
  });
  const warn =
    '2026-11-10T09:37:21.782+03:00  WARN 31212 --- [Lavalink] [lava-daemon-pool-playback-1-thread-1] c.s.d.l.t.p.LocalAudioTrackExecutor      : Suspicious exception';
  assert.equal(parseLavalinkLine(warn).level, 'warn');
  assert.equal(parseLavalinkLine(warn).message, 'Suspicious exception');
  const error =
    '2026-11-10T09:05:28.684Z ERROR 1 --- [Lavalink] [           main] o.s.boot.SpringApplication : Application run failed';
  assert.equal(parseLavalinkLine(error).level, 'error');
  assert.equal(parseLavalinkLine('\tat java.base/java.lang.Thread.run(Thread.java:1583)').level, 'error');
  assert.equal(parseLavalinkLine('	Version:        4.2.2').level, null);
});

test('YouTube device code and success lines', () => {
  const line =
    '2026-11-10T09:05:33.000+03:00  INFO 1 --- [Lavalink] [main] d.l.y.http.YoutubeOauth2Handler : ==================================================\n';
  assert.equal(detectYoutubeAuth(line), null);
  assert.deepEqual(
    detectYoutubeAuth(
      'OAUTH INTEGRATION: To give youtube-source access to your account, go to https://www.google.com/device and enter code ABC-DEF-GHI',
    ),
    { type: 'code', code: 'ABC-DEF-GHI', url: 'https://www.google.com/device' },
  );
  assert.deepEqual(detectYoutubeAuth('go to https://www.google.com/device and enter code XKCD-1234'), {
    type: 'code',
    code: 'XKCD-1234',
    url: 'https://www.google.com/device',
  });
  assert.deepEqual(
    detectYoutubeAuth('... YoutubeOauth2Handler : Token retrieved successfully. Store your refresh token'),
    {
      type: 'success',
    },
  );
  assert.equal(detectYoutubeAuth('enter code nowhere'), null);
});

test('redact hides refresh tokens, Google/Discord token shapes and known secrets', () => {
  assert.equal(
    redact('Store your refresh token as this can be reused. (1//0abcdefghijklmnopqrstuvwxyz-ABC)'),
    'Store your refresh token as this can be reused. (***)',
  );
  assert.equal(redact('token 1//0gAbCdEfGhIjKlMnOpQrStUv here'), 'token 1//*** here');
  assert.equal(redact('access ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxx'), 'access ya29.***');
  assert.equal(
    // Fake token, joined at runtime so secret scanners do not flag the test file.
    redact(`login ${['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.')} ok`),
    'login *** ok',
  );
  assert.equal(
    redact('pass=supersecretpw and again supersecretpw', ['supersecretpw', '', 'ab']),
    'pass=*** and again ***',
  );
  assert.equal(redact('regex chars a.b*c+ stay', ['a.b*c+']), 'regex chars *** stay');
});
