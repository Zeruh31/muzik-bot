// Free games announcements: parsing real Epic and GamerPower replies (test/fixtures/ucretsiz-oyunlar, saved
// from the live endpoints on 2026-11-10), announcing a game once per server (also across restarts and
// sources), catching up on start, and staying quiet on network errors.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/config.js';
import {
  EPIC_URL,
  epicAyristir,
  gamerPowerAyristir,
  gamerPowerUrl,
  getJson,
  kaliciOyunMu,
  oyunAnahtari,
  USER_AGENT,
} from '../src/ozellikler/ucretsiz-oyunlar/kaynaklar.js';
import { ARALIK_MS, JOB_ID, kontrolEt, oyunKarti, sendErrorKind } from '../src/ozellikler/ucretsiz-oyunlar/index.js';
import { fakeChannel, fakeClock, idsOf, makeContext, removeTempDirs, textOf } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const fixture = (name) =>
  JSON.parse(readFileSync(join(PROJECT_ROOT, 'test', 'fixtures', 'ucretsiz-oyunlar', name), 'utf8'));
const EPIC = fixture('epic-freeGamesPromotions.json');
const GP_EPIC = fixture('gamerpower-epic.json');
const GP_STEAM = fixture('gamerpower-steam.json');
const GP_GOG_EMPTY = fixture('gamerpower-gog-bos.json');
/** When the fixtures were saved: Flotsam is free on Epic until 2026-11-12. */
const NOW = Date.parse('2026-11-10T20:00:00Z');

/** A GamerPower store giveaway in the real reply format (the live Steam list had only a key giveaway). */
const STEAM_STORE_GIVEAWAY = [
  {
    ...GP_EPIC[0],
    id: 9001,
    title: 'Örnek Oyun (Steam) Giveaway',
    platforms: 'PC, Steam',
    open_giveaway_url: 'https://www.gamerpower.com/open/ornek-oyun-steam-giveaway',
    end_date: '2026-11-14 17:00:00',
  },
];

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const ROLE = '333333333333333333';

/** fetch() answering from the fixtures; `replies` maps URL -> JSON (or an Error to throw, or a status). */
function fakeFetch(replies) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const reply = replies[url];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return { ok: false, status: reply, json: async () => ({}) };
    if (reply === undefined) throw new Error(`unexpected ${url}`);
    return { ok: true, status: Array.isArray(reply) ? 200 : 201, json: async () => structuredClone(reply) };
  };
  return { fetch, calls };
}

const LIVE = {
  [EPIC_URL]: EPIC,
  [gamerPowerUrl('epic-games-store')]: GP_EPIC,
  [gamerPowerUrl('steam')]: GP_STEAM,
  [gamerPowerUrl('gog')]: GP_GOG_EMPTY,
};
const quick = { sleep: async () => {}, staggerMs: 0 };

async function configured({ dir, clock = fakeClock(NOW), channel = fakeChannel(CHANNEL), rol = null } = {}) {
  const context = await makeContext({ dir, clock, channels: new Map([[CHANNEL, channel]]), guildIds: [GUILD] });
  if (!dir) {
    context.ozellikler.ayarlar.set(GUILD, 'ucretsiz-oyunlar', 'kanal', CHANNEL);
    if (rol) context.ozellikler.ayarlar.set(GUILD, 'ucretsiz-oyunlar', 'rol', rol);
  }
  return { context, channel, clock };
}

