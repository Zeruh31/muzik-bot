// Mesaj kutularının (embed) ortak kalıpları. Renkler: .env > EMBED_COLOR ve src/gorunum.js.

import { EmbedBuilder } from 'discord.js';
import { renkler } from '../gorunum.js';
import { etiketler } from '../mesajlar.js';
import { escapeMarkdown, formatDuration, truncate } from './format.js';

let embedColor = 0x5865f2;

/** Called once at startup with the configured color. */
export function setEmbedColor(color) {
  embedColor = color;
}

export function baseEmbed() {
  return new EmbedBuilder().setColor(embedColor);
}

export function successEmbed(text) {
  return baseEmbed().setDescription(`✅ ${text}`);
}

export function errorEmbed(text) {
  return new EmbedBuilder().setColor(renkler.hata).setDescription(`❌ ${text}`);
}

/** "[Title](url)" with markdown escaped and length capped. */
export function trackLink(track, max = 80) {
  const title = escapeMarkdown(truncate(track.title, max));
  return track.uri ? `[${title}](${track.uri})` : title;
}

export function trackDuration(track) {
  return track.isStream ? etiketler.canli : formatDuration(track.duration);
}

export function requesterMention(track) {
  return track.requester?.id ? `<@${track.requester.id}>` : etiketler.bilinmiyor;
}
