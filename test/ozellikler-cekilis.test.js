// Giveaways (/oyun cekilis): joining with the button, one single finish even when two runs meet, catching
// up after the bot was off, re-rolls, and that participant ids are deleted a while after the end.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { bitir, baslat, jobIdOf, storeOf, yenidenCek } from '../src/ozellikler/cekilis/index.js';
import { SAKLAMA_MS } from '../src/ozellikler/cekilis/depo.js';
import { sureCoz } from '../src/ozellikler/cekilis/sure.js';
import { fakeChannel, fakeClock, idsOf, makeContext, removeTempDirs, textOf } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const ADMIN = '333333333333333333';
const MESSAGE = '444444444444444444';
const ROLE = '555555555555555555';
const users = Array.from({ length: 6 }, (_, i) => `66666666666666660${i}`);
const HOUR = 3_600_000;

function startInteraction({ manage = true } = {}) {
  const replies = [];
  return {
    replies,
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: ADMIN },
    memberPermissions: { has: () => manage },
    async reply(payload) {
      replies.push(payload);
      return { resource: { message: { id: MESSAGE } } };
    },
  };
}

/** A button click on the giveaway message. */
function click(customId, userId, { roles = [], manage = false } = {}) {
  const calls = { updates: [], followUps: [], replies: [] };
  return {
    calls,
    customId,
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: userId },
    member: { roles },
    memberPermissions: { has: () => manage },
    deferred: false,
    replied: false,
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    async update(payload) {
      this.replied = true;
      calls.updates.push(payload);
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async followUp(payload) {
      calls.followUps.push(payload);
    },
    async reply(payload) {
      this.replied = true;
      calls.replies.push(payload);
    },
  };
}

const errorText = (i) => i.calls.replies[0]?.embeds?.[0]?.toJSON().description ?? '';

async function setup({ dir, clock = fakeClock(), sureMs = HOUR, kazananSayisi = 1, rolId = null } = {}) {
  const channel = fakeChannel(CHANNEL);
  const context = await makeContext({ dir, clock, channels: new Map([[CHANNEL, channel]]) });
  await context.ozellikler.baslat();
  const interaction = startInteraction();
  const giveaway = await baslat(interaction, context, { odul: 'Oyun kodu', sureMs, kazananSayisi, rolId });
  return { context, channel, giveaway, interaction, clock };
}

async function joinAs(context, id, userId, extra) {
  const interaction = click(`oz:cekilis:katil:${id}`, userId, extra);
  await context.ozellikler.router.handle(interaction, context);
  return interaction;
}

describe('giveaway: starting and joining', () => {
  it('posts a Components V2 message with persistent buttons, stores it and plans its end', async () => {
    const { context, giveaway, interaction } = await setup();
    const payload = interaction.replies[0];
    assert.ok(textOf(payload).includes('Oyun kodu'));
    assert.deepEqual(idsOf(payload), [
      `oz:cekilis:katil:${giveaway.id}`,
      `oz:cekilis:ayril:${giveaway.id}`,
      `oz:cekilis:bitir:${giveaway.id}`,
    ]);
    assert.equal(giveaway.mesajId, MESSAGE);
    const job = context.ozellikler.zamanlayici.bekleyenler().find((j) => j.id === jobIdOf(giveaway.id));
    assert.equal(job.zaman, giveaway.bitis);
  });

  it('only "Sunucuyu Yönet" can start one', async () => {
    const context = await makeContext();
    await assert.rejects(
      baslat(startInteraction({ manage: false }), context, { odul: 'x', sureMs: HOUR }),
      /Sunucuyu Yönet/,
    );
  });

  it('a join is counted once; leaving removes it; the required role is checked', async () => {
    const { context, giveaway } = await setup({ rolId: ROLE });
    const noRole = await joinAs(context, giveaway.id, users[0]);
    assert.match(errorText(noRole), /rolü olanlar/);
    const first = await joinAs(context, giveaway.id, users[0], { roles: [ROLE] });
    assert.match(textOf(first.calls.updates[0]), /Katılımcı: 1/);
    assert.match(first.calls.followUps[0].content, /katıldınız/);
    const again = await joinAs(context, giveaway.id, users[0], { roles: [ROLE] });
    assert.match(errorText(again), /zaten katıldınız/);
    assert.deepEqual(storeOf(context).get(giveaway.id).katilimcilar, [users[0]]);
    const leave = click(`oz:cekilis:ayril:${giveaway.id}`, users[0]);
    await context.ozellikler.router.handle(leave, context);
    assert.deepEqual(storeOf(context).get(giveaway.id).katilimcilar, []);
  });

  it('durations: 30dk, 2sa, 1g12sa, plain minutes; out of range or garbage is refused', () => {
    assert.equal(sureCoz('30dk'), 30 * 60_000);
    assert.equal(sureCoz('2sa'), 2 * HOUR);
    assert.equal(sureCoz('1g12sa'), 36 * HOUR);
    assert.equal(sureCoz('1 saat 30 dk'), 90 * 60_000);
    assert.equal(sureCoz('90'), 90 * 60_000);
    assert.equal(sureCoz('2h'), 2 * HOUR);
    for (const bad of ['', '0', '31g', 'yarın', '5x', '1g abc']) assert.equal(sureCoz(bad), null, bad);
  });
});

