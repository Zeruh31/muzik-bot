import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommandPayload } from '../src/bot/commandPayload.js';
import { loadCommands } from '../src/commands/index.js';

const EXPECTED = [
  'bassboost',
  'clear',
  'disconnect',
  'dj',
  'grab',
  'help',
  'invite',
  'loop',
  'loopqueue',
  'lyrics',
  'move',
  'nowplaying',
  'pause',
  'play',
  'playfirst',
  'queue',
  'remove',
  'resume',
  'search',
  'seek',
  'servers',
  'shuffle',
  'skip',
  'skipto',
  'stats',
  'stop',
  'volume',
];

describe('slash command definitions', () => {
  it('load all expected commands and nothing from the old prefix system', async () => {
    const commands = await loadCommands();
    assert.deepEqual([...commands.keys()].sort(), EXPECTED);
    assert.ok(!commands.has('config') && !commands.has('youtube'));
  });

  it('compile to valid Discord API JSON', async () => {
    const { body, problems } = buildCommandPayload(await loadCommands());
    assert.deepEqual(problems, []);
    assert.equal(body.length, EXPECTED.length);
    for (const command of body) {
      assert.equal(command.type ?? 1, 1);
      assert.ok(command.description.length <= 100);
    }
  });

  it('the validator catches broken definitions', () => {
    const fake = new Map([['x', { file: 'x.js', data: { toJSON: () => ({ name: 'Bad Name', description: '' }) } }]]);
    const { problems } = buildCommandPayload(fake);
    assert.ok(problems.length >= 2);
  });
});
