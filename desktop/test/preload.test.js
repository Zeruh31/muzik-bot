'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { INVOKE_CHANNELS, EVENT_CHANNELS } = require('../src/main/ipcChannels');
const { isSafeExternalUrl } = require('../src/main/externalUrl');

/** Loads the preload with a fake `electron` module and returns what it exposed. */
function loadPreload() {
  const calls = [];
  const listeners = [];
  let exposed = null;
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => {
        exposed = { name, api };
      },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        calls.push({ channel, args });
        return Promise.resolve('ok');
      },
      on: (channel, listener) => listeners.push({ channel, listener }),
      removeListener: () => {},
    },
  };
  const file = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    Module._load = originalLoad;
  }
  return { exposed, calls, listeners };
}

test('preload exposes one object and only whitelisted channels', async () => {
  const { exposed, calls } = loadPreload();
  assert.equal(exposed.name, 'muzik');
  for (const [name, fn] of Object.entries(exposed.api)) {
    if (name === 'on') continue;
    await fn('x');
  }
  const used = new Set(calls.map((c) => c.channel));
  for (const channel of used) assert.ok(INVOKE_CHANNELS.includes(channel), `unexpected channel ${channel}`);
  assert.deepEqual([...used].sort(), [...INVOKE_CHANNELS].sort(), 'every main channel is reachable and nothing else');
});

test('preload and main agree on the channel lists', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'preload', 'preload.js'), 'utf8');
  const list = (name) =>
    JSON.parse(
      source
        .match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`))[1]
        .replace(/'/g, '"')
        .replace(/,\s*\]/, ']'),
    );
  assert.deepEqual(list('INVOKE_CHANNELS'), [...INVOKE_CHANNELS]);
  assert.deepEqual(list('EVENT_CHANNELS'), [...EVENT_CHANNELS]);
});

test('events: only known channels, and the raw IPC event never reaches the page', () => {
  const { exposed, listeners } = loadPreload();
  assert.throws(() => exposed.api.on('arbitrary', () => {}), /İzin verilmeyen olay/);
  let received;
  exposed.api.on('olay:durum', (...args) => {
    received = args;
  });
  listeners[0].listener({ sender: 'secret' }, { state: 'x' });
  assert.deepEqual(received, [{ state: 'x' }]);
});

test('restart target is normalised', async () => {
  const { exposed, calls } = loadPreload();
  await exposed.api.restart('bot');
  await exposed.api.restart('anything');
  assert.deepEqual(
    calls.map((c) => c.args[0]),
    ['bot', 'hepsi'],
  );
});

test('external links: only https and the local panel', () => {
  assert.ok(isSafeExternalUrl('https://discord.com/developers/applications'));
  assert.ok(isSafeExternalUrl('http://127.0.0.1:3000'));
  assert.ok(!isSafeExternalUrl('http://localhost:3000'));
  assert.ok(!isSafeExternalUrl('http://example.com'));
  assert.ok(!isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'));
  assert.ok(!isSafeExternalUrl('javascript:alert(1)'));
  assert.ok(!isSafeExternalUrl('https://user:pass@example.com'));
  assert.ok(!isSafeExternalUrl('not a url'));
});

test('saving a server setting sends only guildId, modul, alan and deger', async () => {
  const { exposed, calls } = loadPreload();
  await exposed.api.saveServerSetting({
    guildId: '111111111111111111',
    modul: 'karsilama',
    alan: 'hosgeldin-kanal',
    deger: '222222222222222222',
    yol: 'C:\Windows\System32',
    dosya: '../../.env',
  });
  await exposed.api.serverSettings(123);
  assert.deepEqual(calls, [
    {
      channel: 'sunucuAyar:kaydet',
      args: [
        { guildId: '111111111111111111', modul: 'karsilama', alan: 'hosgeldin-kanal', deger: '222222222222222222' },
      ],
    },
    { channel: 'sunucuAyar:al', args: ['123'] },
  ]);
});
