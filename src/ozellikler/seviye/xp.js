// XP kuralları (MEE6 ile aynı):
//   - L. seviyeden L+1'e geçmek için 5·L² + 50·L + 100 XP gerekir (1. seviye 100, 2. seviye toplam 255 XP...).
//   - Mesaj başına rastgele 15-25 XP; aynı kişi 60 saniyede en çok bir kez XP alır.
//   - Ses: dakikada bir 15-25 XP. Kanalda "sayılan" en az 2 kişi olmalı: bot olmayan, sağırlaştırılmamış,
//     susturulmamış (kendini ya da sunucu tarafından) ve XP almayan rolde olmayan kişiler. Böylece iki hesapla
//     (biri susturulmuş, biri hariç rolde) XP kasmak zorlaşır. Kendini susturan kişi yine de XP alır
//     (konuşmadan dinleyenler de katılımcıdır), yalnız sayıma girmez. Sağırlaştıran, AFK kanalındaki,
//     XP almayan kanal ya da roldeki kişi XP almaz.
// Bu dosyadaki işlevler saf (Discord'a dokunmaz); testler doğrudan bunları dener.

import { cryptoRandom } from '../_rastgele.js';

export const XP_EN_AZ = 15;
export const XP_EN_FAZLA = 25;
export const MESAJ_BEKLEME_MS = 60_000;
export const SES_ARALIK_MS = 60_000;
export const SES_EN_AZ_KISI = 2;
/** A level far beyond reach; keeps every loop bounded (level 1000 needs about 1.7 billion XP). */
export const MAX_SEVIYE = 1000;
/** /seviye ver and /seviye al move at most this much at once; total XP never goes above MAX_XP. */
export const MAX_ISLEM_XP = 10_000_000;
export const MAX_XP = 2_000_000_000;

/** XP needed to go from `level` to `level + 1`. */
export const xpForLevel = (level) => 5 * level * level + 50 * level + 100;

/** Total XP at which `level` is reached (0 for level 0). */
export function totalXpForLevel(level) {
  const l = Math.max(0, Math.min(MAX_SEVIYE, Math.floor(level)));
  // Sum of 5i² + 50i + 100 for i = 0..l-1
  return (5 * (l - 1) * l * (2 * l - 1)) / 6 + 25 * l * (l - 1) + 100 * l;
}

/** The level a total XP gives. */
export function levelForXp(xp) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  let level = 0;
  while (level < MAX_SEVIYE && totalXpForLevel(level + 1) <= total) level += 1;
  return level;
}

/** { seviye, buSeviyede, gereken, toplamXp } for a card: progress inside the current level. */
export function progressOf(xp) {
  const toplamXp = Math.max(0, Math.floor(Number(xp) || 0));
  const seviye = levelForXp(toplamXp);
  return { seviye, buSeviyede: toplamXp - totalXpForLevel(seviye), gereken: xpForLevel(seviye), toplamXp };
}

/** A random message (or voice minute) XP amount, 15-25 inclusive. */
export const randomXp = (random = cryptoRandom) => XP_EN_AZ + random(XP_EN_FAZLA - XP_EN_AZ + 1);

/** Whether a message at `now` earns XP after the last rewarded one at `mesajSon`. */
export const cooldownOver = (now, mesajSon, waitMs = MESAJ_BEKLEME_MS) =>
  !Number.isFinite(mesajSon) || mesajSon <= 0 || now - mesajSon >= waitMs || now < mesajSon;

/**
 * Who earns voice XP this minute in one guild.
 * @param {{ userId: string, channelId: string|null, bot?: boolean, selfDeaf?: boolean, serverDeaf?: boolean,
 *   selfMute?: boolean, serverMute?: boolean, roleIds?: string[] }[]} states the guild's voice states
 * @param {{ afkChannelId?: string|null, haricKanallar?: Iterable<string>, haricRoller?: Iterable<string> }} rules
 * @returns {string[]} user ids
 */
export function voiceEarners(states, { afkChannelId = null, haricKanallar = [], haricRoller = [] } = {}) {
  const skipChannels = new Set(haricKanallar);
  const skipRoles = new Set(haricRoller);
  /** channel id -> { earners: people who may earn, company: how many count towards the minimum } */
  const channels = new Map();
  for (const state of states) {
    if (!state.channelId || state.bot || state.selfDeaf || state.serverDeaf) continue;
    if (state.channelId === afkChannelId || skipChannels.has(state.channelId)) continue;
    if ((state.roleIds ?? []).some((id) => skipRoles.has(id))) continue;
    const entry =
      channels.get(state.channelId) ?? channels.set(state.channelId, { earners: [], company: 0 }).get(state.channelId);
    entry.earners.push(state.userId);
    if (!state.selfMute && !state.serverMute) entry.company += 1;
  }
  const earners = [];
  for (const entry of channels.values()) if (entry.company >= SES_EN_AZ_KISI) earners.push(...entry.earners);
  return earners;
}

/**
 * Which level roles a member should have and which to take away.
 * @param {Record<string|number, string>|Map<number, string>} mapping level -> role id
 * @param {number} level the member's level
 * @param {{ yalnizEnYuksek?: boolean }} options true: only the highest reached role, the lower ones go
 * @returns {{ ver: string[], al: string[] }} roles to have / roles to remove (only mapped roles are touched)
 */
export function levelRoles(mapping, level, { yalnizEnYuksek = false } = {}) {
  const entries = (mapping instanceof Map ? [...mapping] : Object.entries(mapping ?? {}))
    .map(([l, roleId]) => [Number(l), roleId])
    .filter(([l]) => Number.isInteger(l))
    .sort((a, b) => a[0] - b[0]);
  const reached = entries.filter(([l]) => l <= level).map(([, roleId]) => roleId);
  const ver = yalnizEnYuksek ? reached.slice(-1) : reached;
  const keep = new Set(ver);
  const al = [...new Set(entries.map(([, roleId]) => roleId).filter((roleId) => !keep.has(roleId)))];
  return { ver: [...new Set(ver)], al };
}
