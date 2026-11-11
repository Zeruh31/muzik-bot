// "Now playing" message with control buttons: sent with buttons, replaced (old one deleted, or its
// buttons removed when it cannot be deleted), edited when the button state changes, and the
// button handler can tell the live message from old ones.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { startAnnouncer } from '../src/bot/announcer.js';
import { TrackQueue } from '../src/music/Queue.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function setup() {
  const sent = [];
  let nextId = 1;
  const channel = {
    isTextBased: () => true,
    isSendable: () => true,
    guild: { members: { me: null } },
    async send(payload) {
      const message = {
        id: String(nextId++),
        payload,
        edits: [],
        deleted: false,
        failDelete: false,
        async delete() {
          if (this.failDelete) throw new Error('Missing Permissions');
          this.deleted = true;
        },
        async edit(change) {
          this.edits.push(change);
        },
      };
      sent.push(message);
      return message;
    },
  };
  const queue = new TrackQueue();
  const player = { textChannelId: 'c', queue, paused: false, repeatMode: 'off' };
  const music = Object.assign(new EventEmitter(), {
    getPlayer: () => player,
    getState: () => ({
      current: queue.current ? { title: queue.current.info.title } : null,
      paused: player.paused,
      repeatMode: player.repeatMode,
      hasPrevious: queue.previous.length > 0,
      queue: queue.tracks,
    }),
  });
  const context = {
    client: { channels: { cache: new Map([['c', channel]]) } },
    music,
    config: { music: { twentyFourSeven: true } },
    logger: silent,
  };
  startAnnouncer(context);
  return { context, music, player, queue, sent };
}

const view = (title, extra = {}) => ({ title, author: 'A', uri: null, duration: 1000, ...extra });
const buttonIds = (message) =>
  message.payload.components.flatMap((row) => row.toJSON().components.map((c) => c.custom_id));

describe('now playing message', () => {
  it('carries the control buttons and replaces the previous message', async () => {
    const t = setup();
    t.queue.current = { info: { title: 'a' } };
    t.music.emit('trackStarted', 'g', view('a'));
    await wait(5);
    assert.equal(t.sent.length, 1);
    assert.equal(buttonIds(t.sent[0]).length, 6);
    assert.ok(t.context.nowPlaying.isCurrent('g', t.sent[0].id));

    t.sent[0].failDelete = true; // e.g. deleted by hand already, or no permission
    t.music.emit('trackStarted', 'g', view('b'));
    await wait(5);
    assert.deepEqual(t.sent[0].edits.at(-1), { components: [] }, 'old buttons removed when delete fails');
    assert.ok(!t.context.nowPlaying.isCurrent('g', t.sent[0].id));
    assert.ok(t.context.nowPlaying.isCurrent('g', t.sent[1].id));
  });

  it('marks songs added by autoplay', async () => {
    const t = setup();
    t.queue.current = { info: { title: 'a' } };
    t.music.emit('trackStarted', 'g', view('a', { autoplay: true }));
    await wait(5);
    const embed = t.sent[0].payload.embeds[0].toJSON();
    assert.match(embed.description, /otomatik çalma/i);
    assert.equal(embed.fields.find((f) => f.name === 'İsteyen').value, '🤖 Otomatik çalma');
  });

  it('is edited when the button state changes, and loses its buttons when the song ends', async () => {
    const t = setup();
    t.queue.current = { info: { title: 'a' } };
    t.music.emit('trackStarted', 'g', view('a'));
    await wait(5);
    t.music.emit('stateChanged', 'g'); // a position update: nothing to edit
    await wait(700);
    assert.equal(t.sent[0].edits.length, 0);

    t.player.paused = true;
    t.music.emit('stateChanged', 'g');
    t.music.emit('stateChanged', 'g');
    await wait(700);
    assert.equal(t.sent[0].edits.length, 1, 'one edit for several changes');
    const ids = t.sent[0].edits[0].components.flatMap((row) => row.toJSON().components.map((c) => c.label));
    assert.ok(ids.includes('Devam'));

    t.queue.current = null; // finished, nothing next yet
    t.music.emit('stateChanged', 'g');
    await wait(700);
    assert.deepEqual(t.sent[0].edits.at(-1), { components: [] });
    t.music.emit('stateChanged', 'g');
    await wait(700);
    assert.equal(t.sent[0].edits.length, 2, 'not edited again');

    t.music.emit('queueEnded', 'g');
    await wait(5);
    assert.equal(t.sent[0].deleted, true);
  });
});
