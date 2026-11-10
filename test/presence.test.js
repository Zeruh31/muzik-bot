// Presence "Dinliyor: /help", re-applied every 100 seconds because Discord sometimes drops it.

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { ActivityType } from 'discord.js';
import { durum } from '../src/gorunum.js';
import { activityType, startPresence } from '../src/bot/presence.js';

describe('presence', () => {
  it('maps Turkish activity names', () => {
    assert.equal(activityType('Dinliyor'), ActivityType.Listening);
    assert.equal(activityType('oynuyor'), ActivityType.Playing);
    assert.equal(activityType('İzliyor'), ActivityType.Watching);
    assert.equal(activityType('Yarışıyor'), ActivityType.Competing);
    assert.equal(activityType('bilinmeyen'), ActivityType.Listening);
  });

  it('defaults to "Dinliyor: /help" every 100 seconds', () => {
    assert.deepEqual({ ...durum }, { tur: 'Dinliyor', metin: '/help', yenilemeSaniye: 100 });
  });

  it('sets the presence at once and again on every interval until stopped', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const calls = [];
      const client = { user: { setPresence: (data) => calls.push(data) } };
      const presence = startPresence(client, { tur: 'Dinliyor', metin: '/help', yenilemeSaniye: 100 });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], { status: 'online', activities: [{ name: '/help', type: ActivityType.Listening }] });

      mock.timers.tick(99_999);
      assert.equal(calls.length, 1);
      mock.timers.tick(1);
      assert.equal(calls.length, 2);
      mock.timers.tick(200_000);
      assert.equal(calls.length, 4);

      presence.stop();
      mock.timers.tick(500_000);
      assert.equal(calls.length, 4);
    } finally {
      mock.timers.reset();
    }
  });

  it('an error from Discord does not stop the timer', () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      let calls = 0;
      const client = {
        user: {
          setPresence: () => {
            calls += 1;
            throw new Error('shard yok');
          },
        },
      };
      const presence = startPresence(client, { tur: 'Oynuyor', metin: 'x', yenilemeSaniye: 100 });
      mock.timers.tick(100_000);
      assert.equal(calls, 2);
      presence.stop();
    } finally {
      mock.timers.reset();
    }
  });
});
