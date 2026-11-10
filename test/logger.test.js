import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const loggerUrl = new URL('../src/logger.js', import.meta.url).href;
const configUrl = new URL('../src/config.js', import.meta.url).href;

function run(script, env = {}) {
  const { LOG_LEVEL: _drop, ...base } = process.env;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...base, ...env },
  });
}

describe('logger LOG_LEVEL', () => {
  it('honours LOG_LEVEL that is set after the logger module was imported (as .env loading does)', () => {
    const result = run(`
      import { createLogger } from ${JSON.stringify(loggerUrl)};
      process.env.LOG_LEVEL = 'warn';   // e.g. loaded from .env after import
      const log = createLogger('t');
      log.info('BILGI-SATIRI');
      log.warn('UYARI-SATIRI');
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /BILGI-SATIRI/);
    assert.match(result.stderr, /UYARI-SATIRI/);
  });

  it('re-reads the level after .env is loaded even if something logged earlier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muzikbot-log-'));
    try {
      const envFile = join(dir, '.env');
      writeFileSync(envFile, 'LOG_LEVEL=error\n');
      const result = run(`
        import { createLogger, resetLogLevel } from ${JSON.stringify(loggerUrl)};
        const log = createLogger('t');
        log.info('ONCE-BILGI');            // default level (info) is cached here
        process.loadEnvFile(${JSON.stringify(envFile)});
        resetLogLevel();                   // what config.loadEnvFile() does
        log.warn('SONRA-UYARI');
        log.error('SONRA-HATA');
      `);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ONCE-BILGI/);
      assert.doesNotMatch(result.stderr, /SONRA-UYARI/);
      assert.match(result.stderr, /SONRA-HATA/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config.loadEnvFile resets the cached level', () => {
    const result = run(`
      import { createLogger } from ${JSON.stringify(loggerUrl)};
      const log = createLogger('t');
      log.info('ILK');
      process.env.LOG_LEVEL = 'error';
      const { loadEnvFile } = await import(${JSON.stringify(configUrl)});
      loadEnvFile();
      log.warn('GIZLENMELI');
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /GIZLENMELI/);
  });
});