describe('free games: sources', () => {
  it('Epic: only games given away right now (not free-to-play, DLC or upcoming ones)', () => {
    const offers = epicAyristir(EPIC, NOW);
    assert.deepEqual(
      offers.map((o) => [o.anahtar, o.url, o.deger]),
      [['epic:flotsam', 'https://store.epicgames.com/p/flotsam-266287', '$24.99']],
    );
    assert.equal(offers[0].bitis, Date.parse('2026-11-12T16:00:00.000Z'));
    assert.match(offers[0].gorsel, /^https:\/\//);
    // A week later the promotion is over; the upcoming one has not started in this reply.
    assert.deepEqual(epicAyristir(EPIC, Date.parse('2026-11-13T00:00:00Z')), []);
    assert.throws(() => epicAyristir({ errors: [] }), /biçimi/);
  });

  it('GamerPower: the same game as Epic gives the same key; key giveaways and an empty list give nothing', () => {
    const epic = gamerPowerAyristir(GP_EPIC, 'epic', NOW);
    assert.deepEqual(
      epic.map((o) => [o.anahtar, o.baslik]),
      [['epic:flotsam', 'Flotsam']],
    );
    assert.equal(epic[0].anahtar, epicAyristir(EPIC, NOW)[0].anahtar);
    assert.deepEqual(gamerPowerAyristir(GP_STEAM, 'steam', NOW), [], '"Key Giveaway" needs another site');
    assert.deepEqual(gamerPowerAyristir(GP_GOG_EMPTY, 'gog', NOW), [], '201 { status: 0 }');
    const steam = gamerPowerAyristir(STEAM_STORE_GIVEAWAY, 'steam', NOW);
    assert.equal(steam[0].anahtar, 'steam:ornek-oyun');
    assert.equal(steam[0].bitis, Date.parse('2026-11-14T17:00:00Z'));
    assert.equal(oyunAnahtari('epic', "Them's Fightin' Herds (Epic Games) Giveaway"), 'epic:them-s-fightin-herds');
  });

  it('GamerPower: only whole games you keep (no free weekend, free-to-play, DLC, demo, beta or loot)', () => {
    // Built in GamerPower's reply format (the live lists of that day had none of these cases).
    const mixed = fixture('gamerpower-karisik.json');
    assert.deepEqual(
      gamerPowerAyristir(mixed, 'steam', NOW).map((o) => o.anahtar),
      ['steam:kalıcı-oyun'],
    );
    assert.deepEqual(mixed.map(kaliciOyunMu), [true, false, false, false, false, false, false]);
  });

  it('a title with "pack" is dropped only for DLC-style packs, not for real games', () => {
    const game = (title) => ({ type: 'Game', status: 'Active', title, description: '', instructions: '' });
    for (const title of ['Pack It Up (Steam) Giveaway', 'Cube Pack Tycoon', 'Backpack Hero']) {
      assert.equal(kaliciOyunMu(game(title)), true, title);
    }
    for (const title of ['Some Game DLC Pack', 'Skin Pack', 'Starter Pack (Steam)', 'Bonus Pack']) {
      assert.equal(kaliciOyunMu(game(title)), false, title);
    }
  });

  it('only https links and images are used', () => {
    const bad = [{ ...STEAM_STORE_GIVEAWAY[0], open_giveaway_url: 'javascript:alert(1)' }];
    assert.deepEqual(gamerPowerAyristir(bad, 'steam', NOW), []);
    const tooLong = [{ ...STEAM_STORE_GIVEAWAY[0], open_giveaway_url: `https://example.com/${'a'.repeat(512)}` }];
    assert.deepEqual(gamerPowerAyristir(tooLong, 'steam', NOW), [], 'links over 512 characters');
    const noImage = [{ ...STEAM_STORE_GIVEAWAY[0], image: 'http://example.com/a.jpg', thumbnail: null }];
    assert.equal(gamerPowerAyristir(noImage, 'steam', NOW)[0].gorsel, null);
  });

  it('requests carry a generic User-Agent; a 503 is tried once more, a 404 is not', async () => {
    let status = 503;
    const calls = [];
    const fetch = async (url, options) => {
      calls.push(options.headers['User-Agent']);
      const current = status;
      status = 200;
      return { ok: current === 200, status: current, json: async () => [] };
    };
    assert.deepEqual(await getJson('https://example.com/x', { fetch, sleep: async () => {} }), []);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], USER_AGENT);
    assert.ok(!USER_AGENT.toLowerCase().includes(userInfo().username.toLowerCase()));
    const missing = fakeFetch({ 'https://example.com/y': 404 });
    await assert.rejects(getJson('https://example.com/y', { fetch: missing.fetch, sleep: async () => {} }), /404/);
    assert.equal(missing.calls.length, 1);
  });
});

