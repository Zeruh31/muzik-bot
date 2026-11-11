// Sesli komut: ayar şeması (varsayılan kapalı, seçimli model ayarı), hariç tutma dosyası ve bileşenin kurulu
// olup olmadığı (kurulum.json biçimi masaüstü uygulamasıyla ortak).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkSchema } from '../src/ozellikler/ayarlar/sema.js';
import { VOICE_MODELS } from '../src/config.js';
import { spawnSync } from 'node:child_process';
import { createExclusionStore } from '../src/ozellikler/sesli-komut/depo.js';
import modul from '../src/ozellikler/sesli-komut/index.js';
import { componentDir, componentStatus, MANIFEST_NAME, pythonPath } from '../src/ozellikler/sesli-komut/kurulum.js';

const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sesli-komut-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const G = '111111111111111111';
const U = '222222222222222222';

describe('sesli komut: ayarlar', () => {
  it('varsayılan kapalı ve nötr uyandırma sözü; bildirim ve model sunucu ayarı değil', () => {
    const { ayarlar } = modul;
    assert.deepEqual(Object.keys(ayarlar), ['acik', 'uyandirma']);
    assert.equal(ayarlar.acik.varsayilan, false);
    assert.equal(ayarlar.uyandirma.varsayilan, 'müzik bot');
    assert.doesNotThrow(() => checkSchema(modul.ad, ayarlar, modul.mesajlar));
  });

  it('model bot düzeyinde: SESLI_KOMUT_MODEL (.env), yalnız otomatik, turbo ya da small', () => {
    // In a child process, as test/brand.test.js does (a space means empty; the real .env cannot win).
    const modelFrom = (value) => {
      const script = `
        const { loadConfig } = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
        try { console.log(loadConfig({ requireToken: false }).voice.model); }
        catch (error) { console.log('HATA ' + error.message); }`;
      return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SESLI_KOMUT_MODEL: value },
      }).stdout.trim();
    };
    assert.equal(modelFrom(' '), 'otomatik');
    assert.equal(modelFrom('small'), 'small');
    assert.match(modelFrom('large'), /^HATA SESLI_KOMUT_MODEL/);
    assert.deepEqual(VOICE_MODELS, ['otomatik', 'turbo', 'small']);
  });
});

describe('sesli komut: hariç tutma dosyası', () => {
  it('kişi başına, sunucu başına; dosyaya yalnız kimlikler yazılır ve yeniden okunur', () => {
    const file = join(temp(), 'sesli-komut.json');
    const store = createExclusionStore({ file });
    assert.equal(store.has(G, U), false);
    assert.equal(store.set(G, U, true), true);
    assert.equal(store.set(G, U, true), false, 'no change');
    assert.equal(store.has(G, U), true);
    assert.equal(store.has('333333333333333333', U), false, 'per server');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, haric: { [G]: [U] } });
    assert.equal(createExclusionStore({ file }).has(G, U), true);
    store.set(G, U, false);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).haric, {});
    assert.throws(() => store.set(G, 'x', true), /Geçersiz/);
  });

  it('bozuk kayıtlar atılır; daha yeni sürümün dosyasına yazılmaz', () => {
    const file = join(temp(), 'sesli-komut.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, haric: { [G]: [U, 'bozuk', 5], kotu: [U] } }));
    const store = createExclusionStore({ file });
    assert.equal(store.has(G, U), true);
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, haric: {} }));
    assert.throws(() => createExclusionStore({ file }).set(G, U, true), /daha yeni/);
  });
});

describe('sesli komut: bileşen kurulumu', () => {
  it("yeri: ortam değişkeni, Windows'ta %LOCALAPPDATA%; proje klasörünün dışı", () => {
    assert.equal(componentDir({ env: { SESLI_KOMUT_DIZINI: 'D:\\x' } }), 'D:\\x');
    assert.equal(
      componentDir({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32' }),
      join('C:\\L', 'MuzikBot', 'sesli-komut'),
    );
    assert.equal(pythonPath('R', 'win32'), join('R', 'venv', 'Scripts', 'python.exe'));
    assert.equal(pythonPath('R', 'linux'), join('R', 'venv', 'bin', 'python'));
  });

  it('kurulu sayılması için kurulum.json "hazir", venv Python\'u ve en az bir model gerekir', () => {
    const dir = temp();
    assert.equal(componentStatus({ dir }).kurulu, false);
    mkdirSync(join(dir, 'venv', 'Scripts'), { recursive: true });
    writeFileSync(pythonPath(dir, 'win32'), '');
    mkdirSync(join(dir, 'models', 'small'), { recursive: true });
    writeFileSync(join(dir, 'models', 'small', 'model.bin'), '');
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({ surum: 1, durum: 'kuruluyor', profil: 'cpu' }));
    assert.equal(componentStatus({ dir, platform: 'win32' }).kurulu, false, 'an interrupted install');
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({ surum: 1, durum: 'hazir', profil: 'cpu' }));
    assert.deepEqual(componentStatus({ dir, platform: 'win32' }), {
      kurulu: true,
      dizin: dir,
      profil: 'cpu',
      modeller: ['small'],
    });
  });
});
