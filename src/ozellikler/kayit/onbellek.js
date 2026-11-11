// Kayıt kanalı için mesaj içerik önbelleği. Silinen ya da düzenlenen bir mesajın eski içeriği Discord'dan
// sonradan alınamaz; bu yüzden kayıt açıkken gelen mesajların kısa bir kopyası YALNIZ BELLEKTE tutulur:
//   kanal başına en fazla son 500 mesaj, her mesaj en fazla 24 saat, toplamda en fazla 20 000 mesaj.
// Diske hiçbir şey yazılmaz; bot kapanınca önbellek silinir. Ekler yalnız ad ve boyut olarak saklanır.
// Normalde bu dosyaya dokunmana gerek yok.

export const KANAL_BASINA = 500;
export const SURE_MS = 24 * 60 * 60 * 1000;
export const TOPLAM_EN_FAZLA = 20_000;
/** Longer contents are cut (Discord allows 4000 characters with Nitro; the card shows less anyway). */
export const ICERIK_EN_FAZLA = 2000;
const EK_EN_FAZLA = 10;

/** The part of a discord.js Message the cache keeps. */
export function snapshotOf(message, now) {
  const attachments = [...(message.attachments?.values?.() ?? [])].slice(0, EK_EN_FAZLA).map((a) => ({
    ad: String(a.name ?? 'dosya').slice(0, 100),
    boyut: Number.isFinite(a.size) ? a.size : 0,
  }));
  return {
    id: message.id,
    kanalId: message.channelId,
    yazarId: message.author?.id ?? null,
    yazarEtiket: message.author?.tag ?? message.author?.username ?? null,
    icerik: String(message.content ?? '').slice(0, ICERIK_EN_FAZLA),
    ekler: attachments,
    zaman: Number.isFinite(message.createdTimestamp) ? message.createdTimestamp : now,
    eklendi: now,
  };
}

/**
 * @param {{ now?: () => number, kanalBasina?: number, sureMs?: number, toplam?: number }} [options]
 */
export function createMessageCache({
  now = () => Date.now(),
  kanalBasina = KANAL_BASINA,
  sureMs = SURE_MS,
  toplam = TOPLAM_EN_FAZLA,
} = {}) {
  /** channel id -> Map(message id -> snapshot), oldest first (Map keeps insertion order) */
  const channels = new Map();
  let size = 0;

  function drop(channelId, messageId) {
    const list = channels.get(channelId);
    if (!list?.delete(messageId)) return;
    size -= 1;
    if (!list.size) channels.delete(channelId);
  }

  /** Removes what is older than the time limit, then the oldest entries while over the total limit. */
  function prune() {
    const limit = now() - sureMs;
    for (const [channelId, list] of channels) {
      for (const [id, entry] of list) {
        if (entry.eklendi > limit) break;
        drop(channelId, id);
      }
    }
    while (size > toplam) {
      let oldest = null;
      for (const [channelId, list] of channels) {
        const [id, entry] = list.entries().next().value;
        if (!oldest || entry.eklendi < oldest.entry.eklendi) oldest = { channelId, id, entry };
      }
      drop(oldest.channelId, oldest.id);
    }
  }

  return {
    /** Keeps a copy of a message (an edited message replaces its older copy). */
    ekle(message) {
      const entry = snapshotOf(message, now());
      const list = channels.get(entry.kanalId) ?? channels.set(entry.kanalId, new Map()).get(entry.kanalId);
      const old = list.get(entry.id);
      if (old) {
        // An edit: same place and same age, so a message is never kept longer than the time limit.
        list.set(entry.id, { ...entry, eklendi: old.eklendi });
        prune();
        return list.get(entry.id) ?? null;
      }
      list.set(entry.id, entry);
      size += 1;
      while (list.size > kanalBasina) drop(entry.kanalId, list.keys().next().value);
      prune();
      return entry;
    },

    /** The copy of a message, or null when it is not (or no longer) kept. */
    al(channelId, messageId) {
      prune();
      return channels.get(channelId)?.get(messageId) ?? null;
    },

    /** The copy, removed from the cache (for a deleted message). */
    cikar(channelId, messageId) {
      const entry = this.al(channelId, messageId);
      if (entry) drop(channelId, messageId);
      return entry;
    },

    /** Forgets every message of a channel (e.g. it became the log channel). */
    kanaliUnut(channelId) {
      size -= channels.get(channelId)?.size ?? 0;
      channels.delete(channelId);
    },

    get boyut() {
      prune();
      return size;
    },

    temizle() {
      channels.clear();
      size = 0;
    },
  };
}