describe('free games: announcing', () => {
  it('announces a new game once with a card (image, last day, store link, role ping)', async () => {
    const { context, channel } = await configured({ rol: ROLE });
    const { fetch } = fakeFetch(LIVE);
    const result = await kontrolEt(context, { fetch, ...quick });
    assert.equal(result.gonderilen, 1);
    const card = channel.sent[0];
    const json = card.components[0].toJSON();
    assert.ok(textOf(card).includes('Flotsam'));
    assert.ok(textOf(card).includes(`<t:${Date.parse('2026-11-12T16:00:00.000Z') / 1000}:R>`));
    assert.ok(textOf(card).includes(`<@&${ROLE}>`));
    assert.deepEqual(card.allowedMentions, { parse: [], roles: [ROLE] });
    assert.ok(
      json.components.some((c) => c.type === 12 && /^https:/.test(c.items[0].media.url)),
      'image',
    );
    const link = json.components.find((c) => c.type === 1).components[0];
    assert.equal(link.url, 'https://store.epicgames.com/p/flotsam-266287');
    assert.deepEqual(idsOf(card), [], 'only a link button, nothing to route');

    // The next check, and a check after a restart, do not announce it again.
    await kontrolEt(context, { fetch, ...quick });
    const restarted = await configured({ dir: context.dir, channel });
    await kontrolEt(restarted.context, { fetch, ...quick });
    assert.equal(channel.sent.length, 1);
  });

  it('Epic down: GamerPower is used for Epic and the same game is still not announced twice', async () => {
    const { context, channel } = await configured();
    await kontrolEt(context, { fetch: fakeFetch(LIVE).fetch, ...quick });
    const epicDown = fakeFetch({ ...LIVE, [EPIC_URL]: new Error('ECONNRESET') });
    const result = await kontrolEt(context, { ...quick, fetch: epicDown.fetch });
    assert.deepEqual(result.hatali, []);
    assert.ok(epicDown.calls.some((c) => c.url === gamerPowerUrl('epic-games-store')));
    assert.equal(channel.sent.length, 1);
  });

  it('a network error is quiet: nothing is sent, nothing is marked, the check is planned again', async () => {
    const { context, channel, clock } = await configured();
    const down = Object.fromEntries(Object.keys(LIVE).map((url) => [url, new Error('getaddrinfo ENOTFOUND')]));
    const result = await kontrolEt(context, { fetch: fakeFetch(down).fetch, ...quick });
    assert.equal(result.gonderilen, 0);
    assert.deepEqual(result.hatali.sort(), ['Epic Games Store', 'GOG', 'Steam']);
    assert.equal(channel.sent.length, 0);
    // Through the scheduler: the job never fails and always plans the next check.
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch(down).fetch;
    try {
      await context.ozellikler.baslat();
    } finally {
      globalThis.fetch = original;
    }
    const job = context.ozellikler.zamanlayici.bekleyenler().find((j) => j.id === JOB_ID);
    assert.equal(job.durum, 'bekliyor');
    assert.equal(job.deneme, 0);
    assert.equal(job.zaman, clock.now() + ARALIK_MS);
    // Once the network is back, the game is announced.
    await kontrolEt(context, { fetch: fakeFetch(LIVE).fetch, ...quick });
    assert.equal(channel.sent.length, 1);
  });

  it('games that came out while the bot was off are announced on start, if still valid', async () => {
    const { context, channel } = await configured();
    context.ozellikler.kapat();
    const restarted = await configured({ dir: context.dir, channel, clock: fakeClock(NOW + 3600_000) });
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch(LIVE).fetch;
    try {
      await restarted.context.ozellikler.baslat();
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(channel.sent.length, 1);
    // Two days later the promotion has ended: a fresh server is not told about it any more.
    const late = await configured({ clock: fakeClock(Date.parse('2026-11-13T00:00:00Z')) });
    await kontrolEt(late.context, { fetch: fakeFetch(LIVE).fetch, ...quick });
    assert.equal(late.channel.sent.length, 0);
  });

  it('switched-off platforms are not asked for; without a channel nothing is fetched at all', async () => {
    const { context } = await configured();
    for (const p of ['epic', 'gog']) context.ozellikler.ayarlar.set(GUILD, 'ucretsiz-oyunlar', p, false);
    const steamOnly = fakeFetch(LIVE);
    await kontrolEt(context, { fetch: steamOnly.fetch, ...quick });
    assert.deepEqual(
      steamOnly.calls.map((c) => c.url),
      [gamerPowerUrl('steam')],
    );
    const nobody = await makeContext({ guildIds: [GUILD] });
    const none = fakeFetch(LIVE);
    await kontrolEt(nobody, { fetch: none.fetch, ...quick });
    assert.equal(none.calls.length, 0);
  });

  it('a card Discord refuses for good is skipped from then on; a temporary error is tried again', async () => {
    const channel = fakeChannel(CHANNEL);
    const { context } = await configured({ channel });
    const replies = { ...LIVE, [gamerPowerUrl('steam')]: STEAM_STORE_GIVEAWAY };
    let refuse = (payload) =>
      textOf(payload).includes('Ücretsiz: Flotsam')
        ? Object.assign(new Error('Invalid Form Body'), { code: 50035, status: 400 })
        : null;
    const send = channel.send;
    channel.send = async (payload) => {
      const error = refuse(payload);
      if (error) throw error;
      return send(payload);
    };
    const first = await kontrolEt(context, { fetch: fakeFetch(replies).fetch, ...quick });
    assert.equal(first.gonderilen, 1, 'the next offer still goes out');
    assert.ok(textOf(channel.sent[0]).includes('Örnek Oyun'));
    refuse = () => null;
    await kontrolEt(context, { fetch: fakeFetch(replies).fetch, ...quick });
    assert.equal(channel.sent.length, 1, 'the refused card is not tried again');
    const saved = JSON.parse(readFileSync(join(context.dir, 'ucretsiz-oyunlar.json'), 'utf8'));
    assert.ok(saved.duyurulamayanlar[GUILD]['epic:flotsam']);

    // A 503 is temporary: nothing is marked and the next check sends it.
    const other = await configured();
    const otherSend = other.channel.send;
    let down = true;
    other.channel.send = async (payload) => {
      if (down) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
      return otherSend(payload);
    };
    await kontrolEt(other.context, { fetch: fakeFetch(LIVE).fetch, ...quick });
    assert.equal(other.channel.sent.length, 0);
    down = false;
    await kontrolEt(other.context, { fetch: fakeFetch(LIVE).fetch, ...quick });
    assert.equal(other.channel.sent.length, 1);
    assert.equal(sendErrorKind({ code: 50013, status: 403 }), 'kanal');
  });

  it('a card without an end date or image still has its text and link', () => {
    const card = oyunKarti({
      platform: 'gog',
      baslik: 'Oyun *kalın*',
      aciklama: null,
      gorsel: null,
      bitis: null,
      url: 'https://www.gog.com/',
      deger: null,
      kaynak: 'GamerPower',
    });
    assert.match(textOf(card), /Bitiş tarihi belirtilmemiş/);
    assert.match(textOf(card), /Oyun \\\*kalın\\\*/, 'markdown is escaped');
    assert.deepEqual(card.allowedMentions, { parse: [], roles: [] });
  });
});
