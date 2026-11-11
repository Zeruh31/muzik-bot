// "Now playing" control buttons: who may press them (same voice channel, DJ rule), the short
// ephemeral warning for everyone else, stale messages, the repeat cycle and customId prefixes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ButtonStyle, MessageFlags } from 'discord.js';
import {
  CONTROL_ACTIONS,
  CONTROL_PREFIX,
  controlAction,
  controlId,
  controlRows,
  controlSignature,
  handleControlButton,
  nextRepeatMode,
} from '../src/bot/controls.js';
import { DJ_COMMANDS } from '../src/bot/dj.js';

const GUILD = '222222222222222222';
const USER = '111111111111111111';
const OTHER = '333333333333333333';
const BOT = '999999999999999999';
const DJ = '444444444444444444';
const VOICE = '555555555555555555';
const ELSEWHERE = '666666666666666666';
const MESSAGE = '777777777777777777';

/** A fake MusicService that records the operations the buttons run. */
function fakeMusic(state = {}) {
  const calls = [];
  const current = { paused: false, repeatMode: 'off', ...state };
  return {
    calls,
    getPlayer: () => ({ voiceChannelId: VOICE }),
    getState: () => current,
    async togglePause() {
      current.paused = !current.paused;
      calls.push(current.paused ? 'pause' : 'resume');
      return current.paused;
    },
    async skip() {
      calls.push('skip');
    },
    async stop() {
      calls.push('stop');
    },
    async previous() {
      calls.push('previous');
    },
    async shuffle() {
      calls.push('shuffle');
    },
    async cycleRepeatMode() {
      current.repeatMode = nextRepeatMode(current.repeatMode);
      calls.push(`repeat:${current.repeatMode}`);
      return current.repeatMode;
    },
  };
}

/** A button click by USER; `inVoice` is the channel USER sits in (null = none). */
function click(action, { inVoice = VOICE, roles = [], manage = false, others = [OTHER], messageId = MESSAGE } = {}) {
  const replies = [];
  const voiceStates = new Map([
    [BOT, { channelId: VOICE }],
    ...(inVoice ? [[USER, { channelId: inVoice }]] : []),
    ...others.map((id) => [id, { channelId: VOICE }]),
  ]);
  return {
    customId: controlId(action),
    guildId: GUILD,
    guild: {
      id: GUILD,
      members: { me: { id: BOT, voice: { channelId: VOICE } } },
      voiceStates: { cache: voiceStates },
    },
    user: { id: USER },
    member: { roles, voice: { channel: inVoice ? { id: inVoice } : null } },
    memberPermissions: { has: () => manage },
    message: {
      id: messageId,
      edits: [],
      async edit(payload) {
        this.edits.push(payload);
      },
    },
    replies,
    deferred: false,
    async reply(payload) {
      replies.push(payload);
    },
    async deferUpdate() {
      this.deferred = true;
    },
    async followUp(payload) {
      replies.push(payload);
    },
  };
}

function contextWith({ djRoleId = null, music = fakeMusic(), current = MESSAGE } = {}) {
  return {
    music,
    settings: { getDjRole: () => djRoleId },
    nowPlaying: { isCurrent: (_g, id) => id === current },
    logger: { error() {}, debug() {} },
  };
}

const isWarning = (reply) => reply.flags === MessageFlags.Ephemeral && reply.content.startsWith('❌');

