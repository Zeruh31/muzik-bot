import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { brandLine } from '../src/commands/help.js';

/** Runs loadConfig() in a child process with the given BRAND_* values (a space means empty). */
function brandFrom(env) {
  const script = `
    const { loadConfig } = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
    try { console.log(JSON.stringify(loadConfig({ requireToken: false }).brand)); }
    catch (error) { console.log('HATA ' + error.message); }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      BRAND_AUTHOR_NAME: ' ',
      BRAND_AUTHOR_URL: ' ',
      BRAND_SUPPORT_URL: ' ',
      ...env,
    },
  }).stdout.trim();
}

describe('/help links (BRAND_* in .env)', () => {
  it('are empty by default and then not shown at all', () => {
    assert.deepEqual(JSON.parse(brandFrom({})), { authorName: '', authorUrl: '', supportUrl: '' });
    assert.equal(brandLine({ authorName: '', authorUrl: '', supportUrl: '' }), '');
    assert.equal(brandLine(), '');
  });

  it('show the support server and the author when set', () => {
    const brand = JSON.parse(
      brandFrom({
        BRAND_SUPPORT_URL: 'https://discord.com/invite/abc123',
        BRAND_AUTHOR_NAME: 'Örnek Yapımcı',
        BRAND_AUTHOR_URL: 'https://example.com/yapimci',
      }),
    );
    assert.deepEqual(brand, {
      authorName: 'Örnek Yapımcı',
      authorUrl: 'https://example.com/yapimci',
      supportUrl: 'https://discord.com/invite/abc123',
    });
    assert.equal(
      brandLine(brand),
      '[Discord](https://discord.com/invite/abc123) • By [Örnek Yapımcı](https://example.com/yapimci)',
    );
  });

  it('a name without a link is shown as plain text; markdown in the name cannot form a link', () => {
    assert.equal(brandLine({ authorName: 'Ali' }), 'By Ali');
    assert.equal(brandLine({ authorName: '[x](https://evil.example)', authorUrl: '' }), 'By xhttps://evil.example');
    assert.equal(brandLine({ authorUrl: 'https://example.com' }), '', 'a link without a name is not shown');
  });

  it('only https addresses are accepted', () => {
    assert.match(brandFrom({ BRAND_AUTHOR_URL: 'http://example.com' }), /^HATA BRAND_AUTHOR_URL https:\/\//);
    assert.match(brandFrom({ BRAND_SUPPORT_URL: 'javascript:alert(1)' }), /^HATA BRAND_SUPPORT_URL/);
    assert.match(brandFrom({ BRAND_SUPPORT_URL: 'discord.com/invite/abc' }), /^HATA BRAND_SUPPORT_URL/);
  });
});
