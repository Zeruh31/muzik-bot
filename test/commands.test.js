import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommandPayload } from '../src/bot/commandPayload.js';
import { loadCommands } from '../src/commands/index.js';

// Top-level commands from src/commands/ (feature module commands are in test/ozellikler-komutlar.test.js).
const EXPECTED = [
  'dj',
  'help',
  'invite',
  'muzik',
  'nowplaying',
  'pause',
  'play',
  'queue',
  'resume',
  'servers',
  'skip',
  'stats',
  'stop',
];

// Music commands that moved under /muzik; they keep their own files and logic.
const MUZIK_SUBCOMMANDS = [
  'autoplay',
  'bassboost',
  'clear',
  'crossfade',
  'disconnect',
  'gecmis',
  'grab',
  'liste',
  'loop',
  'loopqueue',
  'lyrics',
  'move',
  'playfirst',
  'previous',
  'remove',
  'search',
  'seek',
  'shuffle',
  'skipto',
  'volume',
];

describe('slash command definitions', () => {
  it('load all expected commands and nothing from the old prefix system', async () => {
    const commands = await loadCommands();
    const own = [...commands].filter(([, c]) => !c.file.startsWith('ozellikler/')).map(([name]) => name);
    assert.deepEqual(own.sort(), EXPECTED);
    assert.ok(!commands.has('config') && !commands.has('youtube'));
    assert.deepEqual([...commands.get('muzik').subcommands.keys()].sort(), MUZIK_SUBCOMMANDS);
  });

  it('compile to valid Discord API JSON', async () => {
    const commands = await loadCommands();
    const { body, problems } = buildCommandPayload(commands);
    assert.deepEqual(problems, []);
    assert.equal(body.length, commands.size);
    for (const command of body) {
      if ((command.type ?? 1) !== 1) continue; // context menu commands have no description
      assert.ok(command.description.length <= 100);
    }
    const muzik = body.find((c) => c.name === 'muzik');
    assert.deepEqual(muzik.options.map((o) => o.name).sort(), MUZIK_SUBCOMMANDS);
    assert.equal(muzik.options.find((o) => o.name === 'liste').type, 2, '/muzik liste is a subcommand group');
    assert.ok(muzik.options.length <= 25);
  });

  it('the validator catches broken definitions', () => {
    const fake = new Map([['x', { file: 'x.js', data: { toJSON: () => ({ name: 'Bad Name', description: '' }) } }]]);
    const { problems } = buildCommandPayload(fake);
    assert.ok(problems.length >= 2);
  });

  it('the validator refuses more than two levels of subcommands', () => {
    const deep = {
      name: 'x',
      description: 'x',
      options: [
        {
          type: 2,
          name: 'a',
          description: 'a',
          options: [{ type: 1, name: 'b', description: 'b', options: [{ type: 1, name: 'c', description: 'c' }] }],
        },
      ],
    };
    const { problems } = buildCommandPayload(new Map([['x', { file: 'x.js', data: { toJSON: () => deep } }]]));
    assert.ok(problems.some((p) => /alt komut/.test(p)));
  });
});
