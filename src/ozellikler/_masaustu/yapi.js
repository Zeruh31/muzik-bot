// data/sunucu-yapisi/<sunucuId>.json: masaüstü uygulamasının ayar formundaki kanal ve rol listeleri. Sunucu başına
// ayrı bir dosyada
// metin/ses/kategori/forum kanalları (botun yazma ve bağlanma izniyle) ve roller (botun verip veremeyeceği,
// yönetim izni olup olmadığı). Üye listesi, mesaj ya da kullanıcı bilgisi YAZILMAZ.
// Şema README > "Durum dosyası" ve test/contract.test.js içinde. Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { basename, join } from 'node:path';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { botRefusal, hasForbiddenPermission } from '../_roller.js';
import { SNOWFLAKE } from '../ayarlar/sema.js';
import { createJsonFileWriter } from './dosya.js';
import { konsol } from './mesajlar.js';

export const STRUCTURE_SCHEMA_VERSION = 1;
const MAX_CHANNELS = 500;
const MAX_ROLES = 250;

const KINDS = new Map([
  [ChannelType.GuildText, 'metin'],
  [ChannelType.GuildAnnouncement, 'metin'],
  [ChannelType.GuildVoice, 'ses'],
  [ChannelType.GuildStageVoice, 'ses'],
  [ChannelType.GuildCategory, 'kategori'],
  [ChannelType.GuildForum, 'forum'],
]);
const SEND = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
const CONNECT = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function channelView(channel, me) {
  const tur = KINDS.get(channel.type);
  if (!tur) return null;
  const permissions = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
  const has = (flags) => Boolean(permissions?.has(flags));
  return {
    id: channel.id,
    ad: String(channel.name ?? ''),
    tur,
    kategoriId: channel.parentId ?? null,
    kategori: channel.parent?.name ?? null,
    yazabilir: tur === 'metin' && has(SEND),
    baglanabilir: tur === 'ses' && has(CONNECT),
  };
}

/** Discord's own order: categories by position, each followed by its channels. */
function sortKey(channel) {
  const position = num(channel.rawPosition ?? channel.position);
  if (channel.type === ChannelType.GuildCategory) return [position, -1, 0];
  const parentPosition = channel.parent ? num(channel.parent.rawPosition ?? channel.parent.position) : -1;
  // Voice channels come after text channels inside a category, as in the Discord client.
  return [parentPosition, KINDS.get(channel.type) === 'ses' ? 1 : 0, position];
}
const byKey = (a, b) => {
  const [x, y] = [sortKey(a), sortKey(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

function roleView(guild, role) {
  const neden = botRefusal(guild, role.id);
  return {
    id: role.id,
    ad: String(role.name ?? ''),
    renk: /^#[0-9a-f]{6}$/i.test(role.hexColor ?? '') ? role.hexColor.toLowerCase() : '#000000',
    pozisyon: num(role.position),
    yonetilen: Boolean(role.managed),
    tehlikeli: hasForbiddenPermission(role),
    verilebilir: !neden,
    neden,
  };
}

/** One guild: its channels and roles as the desktop app shows them (@everyone is left out). */
export function guildStructure(guild) {
  const me = guild.members?.me ?? null;
  const channels = [...(guild.channels?.cache?.values() ?? [])]
    .filter((channel) => KINDS.has(channel.type))
    .sort(byKey)
    .slice(0, MAX_CHANNELS)
    .map((channel) => channelView(channel, me));
  const roles = [...(guild.roles?.cache?.values() ?? [])]
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => num(b.position) - num(a.position))
    .slice(0, MAX_ROLES)
    .map((role) => roleView(guild, role));
  return {
    id: guild.id,
    ad: String(guild.name ?? ''),
    botRolPozisyonu: num(me?.roles?.highest?.position),
    rolleriYonetebilir: Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageRoles)),
    kanallar: channels,
    roller: roles,
  };
}

/** One data/sunucu-yapisi/<guildId>.json object. */
export function guildStructureFile(guild, { now = Date.now() } = {}) {
  return {
    schemaVersion: STRUCTURE_SCHEMA_VERSION,
    guncellendi: new Date(now).toISOString(),
    sunucu: guildStructure(guild),
  };
}

const GUILD_FILE = /^\d{17,20}\.json$/;
const RETRY_MS = 2000;

/**
 * data/sunucu-yapisi/<guildId>.json, one file per server, so a big bot never makes one huge file and an event
 * rewrites only the server it happened in (after `delayMs`, however many events come meanwhile).
 */
export function createStructureFiles({ dir, client, logger, fs = nodeFs, timers = globalThis, delayMs = 3000 }) {
  const writers = new Map();
  const writerOf = (guildId) => {
    if (!SNOWFLAKE.test(String(guildId))) return null;
    if (!writers.has(guildId)) {
      writers.set(
        guildId,
        createJsonFileWriter({
          file: join(dir, `${guildId}.json`),
          collect: () => guildStructureFile(client.guilds.cache.get(guildId)),
          logger,
          fs,
          timers,
          delayMs,
        }),
      );
    }
    return writers.get(guildId);
  };
  /** Removes a file; on an error (e.g. EPERM while an antivirus holds it) logs and tries once more a bit later. */
  function removeFile(file, retry = true) {
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      logger?.warn?.(konsol.silinemedi(basename(file), error?.code ?? error?.message ?? error));
      if (retry) timers.setTimeout(() => removeFile(file, false), RETRY_MS)?.unref?.();
    }
  }
  /** The bot left a server: its file goes too. */
  function remove(guildId) {
    writers.get(guildId)?.stop();
    writers.delete(guildId);
    if (SNOWFLAKE.test(String(guildId))) removeFile(join(dir, `${guildId}.json`));
  }
  return {
    /** Every server now, and removes files of servers the bot is no longer in. */
    writeAll() {
      const ids = new Set(client.guilds?.cache?.keys() ?? []);
      for (const id of ids) writerOf(id)?.writeNow();
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        // nothing written yet
      }
      for (const name of names) if (GUILD_FILE.test(name) && !ids.has(name.slice(0, -5))) remove(name.slice(0, -5));
    },
    poke(guildId) {
      if (!client.guilds?.cache?.has(guildId)) remove(guildId);
      else writerOf(guildId)?.poke();
    },
    remove,
    stop() {
      for (const writer of writers.values()) writer.stop();
    },
  };
}
