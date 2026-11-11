// The send guard (src/ozellikler/_gonderim.js) on every feature that posts by itself: after an access error
// (403/404, 50001, 50013) the welcome/goodbye messages and the level-up announcement stop trying for a while
// with one warning, and resume when sending works again.

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { RESTJSONErrorCodes } from 'discord.js';
import { createSendGuard, EN_UZUN_BEKLEME_MS, ILK_BEKLEME_MS, isAccessError } from '../src/ozellikler/_gonderim.js';
import { sendGreeting } from '../src/ozellikler/karsilama/index.js';
import { handleMessage, storeOf as xpStoreOf } from '../src/ozellikler/seviye/index.js';
import { makeLiveContext } from './yardimci/discordSahte.js';
import { fakeClock, removeTempDirs } from './yardimci/ozellikBaglami.js';

after(removeTempDirs);

const denied = () => Object.assign(new Error('Missing Permissions'), { code: RESTJSONErrorCodes.MissingPermissions });

/** A channel whose send fails while `blocked`, counting every try. */
function blockable(channel) {
  const send = channel.send;
  channel.tries = 0;
  channel.blocked = true;
  channel.send = async (payload) => {
    channel.tries += 1;
    if (channel.blocked) throw denied();
    return send(payload);
  };
  return channel;
}

async function liveContext() {
  const warnings = [];
  const context = await makeLiveContext();
  context.logger = {
    debug() {},
    info() {},
    warn: (text) => warnings.push(text),
    error() {},
    child: () => context.logger,
  };
  return { context, warnings, guild: context.guild, clock: context.clock };
}

describe('send guard', () => {
  it('pauses 5 minutes after an access error, doubling up to 6 hours; other errors do not pause', async () => {
    const clock = fakeClock();
    const warnings = [];
    const guard = createSendGuard({ clock, logger: { warn: (t) => warnings.push(t) } });
    const fail = async () => {
      throw denied();
    };
    assert.equal(await guard.gonder('k', fail, () => 'uyarı'), 'durduruldu');
    assert.equal(guard.durum('k').kadar, clock.now() + ILK_BEKLEME_MS);
    assert.equal(await guard.gonder('k', fail, () => 'uyarı'), 'durduruldu');
    assert.equal(warnings.length, 1, 'one warning per pause');
    for (let i = 0; i < 12; i += 1) {
      await clock.advance(EN_UZUN_BEKLEME_MS);
      await guard.gonder('k', fail, () => 'uyarı');
    }
    assert.equal(guard.durum('k').kadar - clock.now(), EN_UZUN_BEKLEME_MS);
    await clock.advance(EN_UZUN_BEKLEME_MS);
    assert.equal(
      await guard.gonder(
        'k',
        async () => {},
        () => 'uyarı',
      ),
      'gonderildi',
    );
    assert.equal(guard.durum('k'), null);
    assert.equal(
      await guard.gonder(
        'x',
        async () => Promise.reject(new Error('500')),
        () => 'uyarı',
      ),
      'hata',
    );
    assert.equal(guard.durum('x'), null);
    assert.ok(isAccessError({ status: 404 }) && isAccessError({ code: 50001 }) && !isAccessError({ status: 500 }));
  });
});

describe('welcome and goodbye messages', () => {
  it('a channel without permission is tried once, then paused with one warning, and resumes', async () => {
    const { context, warnings, guild, clock } = await liveContext();
    const channel = blockable(guild.addText('hosgeldin'));
    context.ozellikler.ayarlar.set(guild.id, 'karsilama', 'hosgeldin-kanal', channel.id);
    context.ozellikler.ayarlar.set(guild.id, 'karsilama', 'hosgeldin-kart', false);
    const person = { id: '300000000000000001', ad: 'Ali', kullaniciAdi: 'ali' };
    for (let i = 0; i < 5; i += 1) assert.equal(await sendGreeting(context, guild, person, 'hosgeldin'), false);
    assert.equal(channel.tries, 1);
    assert.equal(warnings.filter((w) => /Karşılama mesajı gönderilemedi/.test(w)).length, 1);
    await clock.advance(ILK_BEKLEME_MS);
    channel.blocked = false;
    assert.equal(await sendGreeting(context, guild, person, 'hosgeldin'), true);
    assert.equal(channel.tries, 2);
  });
});

describe('level-up announcement', () => {
  it('is paused after an access error instead of failing on every level up', async () => {
    const { context, warnings, guild, clock } = await liveContext();
    const channel = blockable(guild.addText('duyuru'));
    context.ozellikler.ayarlar.set(guild.id, 'seviye', 'duyuru-kanal', channel.id);
    const member = guild.addMember({ name: 'Ali' });
    const store = xpStoreOf(context);
    const levelUp = async () => {
      // Just below the next level: the next rewarded message levels up.
      const before = store.kayit(guild.id, member.id)?.level ?? 0;
      const need = 5 * before * before + 50 * before + 100;
      store.xpDegistir(
        guild.id,
        member.id,
        need - 1 - (store.kayit(guild.id, member.id)?.xp ?? 0) + totalBefore(before),
      );
      await clock.advance(61_000);
      await handleMessage(context, {
        guild,
        guildId: guild.id,
        channelId: channel.id,
        channel,
        author: member.user,
        member,
        content: 'x',
      });
    };
    const totalBefore = (level) => {
      let total = 0;
      for (let l = 0; l < level; l += 1) total += 5 * l * l + 50 * l + 100;
      return total;
    };
    await levelUp();
    await levelUp();
    assert.ok((store.kayit(guild.id, member.id)?.level ?? 0) >= 2, 'two level ups happened');
    assert.equal(channel.tries, 1, 'the second announcement was not tried');
    assert.equal(warnings.filter((w) => /Seviye duyurusu gönderilemedi/.test(w)).length, 1);
  });
});