describe('giveaway: the end', () => {
  it('is finished exactly once: two runs at the same time give one winner list and one announcement', async () => {
    const { context, channel, giveaway } = await setup({ kazananSayisi: 2 });
    for (const user of users) await joinAs(context, giveaway.id, user);
    const [a, b] = await Promise.all([bitir(context, giveaway.id), bitir(context, giveaway.id)]);
    assert.deepEqual(a.kazananlar, b.kazananlar);
    assert.equal(a.kazananlar.length, 2);
    assert.equal(channel.sent.length, 1, 'one announcement');
    const third = await bitir(context, giveaway.id);
    assert.deepEqual(third.kazananlar, a.kazananlar, 'a later run picks nobody new');
    assert.equal(channel.sent.length, 1);
    // The winners are pinged, nobody else.
    assert.deepEqual(channel.sent[0].allowedMentions, { users: a.kazananlar });
    // The giveaway message now shows the result with the re-roll button.
    const edited = channel.edits.at(-1).p;
    assert.deepEqual(idsOf(edited), [`oz:cekilis:yeniden:${giveaway.id}`]);
    for (const winner of a.kazananlar) assert.ok(textOf(edited).includes(`<@${winner}>`));
  });

  it('the scheduler ends it at its time; joining afterwards is refused', async () => {
    const { context, channel, giveaway, clock } = await setup();
    await joinAs(context, giveaway.id, users[0]);
    await clock.advance(HOUR - 1);
    assert.equal(channel.sent.length, 0);
    await clock.advance(1);
    assert.equal(storeOf(context).get(giveaway.id).durum, 'bitti');
    assert.deepEqual(storeOf(context).get(giveaway.id).kazananlar, [users[0]]);
    assert.equal(channel.sent.length, 1);
    const late = await joinAs(context, giveaway.id, users[1]);
    assert.match(errorText(late), /bitti/);
  });

  it('when the bot was off at the end time, the giveaway ends right after the next start', async () => {
    const first = await setup();
    await joinAs(first.context, first.giveaway.id, users[2]);
    first.context.ozellikler.kapat();
    // Three hours later the bot starts again with the same data/ folder.
    const later = fakeClock(first.clock.now() + 3 * HOUR);
    const channel = fakeChannel(CHANNEL);
    const context = await makeContext({
      dir: first.context.dir,
      clock: later,
      channels: new Map([[CHANNEL, channel]]),
    });
    await context.ozellikler.baslat();
    const done = storeOf(context).get(first.giveaway.id);
    assert.equal(done.durum, 'bitti');
    assert.deepEqual(done.kazananlar, [users[2]]);
    assert.equal(channel.sent.length, 1);
    assert.match(textOf(channel.sent[0]), new RegExp(`<@${users[2]}>`));
    // A further restart does not announce it again.
    const channel2 = fakeChannel(CHANNEL);
    const again = await makeContext({
      dir: first.context.dir,
      clock: fakeClock(later.now() + 60_000),
      channels: new Map([[CHANNEL, channel2]]),
    });
    await again.ozellikler.baslat();
    assert.equal(channel2.sent.length, 0);
  });

  it('nobody joined: it ends without winners and says so', async () => {
    const { context, channel, giveaway } = await setup();
    const done = await bitir(context, giveaway.id);
    assert.deepEqual(done.kazananlar, []);
    assert.match(textOf(channel.sent[0]), /kimse katılmadı/);
  });

  it('"Şimdi bitir" and "Yeniden çek" are for "Sunucuyu Yönet" only, not even for the starter', async () => {
    const { context, channel, giveaway } = await setup();
    for (const who of [users[0], ADMIN]) {
      const refused = click(`oz:cekilis:bitir:${giveaway.id}`, who);
      await context.ozellikler.router.handle(refused, context);
      assert.match(errorText(refused), /yalnız "Sunucuyu Yönet"/);
    }
    assert.equal(storeOf(context).get(giveaway.id).durum, 'acik');
    const admin = click(`oz:cekilis:bitir:${giveaway.id}`, ADMIN, { manage: true });
    await context.ozellikler.router.handle(admin, context);
    assert.equal(storeOf(context).get(giveaway.id).durum, 'bitti');
    assert.equal(channel.sent.length, 1);
    assert.ok(!context.ozellikler.zamanlayici.bekleyenler().some((j) => j.id === jobIdOf(giveaway.id)));
  });

  it('"Şimdi bitir" while the timer is announcing: both wait for one run; a failed announcement is not lost', async () => {
    const { context, channel, giveaway, clock } = await setup();
    await joinAs(context, giveaway.id, users[0]);
    const send = channel.send;
    let open;
    channel.send = async () => {
      await new Promise((resolve) => (open = resolve));
      throw Object.assign(new Error('Service Unavailable'), { status: 503 });
    };
    await clock.advance(HOUR); // the end job starts and waits in channel.send
    const button = click(`oz:cekilis:bitir:${giveaway.id}`, ADMIN, { manage: true });
    await context.ozellikler.router.handle(button, context);
    // The job already finished the draw: the button says so instead of racing the announcement.
    assert.match(errorText(button), /bitti/);
    channel.send = send;
    open();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(channel.sent.length, 0, 'the first try failed');
    const job = context.ozellikler.zamanlayici.bekleyenler().find((j) => j.id === jobIdOf(giveaway.id));
    assert.ok(job, 'the end job is kept for another try');
    await clock.advance(job.zaman - clock.now());
    assert.equal(channel.sent.length, 1);
    assert.equal(storeOf(context).get(giveaway.id).duyuruldu, true);
  });

  it('a failed early finish keeps the end job and brings it forward, so the result still goes out', async () => {
    const { context, channel, giveaway, clock } = await setup({ sureMs: 24 * HOUR });
    channel.fail = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const button = click(`oz:cekilis:bitir:${giveaway.id}`, ADMIN, { manage: true });
    await context.ozellikler.router.handle(button, context);
    const job = context.ozellikler.zamanlayici.bekleyenler().find((j) => j.id === jobIdOf(giveaway.id));
    assert.equal(job.zaman, clock.now() + 60_000);
    channel.fail = null;
    await clock.advance(60_000);
    assert.equal(channel.sent.length, 1);
    assert.ok(!context.ozellikler.zamanlayici.bekleyenler().some((j) => j.id === jobIdOf(giveaway.id)));
  });

  it('two finishes at the same time share one run and both see its error', async () => {
    const { context, channel, giveaway } = await setup();
    channel.fail = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const results = await Promise.allSettled([bitir(context, giveaway.id), bitir(context, giveaway.id)]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['rejected', 'rejected'],
    );
    assert.equal(storeOf(context).get(giveaway.id).duyuruldu, false);
    channel.fail = null;
    await bitir(context, giveaway.id);
    assert.equal(channel.sent.length, 1);
  });

  it('a re-roll picks someone who has not won yet, until nobody is left', async () => {
    const { context, giveaway } = await setup();
    await joinAs(context, giveaway.id, users[0]);
    await joinAs(context, giveaway.id, users[1]);
    const first = await bitir(context, giveaway.id);
    const second = yenidenCek(context, giveaway.id);
    assert.equal(second.kazananlar.length, 1);
    assert.notEqual(second.kazananlar[0], first.kazananlar[0]);
    assert.throws(() => yenidenCek(context, giveaway.id), /kazanmamış katılımcı kalmadı/);
  });
});

describe('giveaway: privacy', () => {
  it(`participant ids are deleted ${SAKLAMA_MS / HOUR} hours after the end, with the whole record`, async () => {
    const { context, giveaway, clock } = await setup();
    await joinAs(context, giveaway.id, users[3]);
    await clock.advance(HOUR);
    const file = join(context.dir, 'cekilisler.json');
    assert.ok(readFileSync(file, 'utf8').includes(users[3]), 'kept for "Yeniden çek"');
    await clock.advance(SAKLAMA_MS);
    assert.equal(storeOf(context).get(giveaway.id), null);
    assert.ok(!readFileSync(file, 'utf8').includes(users[3]));
    const old = click(`oz:cekilis:yeniden:${giveaway.id}`, ADMIN, { manage: true });
    await context.ozellikler.router.handle(old, context);
    assert.match(errorText(old), /artık yok/);
  });
});
