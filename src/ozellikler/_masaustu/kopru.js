// Masaüstü uygulaması ile bot arasındaki ayar köprüsü (karar A1, yalnız yerel dosyalar, port açılmaz):
//   data/sunucu-yapisi/<id>.json  sunucu başına kanal ve rol listeleri (yapi.js); girişte ve olayda yalnız
//                             o sunucununki birkaç saniye toplanıp yazılır
//   data/ayar-semasi.json     modüllerin ayar şeması (gorunum.js); girişte yazılır
//   data/ayarlar-gorunum.json şimdiki değerler (gorunum.js); bir istek uygulanınca hemen, /ayar ve benzeri
//                             komutlardan sonra 1 sn içinde, ayrıca 30 sn'de bir (değiştiyse) yazılır
//   data/istekler, data/yanitlar  uygulamanın istekleri ve botun yanıtları (istekler.js)
// Bot Discord'a giriş yapınca start(), kapanırken stop() çağrılır. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { Events } from 'discord.js';
import { OZ_PREFIX } from '../_ortak.js';
import { createJsonFileWriter } from './dosya.js';
import { buildSchemaExport, buildSettingsView } from './gorunum.js';
import { createRequestProcessor } from './istekler.js';
import { createStructureFiles } from './yapi.js';

export const DESKTOP_FILES = Object.freeze({
  yapi: 'sunucu-yapisi',
  sema: 'ayar-semasi.json',
  gorunum: 'ayarlar-gorunum.json',
  istekler: 'istekler',
  yanitlar: 'yanitlar',
});

/** Commands after which the settings on screen may have changed. */
const SETTING_COMMANDS = new Set(['ayar', 'seviye']);

/** Events whose first or second argument is a channel or role (they carry their guild). */
const PART_EVENTS = [
  Events.ChannelCreate,
  Events.ChannelDelete,
  Events.ChannelUpdate,
  Events.GuildRoleCreate,
  Events.GuildRoleDelete,
  Events.GuildRoleUpdate,
];
/** Events whose argument is the guild itself. */
const GUILD_EVENTS = [Events.GuildCreate, Events.GuildDelete, Events.GuildUpdate];

/**
 * @param {object} context the bot context (client, ozellikler, isOwner, logger)
 * @param {{ dataDir: string, fs?: object, timers?: object, structureDelayMs?: number }} options
 */
export function attachDesktopBridge(
  context,
  { dataDir, fs = nodeFs, timers = globalThis, structureDelayMs = 3000, viewDelayMs = 1000 },
) {
  const logger = context.logger?.child?.('masaüstü') ?? context.logger;
  const { client } = context;
  const file = (name) => join(dataDir, DESKTOP_FILES[name]);
  const structure = createStructureFiles({ dir: file('yapi'), client, delayMs: structureDelayMs, logger, fs, timers });
  const schema = createJsonFileWriter({
    file: file('sema'),
    collect: () => buildSchemaExport(context.ozellikler),
    logger,
    fs,
    timers,
  });
  const view = createJsonFileWriter({
    file: file('gorunum'),
    collect: () => buildSettingsView(context),
    delayMs: viewDelayMs,
    logger,
    fs,
    timers,
  });
  const processor = createRequestProcessor({
    context,
    dir: file('istekler'),
    answersDir: file('yanitlar'),
    logger,
    fs,
    timers,
    // The new value is on disk before the answer, so the app re-reads the right thing.
    onApplied: (istek) => {
      view.writeNow();
      structure.poke(istek.guildId);
    },
  });

  const changed = (guildId) => {
    if (!guildId) return;
    structure.poke(guildId);
    view.poke(); // role warnings depend on positions and permissions
  };
  const onPart = (first, second) => changed((second ?? first)?.guild?.id ?? (second ?? first)?.guildId);
  const onGuild = (first, second) => changed((second ?? first)?.id);
  /** The bot's own roles changed (it only hears this with the members intent; role events cover the rest). */
  const onMember = (_old, member) => {
    if (member?.id && member.id === client.user?.id) changed(member.guild?.id);
  };
  const onInteraction = (interaction) => {
    const name = interaction.isChatInputCommand?.() ? interaction.commandName : null;
    if ((name && SETTING_COMMANDS.has(name)) || String(interaction.customId ?? '').startsWith(OZ_PREFIX)) view.poke();
  };

  let started = false;
  let intervals = [];
  return {
    start() {
      if (started) return;
      started = true;
      schema.writeNow();
      structure.writeAll();
      view.writeNow();
      for (const event of PART_EVENTS) client.on(event, onPart);
      for (const event of GUILD_EVENTS) client.on(event, onGuild);
      client.on(Events.GuildMemberUpdate, onMember);
      client.on(Events.InteractionCreate, onInteraction);
      intervals = [
        timers.setInterval(() => view.writeNow(), 30_000),
        timers.setInterval(() => structure.writeAll(), 5 * 60_000),
      ];
      for (const interval of intervals) interval?.unref?.();
      processor.start();
    },
    stop() {
      if (!started) return;
      started = false;
      processor.stop();
      for (const event of PART_EVENTS) client.off(event, onPart);
      for (const event of GUILD_EVENTS) client.off(event, onGuild);
      client.off(Events.GuildMemberUpdate, onMember);
      client.off(Events.InteractionCreate, onInteraction);
      for (const interval of intervals) timers.clearInterval(interval);
      intervals = [];
      structure.stop();
      view.stop();
      schema.stop();
    },
    /** For tests: the parts. */
    structure,
    view,
    schema,
    processor,
  };
}
