// Discord allows at most 8000 characters per slash command (names, descriptions and choice values of the
// command and all its options together). /ayar and /oyun grow with every feature module, so every loaded
// command is measured here and "npm run deploy-commands -- --check" checks the same limit.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCommandPayload, countChars, MAX_TOTAL_CHARS } from '../src/bot/commandPayload.js';
import { loadCommands } from '../src/commands/index.js';

describe('command size', () => {
  it("the limit is Discord's 8000 characters", () => {
    assert.equal(MAX_TOTAL_CHARS, 8000);
  });

  it('every slash command stays within 8000 characters', async () => {
    const commands = await loadCommands();
    for (const { data } of commands.values()) {
      const json = data.toJSON();
      if ((json.type ?? 1) !== 1) continue;
      const size = countChars(json);
      assert.ok(size <= MAX_TOTAL_CHARS, `/${json.name}: ${size} karakter (en fazla ${MAX_TOTAL_CHARS})`);
    }
    assert.deepEqual(buildCommandPayload(commands).problems, []);
  });

  it('localizations: only the longest version of each field counts (not the sum of all languages)', () => {
    const option = {
      name: 'ad',
      name_localizations: { 'en-US': 'name', de: 'namee' },
      description: 'abc',
      description_localizations: { 'en-US': 'a' },
      choices: [{ name: 'x', name_localizations: { fr: 'xyz' }, value: 'v1' }],
    };
    assert.equal(countChars(option), 5 + 3 + 3 + 2);
  });

  it('a command over the limit is reported', () => {
    const big = {
      name: 'buyuk',
      description: 'x',
      options: Array.from({ length: 25 }, (_, i) => ({
        type: 1,
        name: `alt${i}`,
        description: 'y'.repeat(100),
        options: Array.from({ length: 4 }, (__, j) => ({ type: 3, name: `s${j}`, description: 'z'.repeat(100) })),
      })),
    };
    const { problems } = buildCommandPayload(new Map([['buyuk', { data: { toJSON: () => big }, file: 'buyuk.js' }]]));
    assert.ok(
      problems.some((p) => /8000 karakteri aşıyor/.test(p)),
      problems.join('; '),
    );
  });
});
