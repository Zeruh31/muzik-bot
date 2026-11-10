// Bot sahibini bulur (/servers gibi yalnızca sahibe açık komutlar için).
// Sahip, Discord Developer Portal'daki uygulama sahibidir; uygulama bir takıma aitse takımın
// sahibi ve "Admin" rolündeki üyeleri sayılır. .env içinde BOT_OWNER_IDS doluysa yalnızca
// oradaki kimlikler sahip sayılır.

import { TeamMemberRole } from 'discord.js';

const CACHE_MS = 10 * 60_000;

/** Owner ids from a fetched ClientApplication (user owner or team). */
export function ownerIdsOf(application) {
  const owner = application?.owner;
  if (!owner) return [];
  if (!owner.members) return [owner.id]; // a single user
  const ids = new Set(owner.ownerId ? [owner.ownerId] : []);
  for (const member of owner.members.values()) {
    if (member.role === TeamMemberRole.Admin) ids.add(member.id ?? member.user?.id);
  }
  return [...ids].filter(Boolean);
}

/** Creates isOwner(userId) → Promise<boolean>. The application is fetched lazily and cached. */
export function createOwnerCheck({ client, overrideIds = [], logger }) {
  let cached = null;
  let cachedAt = 0;

  async function ownerIds() {
    if (overrideIds.length) return overrideIds;
    if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
    try {
      cached = ownerIdsOf(await client.application.fetch());
      cachedAt = Date.now();
    } catch (error) {
      logger?.warn('Bot sahibi öğrenilemedi:', error?.message ?? error);
      return cached ?? [];
    }
    return cached;
  }

  return async (userId) => (await ownerIds()).includes(userId);
}
