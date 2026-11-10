// /servers is for the bot owner only: owner from the Discord application (user or team),
// or BOT_OWNER_IDS in .env. The list is private (ephemeral) and paged (max 25 embed fields).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { Collection, TeamMemberRole } from 'discord.js';
import { createOwnerCheck, ownerIdsOf } from '../src/bot/owner.js';
import { execute as servers, renderServerPage } from '../src/commands/servers.js';

const OWNER = '111111111111111111';
const ADMIN = '222222222222222222';
const DEV = '333333333333333333';
const STRANGER = '444444444444444444';

function team() {
  const members = new Collection([
    [OWNER, { id: OWNER, role: TeamMemberRole.Admin }],
    [ADMIN, { id: ADMIN, role: TeamMemberRole.Admin }],
    [DEV, { id: DEV, role: TeamMemberRole.Developer }],
  ]);
  return { ownerId: OWNER, members };
}

function fakeClient(owner, guildCount = 3) {
  const client = {
    fetches: 0,
    application: {
      async fetch() {
        client.fetches += 1;
        if (owner instanceof Error) throw owner;
        return { owner };
      },
    },
    guilds: {
      cache: new Collection(
        Array.from({ length: guildCount }, (_, i) => [String(i), { name: `Sunucu ${i}`, memberCount: i * 10 }]),
      ),
    },
  };
  return client;
}

function fakeInteraction(userId, client) {
  const replies = [];
  return {
    id: 'int1',
    user: { id: userId },
    client,
    replies,
    deferred: false,
    replied: false,
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
      return { resource: { message: { createMessageComponentCollector: () => ({ on() {} }) } } };
    },
  };
}

describe('bot owner', () => {
  it('a user-owned application: that user', () => {
    assert.deepEqual(ownerIdsOf({ owner: { id: OWNER } }), [OWNER]);
    assert.deepEqual(ownerIdsOf({ owner: null }), []);
  });

  it('a team-owned application: the team owner and admins, not developers', () => {
    assert.deepEqual(ownerIdsOf({ owner: team() }).sort(), [OWNER, ADMIN].sort());
  });

  it('fetches the application once and caches it', async () => {
    const client = fakeClient({ id: OWNER });
    const isOwner = createOwnerCheck({ client });
    assert.equal(await isOwner(OWNER), true);
    assert.equal(await isOwner(STRANGER), false);
    assert.equal(client.fetches, 1);
  });

  it('BOT_OWNER_IDS overrides the application owner', async () => {
    const client = fakeClient({ id: OWNER });
    const isOwner = createOwnerCheck({ client, overrideIds: [STRANGER] });
    assert.equal(await isOwner(STRANGER), true);
    assert.equal(await isOwner(OWNER), false);
    assert.equal(client.fetches, 0);
  });

  it('a failed lookup denies instead of crashing', async () => {
    const isOwner = createOwnerCheck({ client: fakeClient(new Error('ağ yok')), logger: { warn() {} } });
    assert.equal(await isOwner(OWNER), false);
  });

  it('BOT_OWNER_IDS is read from the environment and validated', () => {
    const script = `
      const { loadConfig } = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
      try { console.log(JSON.stringify(loadConfig({ requireToken: false }).discord.ownerIds)); }
      catch (error) { console.log('HATA ' + error.message); }`;
    const run = (value) =>
      spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, BOT_OWNER_IDS: value },
      }).stdout.trim();
    assert.equal(run(` ${OWNER} , ${ADMIN} `), JSON.stringify([OWNER, ADMIN]));
    assert.equal(run(' '), '[]');
    assert.match(run('bir-isim'), /^HATA BOT_OWNER_IDS/);
  });
});

describe('/servers', () => {
  it('refuses everyone but the owner, in Turkish and privately', async () => {
    const client = fakeClient({ id: OWNER });
    const interaction = fakeInteraction(STRANGER, client);
    await servers(interaction, { isOwner: createOwnerCheck({ client }) });
    assert.match(interaction.replies[0].embeds[0].toJSON().description, /Bu komutu kullanma yetkin yok\./);
    assert.ok(interaction.replies[0].flags, 'ephemeral');
  });

  it('shows the owner a private list with names and member counts', async () => {
    const client = fakeClient(team());
    const interaction = fakeInteraction(ADMIN, client);
    await servers(interaction, { isOwner: createOwnerCheck({ client }) });
    const [reply] = interaction.replies;
    assert.ok(reply.flags, 'ephemeral');
    const embed = reply.embeds[0].toJSON();
    assert.deepEqual(
      embed.fields.map((f) => [f.name, f.value]),
      [
        ['Sunucu 2', '👥 20 üye'],
        ['Sunucu 1', '👥 10 üye'],
        ['Sunucu 0', '👥 0 üye'],
      ],
    );
  });

  it('pages stay under the 25 field limit', () => {
    const guilds = Array.from({ length: 37 }, (_, i) => ({ name: `S${i}`, memberCount: i }));
    const first = renderServerPage(guilds, 1);
    assert.equal(first.pageCount, 4);
    const last = renderServerPage(guilds, 99);
    assert.equal(last.page, 4);
    for (let page = 1; page <= 4; page += 1) {
      assert.ok(renderServerPage(guilds, page).embed.toJSON().fields.length <= 25);
    }
    assert.equal(last.embed.toJSON().fields.length, 7);
  });
});
