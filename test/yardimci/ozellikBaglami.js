// Shared fakes for the feature module tests: a clock that only moves when told, a Discord channel that
// records what is sent, and a bot context with every module wired to a temporary data/ folder.

import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESTJSONErrorCodes } from 'discord.js';
import { createOzellikler, loadModules } from '../../src/ozellikler/index.js';

export const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const dirs = [];
export function tempDir(prefix = 'muzikbot-oz-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
export function removeTempDirs() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A clock whose time only moves with advance(); timers fire in order. */
export function fakeClock(start = Date.parse('2026-11-10T20:00:00Z')) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
    },
  };
}

/** A text channel that records sent messages; fetched messages record their edits. */
export function fakeChannel(id) {
  const messages = new Map();
  let nextId = 900000000000000000n;
  const channel = {
    id,
    sent: [],
    edits: [],
    async send(payload) {
      if (channel.fail) throw channel.fail;
      const message = { id: String(nextId++), payload, edit: async (p) => channel.edits.push({ id: message.id, p }) };
      messages.set(message.id, message);
      channel.sent.push(payload);
      return message;
    },
    messages: {
      async fetch(messageId) {
        const message = messages.get(messageId) ?? {
          id: messageId,
          edit: async (p) => channel.edits.push({ id: messageId, p }),
        };
        return message;
      },
    },
  };
  return channel;
}

/**
 * A bot context with all bundled modules. `dir` is the data/ folder (reuse it to simulate a restart).
 * @returns {Promise<object>} the context (context.ozellikler is the registry)
 */
export async function makeContext({ dir = tempDir(), clock = fakeClock(), channels = new Map(), guildIds = [] } = {}) {
  const context = {
    music: Object.assign(new EventEmitter(), { getState: () => null }),
    settings: { getDjRole: () => null },
    playlists: { list: () => [] },
    logger: silent,
    client: {
      guilds: { cache: new Map(guildIds.map((guildId) => [guildId, { id: guildId }])) },
      channels: {
        async fetch(channelId) {
          if (!channels.has(channelId))
            throw Object.assign(new Error('Unknown Channel'), { code: RESTJSONErrorCodes.UnknownChannel });
          return channels.get(channelId);
        },
      },
    },
  };
  createOzellikler({
    context,
    modules: await loadModules(),
    files: {
      ayarlar: join(dir, 'ozellikler.json'),
      zamanlayici: join(dir, 'zamanlayici.json'),
      paneller: join(dir, 'paneller.json'),
    },
    clock,
    logger: silent,
  });
  context.dir = dir;
  context.clock = clock;
  return context;
}

/** The text of every Text Display in a Components V2 payload, joined. */
export function textOf(payload) {
  const out = [];
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 10) out.push(c.content);
      walk(c.components);
      if (c.accessory) walk([c.accessory]);
    }
  };
  walk((payload.components ?? []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)));
  return out.join('\n');
}

/** Every custom_id (and link url) in a Components V2 payload. */
export function idsOf(payload) {
  const out = [];
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.custom_id) out.push(c.custom_id);
      walk(c.components);
      if (c.accessory) walk([c.accessory]);
    }
  };
  walk((payload.components ?? []).map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c)));
  return out;
}
