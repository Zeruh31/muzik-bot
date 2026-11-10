// The song picker used by /play (song name) and /search: numbered list, only the author may pick,
// timeout cleans the list up. Discord is faked; awaitMessageComponent runs the real filter.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execute as play } from '../src/commands/play.js';
import { pickAndPlay } from '../src/commands/_secim.js';

const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
const AUTHOR = '111111111111111111';
const STRANGER = '222222222222222222';

function track(title) {
  return {
    encoded: `enc-${title}`,
    info: { title, author: 'Sanatçı', duration: 180_000, uri: `https://youtu.be/${title}`, isStream: false },
  };
}
const TRACKS = Array.from({ length: 12 }, (_, i) => track(`s${i}`));

function voiceChannel() {
  return {
    id: '555555555555555555',
    full: false,
    guild: { members: { me: {} } },
    permissionsFor: () => ({ has: () => true }),
  };
}

/** A component click: button customId or select menu value. */
function click(userId, { customId, values } = {}) {
  const replies = [];
  return {
    customId,
    values,
    user: { id: userId },
    guildId: 'g',
    member: { voice: { channel: voiceChannel() } },
    replies,
    deferred: false,
    isStringSelectMenu: () => Boolean(values),
    async deferUpdate() {
      this.deferred = true;
    },
    async reply(payload) {
      replies.push(payload);
    },
  };
}

/** Fake slash command interaction; `clicks` are fed to awaitMessageComponent in order. */
function fakeInteraction({ clicks = [], options = {} } = {}) {
  const edits = [];
  const message = {
    async awaitMessageComponent({ filter }) {
      for (const component of clicks) if (await filter(component)) return component;
      throw new Error('time'); // what discord.js does when the time runs out
    },
  };
  return {
    id: 'int1',
    user: { id: AUTHOR },
    guildId: 'g',
    channelId: 'text1',
    deferred: false,
    replied: false,
    member: { voice: { channel: voiceChannel() } },
    options: { getString: (name) => options[name] ?? null },
    edits,
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload) {
      edits.push(payload);
      return message;
    },
  };
}

function fakeMusic({ resolved } = {}) {
  const calls = [];
  return {
    calls,
    getPlayer: () => null,
    async resolve(query) {
      calls.push(['resolve', query]);
      return resolved;
    },
    async enqueue(options) {
      calls.push(['enqueue', options]);
      return { tracks: [{ title: options.tracks[0].info.title, duration: 1 }], queuePosition: 0, skippedForLimit: 0 };
    },
    async playResolved(options) {
      calls.push(['playResolved', options]);
      return { tracks: [{ title: 'x', duration: 1 }], queuePosition: 0, skippedForLimit: 0, kind: 'track' };
    },
  };
}

const json = (builder) => builder.toJSON();

