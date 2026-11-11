// Botun üyelere rol verip alması (seviye rolleri, otomatik rol, rol menüleri). Kurallar tek yerde:
//   - Yasaklı izinli roller (FORBIDDEN_ROLE_PERMISSIONS: yönetici, yasaklama, atma, kanal/mesaj/rol yönetimi...)
//     hiçbir özellikle dağıtılamaz.
//   - Rol botun en yüksek rolünün altında olmalı.
//   - Rolü AYARLAYAN kişinin en yüksek rolünün de altında olmalı (sunucu sahibi hariç); ayarlayan hâlâ
//     sunucuda olmalı ve "Sunucuyu Yönet" iznini korumalı. Böylece bir yönetici kendisinden yüksek bir rolü
//     bir seviyeye ya da otomatik role bağlayıp dolaylı yoldan alamaz.
// Bunlar hem ayarlanırken (ayarlar/sema.js, /seviye rol) hem de rol verilmeden hemen önce yeniden
// denetlenir. Rol ALINIRKEN yalnız botun hiyerarşisi yeter ("yalnız en yüksek" ve sıfırlama alttaki ya da
// sonradan tehlikeli olan rolleri alabilsin). Başka modüller (rol menüsü...) aynı API'yi kullanır: rolü
// { rol, kim } olarak saklar, changeRoles'a setterOf ile kim'i verir. Verilemeyen rol atlanır ve konsola (saatte en çok bir kez) yazılır; bot hiçbir durumda çökmez.
// Normalde bu dosyaya dokunmana gerek yok.

import { PermissionFlagsBits } from 'discord.js';
import { memberRoleIds } from '../bot/dj.js';
import { izinAdlari, ortak } from './_mesajlar.js';

/** A role with any of these can never be handed out by a feature (level roles, auto roles, role menus). */
export const FORBIDDEN_ROLE_PERMISSIONS = Object.freeze(
  Object.keys(izinAdlari).map((name) => PermissionFlagsBits[name]),
);
const WARN_EVERY_MS = 60 * 60 * 1000;

/** Whether a role (a Role, or a raw role with a permissions bit string) has a permission itself. */
function roleHas(role, flag) {
  const { permissions } = role ?? {};
  if (typeof permissions?.has === 'function') return permissions.has(flag, false);
  try {
    return (BigInt(permissions ?? 0) & flag) === flag;
  } catch {
    return false;
  }
}

/** True when the role has one of FORBIDDEN_ROLE_PERMISSIONS. */
export const hasForbiddenPermission = (role) => FORBIDDEN_ROLE_PERMISSIONS.some((flag) => roleHas(role, flag));

/** The Turkish (Discord client) names of the forbidden permissions the role actually has. */
export const forbiddenPermissionNames = (role) =>
  Object.keys(izinAdlari)
    .filter((name) => roleHas(role, PermissionFlagsBits[name]))
    .map((name) => izinAdlari[name]);

/** The Turkish refusal for a role with forbidden permissions; `kim` starts the sentence ("<@&1> rolünde", "Rolde"). */
export const forbiddenPermissionText = (role, kim) => ortak.rolTehlikeli(kim, forbiddenPermissionNames(role));

/**
 * The position of a member's highest role: a GuildMember (roles.highest) or the raw member of an
 * interaction (an array of role ids, looked up in the guild).
 */
export function highestPosition(guild, member) {
  const highest = member?.roles?.highest;
  if (highest) return Number(highest.position);
  let top = 0;
  for (const id of memberRoleIds(member)) top = Math.max(top, Number(guild?.roles?.cache?.get(id)?.position ?? 0));
  return top;
}

/**
 * The Turkish reason the setter may not hand out a role, or null. The guild owner may hand out any role
 * (below the bot); everyone else only roles below their own highest role.
 */
export function setterRefusal(guild, role, setter) {
  if (!setter) return 'rolü ayarlayan kişi bulunamadı (ayarı yeniden yapın)';
  const setterId = setter.id ?? setter.user?.id;
  if (guild?.ownerId && setterId === guild.ownerId) return null;
  if (Number(role.position) >= highestPosition(guild, setter)) {
    return 'rol, onu ayarlayan kişinin en yüksek rolünden aşağıda değil';
  }
  return null;
}

/**
 * Why a role cannot be handled now, from what is known: `setter` is the setter's member, null when they are
 * not in the server, undefined when not looked up (then the setter part is skipped).
 */
