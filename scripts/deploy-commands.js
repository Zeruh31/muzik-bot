// Registers the slash commands with Discord.
//   npm run deploy-commands            -> validate, then send (needs DISCORD_TOKEN + DISCORD_CLIENT_ID)
//   npm run deploy-commands -- --check -> only validate, never send (no token needed)
// With DISCORD_GUILD_ID set, commands go to that one server and appear instantly;
// otherwise they are global and can take a few minutes to show up everywhere.
//
// Exits through process.exitCode (never process.exit()): exiting while the REST client's
// sockets are still closing aborts Node on Windows with a libuv assertion.

import { REST, Routes } from 'discord.js';
import { buildCommandPayload } from '../src/bot/commandPayload.js';
import { loadCommands } from '../src/commands/index.js';
import { ConfigError, loadConfig } from '../src/config.js';

/** A user-facing failure: printed as one Turkish line, exit code 1, no stack trace. */
class Failure extends Error {}

function explainRestError(error) {
  const status = error?.status;
  if (status === 401) return "Discord token'ı geçersiz (.env > DISCORD_TOKEN).";
  if (status === 403 || status === 404) {
    return 'Discord isteği reddetti: DISCORD_CLIENT_ID yanlış olabilir ya da bot DISCORD_GUILD_ID sunucusunda değil.';
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|Connect Timeout/i.test(`${error?.message} ${error?.cause?.code}`)) {
    return "Discord'a bağlanılamadı. İnternet bağlantısını (ve Discord engelliyse erişim aracınızı) kontrol edin.";
  }
  return `Komutlar kaydedilemedi: ${error?.message ?? error}`;
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  let config;
  try {
    config = loadConfig({ requireToken: false });
  } catch (error) {
    if (error instanceof ConfigError) throw new Failure(error.message);
    throw error;
  }

  const commands = await loadCommands();
  const { body, problems } = buildCommandPayload(commands);
  if (problems.length) {
    throw new Failure(`Komut tanımlarında ${problems.length} sorun var:\n  - ${problems.join('\n  - ')}`);
  }
  const shown = body.map((c) => ((c.type ?? 1) === 1 ? `/${c.name}` : `"${c.name}" (sağ tık)`));
  const slash = body.filter((c) => (c.type ?? 1) === 1).length;
  console.log(
    `Komut tanımları geçerli: ${body.length} komut, ${slash} eğik çizgi + ${body.length - slash} sağ tık (${shown.join(', ')})`,
  );
  if (checkOnly) return;

  const { token, clientId, guildId } = config.discord;
  if (!token || !clientId) {
    throw new Failure("Komutları Discord'a göndermek için .env içinde DISCORD_TOKEN ve DISCORD_CLIENT_ID dolu olmalı.");
  }

  const rest = new REST().setToken(token);
  try {
    const route = guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId);
    const result = await rest.put(route, { body });
    console.log(
      guildId
        ? `Tamam: ${result.length} komut ${guildId} sunucusuna kaydedildi (hemen görünür).`
        : `Tamam: ${result.length} komut tüm sunuculara kaydedildi (görünmesi birkaç dakika sürebilir).`,
    );
  } catch (error) {
    throw new Failure(explainRestError(error));
  }
}

main().catch((error) => {
  if (error instanceof Failure) console.error(`\nHATA: ${error.message}\n`);
  else console.error(error);
  process.exitCode = 1;
});
