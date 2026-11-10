// Komut dosyalarının ortak yardımcıları. Adı "_" ile başlayan dosyalar komut olarak yüklenmez.
// Komutların açıklamaları ve cevapları src/mesajlar.js içindeki "komutlar" bölümündedir.

import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { ekleme, komutlar } from '../mesajlar.js';
import { baseEmbed, errorEmbed, successEmbed, trackDuration, trackLink } from '../util/embeds.js';
import { escapeMarkdown, truncate } from '../util/format.js';

export { requireJoinableVoice, requireSameVoice } from '../util/voice.js';

/** A slash command that only exists inside servers. Its description comes from mesajlar.js. */
export function guildCommand(name) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(komutlar[name].aciklama)
    .setContexts(InteractionContextType.Guild);
}

/** A slash command that also works in the bot's DMs (help, invite, stats). */
export function anywhereCommand(name) {
  return guildCommand(name).setContexts(InteractionContextType.Guild, InteractionContextType.BotDM);
}

/** Names an option and takes its description from mesajlar.js (komutlar.<command>.secenekler). */
export function describe(option, command, name) {
  return option.setName(name).setDescription(komutlar[command].secenekler[name]);
}

/** Replies (or edits the deferred reply) with a success embed. */
export function replySuccess(interaction, text, { ephemeral = false } = {}) {
  return respond(interaction, { embeds: [successEmbed(text)] }, ephemeral);
}

/** Replies (or edits the deferred reply) with an error embed, ephemeral when possible. */
export function replyError(interaction, text) {
  return respond(interaction, { embeds: [errorEmbed(text)] }, true);
}

/** Sends a response whether or not the interaction was already deferred/replied. */
export function respond(interaction, payload, ephemeral = false) {
  const flags = ephemeral ? MessageFlags.Ephemeral : undefined;
  if (interaction.deferred && !interaction.replied) return interaction.editReply(payload);
  if (interaction.replied) return interaction.followUp({ ...payload, flags });
  return interaction.reply({ ...payload, flags });
}

/** "Playing now" / "Added to queue" embed for the result of MusicService.enqueue / play. */
export function addedEmbed(result) {
  const embed = baseEmbed();
  if (result.kind === 'playlist') {
    const name = escapeMarkdown(truncate(result.playlistName ?? ekleme.varsayilanListeAdi, 100));
    embed.setTitle(ekleme.listeEklendi).setDescription(ekleme.listeAciklamasi(name, result.tracks.length));
  } else {
    const track = result.tracks[0];
    embed
      .setTitle(result.queuePosition === 0 ? ekleme.calmayaBasliyor : ekleme.kuyrugaEklendi)
      .setDescription(`${trackLink(track)} \`${trackDuration(track)}\``);
    if (result.queuePosition > 0) embed.setFooter({ text: ekleme.kuyruktakiSirasi(result.queuePosition) });
    if (track.artworkUrl) embed.setThumbnail(track.artworkUrl);
  }
  const notes = [];
  if (result.skippedForLimit > 0) notes.push(ekleme.sinirYuzundenEklenmedi(result.skippedForLimit));
  if (result.skippedUnsupported > 0) notes.push(ekleme.desteklenmeyenAtlandi(result.skippedUnsupported));
  if (notes.length) embed.addFields({ name: ekleme.notBasligi, value: notes.join('\n') });
  return embed;
}