describe('song picker', () => {
  it('shows 5 numbered buttons with the requester and the voice channel', async () => {
    const interaction = fakeInteraction();
    await pickAndPlay(
      interaction,
      { music: fakeMusic(), logger: silent },
      {
        tracks: TRACKS,
        query: 'aramam',
        voiceChannelId: '555555555555555555',
        count: 5,
      },
    );
    const first = interaction.edits[0];
    const embed = json(first.embeds[0]);
    assert.equal(embed.description.split('\n').length, 5);
    assert.deepEqual(
      embed.fields.map((f) => f.value),
      [`<@${AUTHOR}>`, '<#555555555555555555>'],
    );
    const buttons = json(first.components[0]).components;
    assert.deepEqual(
      buttons.map((b) => b.label),
      ['1', '2', '3', '4', '5'],
    );
  });

  it('on timeout writes "Zamanında şarkı seçilmedi" and removes the list', async () => {
    const interaction = fakeInteraction();
    const music = fakeMusic();
    const result = await pickAndPlay(
      interaction,
      { music, logger: silent },
      {
        tracks: TRACKS,
        query: 'aramam',
        voiceChannelId: 'v',
        count: 5,
      },
    );
    assert.equal(result, null);
    const last = interaction.edits.at(-1);
    assert.match(last.content, /Zamanında şarkı seçilmedi: aramam/);
    assert.deepEqual(last.embeds, []);
    assert.deepEqual(last.components, []);
    assert.equal(music.calls.length, 0, 'nothing is queued');
  });

  it('only the author can pick; others get a private notice', async () => {
    const stranger = click(STRANGER, { customId: 'secim:int1:0' });
    const author = click(AUTHOR, { customId: 'secim:int1:2' });
    const interaction = fakeInteraction({ clicks: [stranger, author] });
    const music = fakeMusic();
    await pickAndPlay(
      interaction,
      { music, logger: silent },
      {
        tracks: TRACKS,
        query: 'aramam',
        voiceChannelId: 'v',
        count: 5,
      },
    );
    assert.equal(stranger.replies.length, 1);
    assert.match(stranger.replies[0].content, /yalnızca komutu yazan/);
    assert.ok(stranger.replies[0].flags, 'ephemeral');

    const [[name, options]] = music.calls;
    assert.equal(name, 'enqueue');
    assert.equal(options.tracks[0], TRACKS[2]);
    assert.equal(options.fallback, undefined, 'an explicit pick is never swapped for another result');
    assert.equal(options.fromList, true);
    assert.ok(author.deferred);
    assert.deepEqual(interaction.edits.at(-1).components, []);
  });

  it('ignores clicks on other messages', async () => {
    const other = click(AUTHOR, { customId: 'queue:999:next' });
    const interaction = fakeInteraction({ clicks: [other] });
    const music = fakeMusic();
    await pickAndPlay(
      interaction,
      { music, logger: silent },
      { tracks: TRACKS, query: 'q', voiceChannelId: 'v', count: 5 },
    );
    assert.equal(music.calls.length, 0);
    assert.match(interaction.edits.at(-1).content, /Zamanında şarkı seçilmedi/);
  });

  it('uses a select menu for more than 5 results (/search)', async () => {
    const pick = click(AUTHOR, { customId: 'secim:int1:menu', values: ['7'] });
    const interaction = fakeInteraction({ clicks: [pick] });
    const music = fakeMusic();
    await pickAndPlay(
      interaction,
      { music, logger: silent },
      { tracks: TRACKS, query: 'q', voiceChannelId: 'v', count: 10 },
    );
    const menu = json(interaction.edits[0].components[0]).components[0];
    assert.equal(menu.options.length, 10);
    assert.equal(music.calls[0][1].tracks[0], TRACKS[7]);
  });
});

describe('/play', () => {
  const context = (music, playShowChoices) => ({ music, logger: silent, config: { music: { playShowChoices } } });

  it('a song name shows the list when PLAY_SHOW_CHOICES is on', async () => {
    const music = fakeMusic({ resolved: { kind: 'search', tracks: TRACKS, playlistName: null } });
    const interaction = fakeInteraction({ options: { şarkı: 'tarkan' } });
    await play(interaction, context(music, true));
    assert.ok(interaction.edits[0].components?.length, 'choice list shown');
    assert.ok(!music.calls.some(([name]) => name === 'playResolved'));
  });

  it('links and playlists play directly', async () => {
    for (const kind of ['track', 'playlist']) {
      const music = fakeMusic({ resolved: { kind, tracks: TRACKS.slice(0, 3), playlistName: 'L' } });
      const interaction = fakeInteraction({ options: { şarkı: 'https://youtu.be/x' } });
      await play(interaction, context(music, true));
      assert.equal(music.calls.at(-1)[0], 'playResolved', kind);
      assert.equal(interaction.edits.length, 1);
      assert.equal(interaction.edits[0].components, undefined);
    }
  });

  it('a single search result plays directly, without a list', async () => {
    const music = fakeMusic({ resolved: { kind: 'search', tracks: TRACKS.slice(0, 1), playlistName: null } });
    const interaction = fakeInteraction({ options: { şarkı: 'tarkan' } });
    await play(interaction, context(music, true));
    assert.equal(music.calls.at(-1)[0], 'playResolved');
  });

  it('PLAY_SHOW_CHOICES=false plays the first result directly', async () => {
    const music = fakeMusic({ resolved: { kind: 'search', tracks: TRACKS, playlistName: null } });
    const interaction = fakeInteraction({ options: { şarkı: 'tarkan' } });
    await play(interaction, context(music, false));
    assert.equal(music.calls.at(-1)[0], 'playResolved');
  });
});