function refusal(guild, roleId, { setterId, setter, forRemoval }) {
  const me = guild?.members?.me;
  if (!me) return 'bot üyesi bulunamadı';
  if (me.permissions && !me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'botun "Rolleri Yönet" izni yok';
  const role = guild.roles?.cache?.get(roleId);
  if (!role) return 'rol silinmiş';
  if (role.id === guild.id) return '@everyone verilemez';
  if (role.managed) return 'rol bir bota ya da sunucu takviyesine ait';
  const highest = me.roles?.highest;
  if (highest && Number(role.position) >= Number(highest.position)) {
    return "rol, botun rolünden yukarıda (Sunucu Ayarları > Roller'de bot rolünü üste sürükleyin)";
  }
  // Taking a role away only needs the bot's own hierarchy: an unsafe role must still be removable.
  if (forRemoval) return null;
  if (hasForbiddenPermission(role)) return forbiddenPermissionText(role, `<@&${role.id}> rolünde`);
  if (setter === undefined) return null;
  if (!setterId) return setterRefusal(guild, role, null);
  if (guild.ownerId && setterId === guild.ownerId) return null;
  if (!setter) return 'rolü ayarlayan kişi artık sunucuda değil (ayarı yeniden yapın)';
  if (setter.permissions && !setter.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return 'rolü ayarlayan kişinin artık "Sunucuyu Yönet" izni yok (ayarı yeniden yapın)';
  }
  return setterRefusal(guild, role, setter);
}

/**
 * The Turkish reason a role cannot be given (or taken) now, or null when it can. For any feature that hands
 * out roles it stored as { rol, kim }: pass `kim` as setterId.
 * @param {object} guild
 * @param {string} roleId
 * @param {{ setterId?: string|null, checkSetter?: boolean, forRemoval?: boolean }} [options]
 *   checkSetter (default true): a missing or departed setter, or one who lost "Sunucuyu Yönet", refuses it;
 *   forRemoval: only the bot's own hierarchy matters (no setter or forbidden-permission check)
 */
export async function whyNotAssignable(
  guild,
  roleId,
  { setterId = null, checkSetter = true, forRemoval = false } = {},
) {
  let setter;
  if (checkSetter && !forRemoval) {
    setter =
      setterId && setterId !== guild?.ownerId
        ? (guild?.members?.cache?.get(setterId) ?? (await guild?.members?.fetch?.(setterId).catch(() => null)) ?? null)
        : null;
  }
  return refusal(guild, roleId, { setterId, setter, forRemoval });
}

/**
 * Like whyNotAssignable for giving, without API calls (for menus drawn synchronously): a setter who is not
 * in the member cache is not judged.
 */
export function whyNotAssignableCached(guild, roleId, { setterId = null } = {}) {
  const setter = !setterId || setterId === guild?.ownerId ? null : (guild?.members?.cache?.get(setterId) ?? undefined);
  return refusal(guild, roleId, { setterId, setter, forRemoval: false });
}

/**
 * Why the bot itself cannot give a role now (its permission and hierarchy, @everyone, managed or forbidden
 * permissions), without the setter check and without API calls; null when it can. For the desktop app's role lists.
 */
export const botRefusal = (guild, roleId) =>
  refusal(guild, roleId, { setterId: null, setter: undefined, forRemoval: false });

/** A logger that says the same thing at most once an hour per key. */
export function createThrottledWarn(logger, { now = Date.now, everyMs = WARN_EVERY_MS } = {}) {
  const last = new Map();
  return (key, text) => {
    const at = now();
    if (at - (last.get(key) ?? -Infinity) < everyMs) return;
    last.set(key, at);
    if (last.size > 1000) last.delete(last.keys().next().value);
    logger?.warn?.(text);
  };
}

/**
 * Gives `add` and takes `remove` (role ids) in at most two API calls; roles that cannot be handled are skipped.
 * Never throws: an API error is logged.
 * @param {object} member a GuildMember
 * @param {object} options
 * @param {(roleId: string) => string|null} options.setterOf who set each role up (see whyNotAssignable)
 * @returns {Promise<{ verilen: string[], alinan: string[], atlanan: { rolId: string, neden: string }[] }>}
 */
export async function changeRoles(member, { add = [], remove = [], reason, warn = () => {}, setterOf = () => null }) {
  const result = { verilen: [], alinan: [], atlanan: [] };
  const guild = member?.guild;
  if (!guild || !member.roles) return result;
  const has = new Set(memberRoleIds(member));
  /** The ids still to change: `present` is what the member must already have (true for removing). */
  const pick = async (ids, present) => {
    const ok = [];
    for (const rolId of new Set(ids)) {
      if (has.has(rolId) !== present) continue;
      const neden = await whyNotAssignable(guild, rolId, { setterId: setterOf(rolId), forRemoval: present });
      if (neden) {
        result.atlanan.push({ rolId, neden });
        warn(`${guild.id}:${rolId}`, `Rol işlenemedi (sunucu ${guild.id}, rol ${rolId}): ${neden}`);
      } else ok.push(rolId);
    }
    return ok;
  };
  const toAdd = await pick(add, false);
  const toRemove = (await pick(remove, true)).filter((id) => !toAdd.includes(id));
  if (toAdd.length) {
    try {
      await member.roles.add(toAdd, reason);
      result.verilen = toAdd;
    } catch (error) {
      warn(`${guild.id}:add`, `Rol verilemedi (sunucu ${guild.id}): ${error?.message ?? error}`);
    }
  }
  if (toRemove.length) {
    try {
      await member.roles.remove(toRemove, reason);
      result.alinan = toRemove;
    } catch (error) {
      warn(`${guild.id}:remove`, `Rol alınamadı (sunucu ${guild.id}): ${error?.message ?? error}`);
    }
  }
  return result;
}
