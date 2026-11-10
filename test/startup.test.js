import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/config.js';

// Runs the real entry point with an empty environment. When a developer has a .env file,
// its values are overridden with empty strings (environment variables win over .env).
function runBot(env) {
  return spawnSync(process.execPath, [join(PROJECT_ROOT, 'src', 'index.js')], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
}

describe('bot startup without configuration', () => {
  it('exits cleanly with a Turkish message when DISCORD_TOKEN is missing', () => {
    const result = runBot({ DISCORD_TOKEN: ' ', DISCORD_CLIENT_ID: ' ', LAVALINK_PASSWORD: ' ' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HATA: DISCORD_TOKEN boş/);
    assert.doesNotMatch(result.stderr, /\bat .+\.js:\d+/, 'no stack trace expected');
  });

  it('explains an invalid number setting', () => {
    const result = runBot({
      DISCORD_TOKEN: 'x',
      DISCORD_CLIENT_ID: '123456789012345678',
      LAVALINK_PASSWORD: 'p',
      DEFAULT_VOLUME: 'çok',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEFAULT_VOLUME değeri 1 ile 150 arasında/);
  });
});