describe('control buttons', () => {
  it('run the same operations as the slash commands for someone in the bot channel', async () => {
    const music = fakeMusic();
    const context = contextWith({ music });
    for (const action of Object.keys(CONTROL_ACTIONS)) {
      const interaction = click(action);
      assert.equal(await handleControlButton(interaction, context), 'done', action);
      assert.equal(interaction.deferred, true, `${action} acknowledged without a message`);
      assert.deepEqual(interaction.replies, []);
    }
    assert.deepEqual(music.calls, ['previous', 'pause', 'skip', 'stop', 'repeat:track', 'shuffle']);
  });

  it('pause/resume follows the state; loop cycles off -> track -> queue -> off', async () => {
    const music = fakeMusic({ paused: true, repeatMode: 'queue' });
    const context = contextWith({ music });
    await handleControlButton(click('toggle'), context);
    await handleControlButton(click('loop'), context);
    assert.deepEqual(music.calls, ['resume', 'repeat:off']);
    assert.deepEqual(['off', 'track', 'queue'].map(nextRepeatMode), ['track', 'queue', 'off']);
  });

  it('refuses someone outside the voice channel with a short warning only they see', async () => {
    const music = fakeMusic();
    const notInVoice = click('skip', { inVoice: null });
    assert.equal(await handleControlButton(notInVoice, contextWith({ music })), 'denied');
    assert.ok(isWarning(notInVoice.replies[0]));
    assert.match(notInVoice.replies[0].content, /ses kanalına/);

    const elsewhere = click('stop', { inVoice: ELSEWHERE });
    assert.equal(await handleControlButton(elsewhere, contextWith({ music })), 'denied');
    assert.ok(isWarning(elsewhere.replies[0]));
    assert.match(elsewhere.replies[0].content, new RegExp(VOICE));
    assert.deepEqual(music.calls, [], 'nothing ran');
  });

  it('follows the DJ rule: role, server manager or alone with the bot', async () => {
    const music = fakeMusic();
    const context = contextWith({ djRoleId: DJ, music });
    const plain = click('skip');
    assert.equal(await handleControlButton(plain, context), 'denied');
    assert.ok(isWarning(plain.replies[0]));
    assert.match(plain.replies[0].content, new RegExp(`<@&${DJ}>`));
    assert.deepEqual(plain.replies[0].allowedMentions, { parse: [] }, 'the role is not pinged');
    assert.deepEqual(music.calls, []);

    assert.equal(await handleControlButton(click('skip', { roles: [DJ] }), context), 'done');
    assert.equal(await handleControlButton(click('stop', { manage: true }), context), 'done');
    assert.equal(await handleControlButton(click('toggle', { others: [] }), context), 'done');
    assert.deepEqual(music.calls, ['skip', 'stop', 'pause']);
  });

  it('every button follows a DJ-gated command', () => {
    for (const command of Object.values(CONTROL_ACTIONS)) assert.ok(DJ_COMMANDS.has(command), command);
  });

  it('a click on an old now-playing message removes its buttons and warns', async () => {
    const music = fakeMusic();
    const old = click('skip', { messageId: '888888888888888888' });
    assert.equal(await handleControlButton(old, contextWith({ music })), 'stale');
    assert.ok(isWarning(old.replies[0]));
    assert.deepEqual(old.message.edits, [{ components: [] }]);
    assert.deepEqual(music.calls, []);
  });

  it('a failing operation is reported to the clicker only', async () => {
    const music = fakeMusic();
    music.previous = async () => {
      const { MusicError } = await import('../src/music/errors.js');
      throw new MusicError('NO_PREVIOUS', 'Geri dönülecek önceki bir şarkı yok.');
    };
    const interaction = click('previous');
    assert.equal(await handleControlButton(interaction, contextWith({ music })), 'failed');
    assert.ok(isWarning(interaction.replies[0]));
  });

  it('customIds use their own prefix and ignore other components', () => {
    assert.equal(controlAction(controlId('skip')), 'skip');
    for (const other of ['secim:123:0', 'sayfa:123:next', 'gecmis:123:menu', `${CONTROL_PREFIX}nope`, null]) {
      assert.equal(controlAction(other), null, String(other));
    }
    const ids = controlRows({ queue: [] }).flatMap((row) => row.toJSON().components.map((c) => c.custom_id));
    assert.equal(new Set(ids).size, ids.length, 'unique per message');
    assert.ok(ids.every((id) => id.startsWith(CONTROL_PREFIX)));
  });

  it('buttons reflect the state: pause/resume, repeat, previous and shuffle availability', () => {
    const json = (state) => controlRows(state).flatMap((row) => row.toJSON().components);
    const idle = json({ current: {}, paused: false, repeatMode: 'off', hasPrevious: false, queue: [1] });
    const find = (list, action) => list.find((c) => c.custom_id === controlId(action));
    assert.equal(find(idle, 'previous').disabled, true);
    assert.equal(find(idle, 'shuffle').disabled, true);
    assert.equal(find(idle, 'toggle').label, 'Duraklat');
    const busy = json({ current: {}, paused: true, repeatMode: 'track', hasPrevious: true, queue: [1, 2] });
    assert.equal(find(busy, 'previous').disabled, false);
    assert.equal(find(busy, 'shuffle').disabled, false);
    assert.equal(find(busy, 'toggle').label, 'Devam');
    assert.equal(find(busy, 'loop').style, ButtonStyle.Success);
    assert.ok(json(null).every((c) => c.type === 2));
    assert.notEqual(
      controlSignature({ current: {}, paused: false, repeatMode: 'off', hasPrevious: false, queue: [] }),
      controlSignature({ current: {}, paused: true, repeatMode: 'off', hasPrevious: false, queue: [] }),
    );
  });
});
