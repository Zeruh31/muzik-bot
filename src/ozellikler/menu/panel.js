// Kalıcı "Kontrol Merkezi" paneli: "/ayar panel kanal:#..." ile bir kanala kurulan sabit mesaj.
// Mesajın kimliği data/paneller.json dosyasında tutulur; bot yeniden başlayınca aynı mesaja yeniden
// bağlanır, mesaj silinmişse aynı kanala yenisini gönderir. Çalan şarkı değişince mesaj düzenlenir;
// Discord'un hız sınırına takılmamak için en sık "/ayar menu panel-aralik" saniyede bir (varsayılan 5).
// Normalde bu dosyaya dokunmana gerek yok.

import * as nodeFs from 'node:fs';
import { RESTJSONErrorCodes } from 'discord.js';
import { readJsonOrBackup, writeJsonAtomic } from '../../util/atomicFile.js';
import { OzellikHatasi } from '../_yonlendirici.js';
import { systemClock } from '../_zamanlayici.js';
import { buildPanel } from './merkez.js';
import { panel as mesajlar } from './mesajlar.js';

export const PANEL_SCHEMA_VERSION = 1;
/** Even right after a change the panel waits this long, so a burst of events gives one edit. */
const MIN_DELAY_MS = 1000;
const DEFAULT_INTERVAL_S = 5;
const SNOWFLAKE = /^\d{17,20}$/;
/** Only these mean the panel's message or channel no longer exists (then it is re-created or forgotten). */
const GONE = new Set([RESTJSONErrorCodes.UnknownMessage, RESTJSONErrorCodes.UnknownChannel]);
/** The bot lost access for now (a permission was changed): the panel is kept and tried again later. */
const NO_ACCESS = new Set([RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions]);
const MUSIC_EVENTS = ['trackStarted', 'stateChanged', 'queueEnded', 'playerDestroyed'];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const signatureOf = (payload) => JSON.stringify(payload.components.map((c) => c.toJSON()));

/**
 * @param {object} deps
 * @param {string} deps.file data/paneller.json
 * @param {object} deps.context the bot context (client, music, ozellikler)
 * @param {(guildId: string) => number} [deps.intervalOf] seconds between edits for a guild
 */
export function createPanelService({ file, context, clock = systemClock, logger, fs = nodeFs, intervalOf }) {
  const { data, backup, error } = readJsonOrBackup(file, {}, { fs });
  if (error)
    logger?.warn(
      `Panel dosyası okunamadı (${error.message}); paneller yeniden kurulmalı. Eski dosya: ${backup ?? '-'}`,
    );
  /** guildId -> { channelId, messageId } */
  let entries = new Map();
  for (const [guildId, raw] of Object.entries(isPlainObject(data.paneller) ? data.paneller : {})) {
    if (SNOWFLAKE.test(guildId) && SNOWFLAKE.test(String(raw?.channelId)) && SNOWFLAKE.test(String(raw?.messageId))) {
      entries.set(guildId, { channelId: raw.channelId, messageId: raw.messageId });
    }
  }
  /** guildId -> { message, signature, lastEdit, timer } while connected */
  const live = new Map();
  const unsubscribe = [];
  let stopped = false;

  function save(next) {
    const paneller = Object.create(null);
    for (const [guildId, entry] of next) paneller[guildId] = entry;
    writeJsonAtomic(file, { schemaVersion: PANEL_SCHEMA_VERSION, paneller }, { fs });
    entries = next;
  }

  function setEntry(guildId, entry) {
    const next = new Map(entries);
    if (entry) next.set(guildId, entry);
    else next.delete(guildId);
    save(next);
  }

  const render = (guildId) => buildPanel(context, guildId, context.client.guilds?.cache?.get(guildId) ?? null);

  async function fetchChannel(channelId) {
    try {
      return await context.client.channels.fetch(channelId);
    } catch (fetchError) {
      if (fetchError?.code === RESTJSONErrorCodes.UnknownChannel) return null;
      throw fetchError;
    }
  }

  /** A stored panel message, or null when it (or its channel) is gone. Never throws. */
  async function fetchMessage(entry) {
    const channel = await fetchChannel(entry.channelId).catch(() => null);
    return (await channel?.messages?.fetch(entry.messageId).catch(() => null)) ?? null;
  }

  async function send(guildId, channel) {
    const payload = render(guildId);
    const message = await channel.send(payload);
    live.set(guildId, { message, signature: signatureOf(payload), lastEdit: clock.now(), timer: null });
    setEntry(guildId, { channelId: channel.id, messageId: message.id });
    return message;
  }

  /** Connects to the stored message of one guild, or sends a new one when it was deleted. */
  async function attach(guildId) {
    const entry = entries.get(guildId);
    if (!entry) return 'yok';
    let channel;
    try {
      channel = await fetchChannel(entry.channelId);
    } catch (fetchError) {
      if (!NO_ACCESS.has(fetchError?.code)) throw fetchError;
      logger?.warn(`Panel kanalına erişemiyorum (${guildId}); kanal izinlerini kontrol edin. Panel kaydı korunuyor.`);
      return 'erisim-yok';
    }
    if (!channel?.messages) {
      setEntry(guildId, null); // the channel is gone: nothing to show the panel in
      logger?.warn(`Panel kanalı bulunamadı (${guildId}); panel kaldırıldı.`);
      return 'kanal-yok';
    }
    try {
      const message = await channel.messages.fetch(entry.messageId);
      live.set(guildId, { message, signature: null, lastEdit: 0, timer: null });
      await refresh(guildId);
      return 'baglandi';
    } catch (fetchError) {
      if (NO_ACCESS.has(fetchError?.code)) {
        logger?.warn(
          `Panel mesajını okuyamıyorum (${guildId}): "Mesaj Geçmişini Oku" izni gerekli. Panel kaydı korunuyor.`,
        );
        return 'erisim-yok';
      }
      if (fetchError?.code !== RESTJSONErrorCodes.UnknownMessage) throw fetchError;
      await send(guildId, channel);
      return 'yeniden-olusturuldu';
    }
  }

  async function refresh(guildId) {
    const state = live.get(guildId);
    if (!state || stopped) return;
    state.timer = null;
    const payload = render(guildId);
    const signature = signatureOf(payload);
    if (signature === state.signature) return;
    try {
      await state.message.edit(payload);
      state.signature = signature;
      state.lastEdit = clock.now();
    } catch (editError) {
      if (!GONE.has(editError?.code)) {
        logger?.debug('Panel güncellenemedi:', editError?.message ?? editError);
        return;
      }
      live.delete(guildId);
      await attach(guildId).catch((attachError) => logger?.debug('Panel yeniden kurulamadı:', attachError?.message));
    }
  }

  function poke(guildId) {
    const state = live.get(guildId);
    if (!state || state.timer || stopped) return;
    const interval = Math.max(3, intervalOf?.(guildId) ?? DEFAULT_INTERVAL_S) * 1000;
    const delay = Math.max(MIN_DELAY_MS, state.lastEdit + interval - clock.now());
    state.timer = clock.setTimeout(() => {
      refresh(guildId).catch((refreshError) => logger?.debug('Panel güncellenemedi:', refreshError?.message));
    }, delay);
  }

  return {
    mesajlar,

    /** The channel id of a guild's panel, or null. */
    kanalOf(guildId) {
      return entries.get(guildId)?.channelId ?? null;
    },

    /** The message id of a guild's panel, or null. */
    mesajOf(guildId) {
      return entries.get(guildId)?.messageId ?? null;
    },

    /** Sets up the panel in a channel; an earlier panel of the guild is deleted. */
    async kur(guildId, channelId) {
      const channel = await fetchChannel(channelId).catch((fetchError) => {
        if (NO_ACCESS.has(fetchError?.code)) return null;
        throw fetchError;
      });
      if (!channel?.send) throw new OzellikHatasi(mesajlar.gonderilemedi(channelId));
      const old = live.get(guildId);
      const oldEntry = entries.get(guildId);
      try {
        await send(guildId, channel);
      } catch (sendError) {
        if (sendError instanceof OzellikHatasi) throw sendError;
        if (
          sendError?.code === RESTJSONErrorCodes.MissingPermissions ||
          sendError?.code === RESTJSONErrorCodes.MissingAccess
        ) {
          throw new OzellikHatasi(mesajlar.gonderilemedi(channelId));
        }
        throw sendError;
      }
      if (old) clock.clearTimeout(old.timer);
      if (oldEntry && oldEntry.messageId !== entries.get(guildId)?.messageId) {
        const message = old?.message ?? (await fetchMessage(oldEntry));
        await message?.delete().catch(() => {});
      }
    },

    /** Removes a guild's panel (the message is deleted when possible). */
    async kaldir(guildId) {
      const state = live.get(guildId);
      const entry = entries.get(guildId);
      if (state) clock.clearTimeout(state.timer);
      live.delete(guildId);
      setEntry(guildId, null);
      const message = state?.message ?? (entry ? await fetchMessage(entry) : null);
      await message?.delete().catch(() => {});
    },

    /**
     * Reconnects every stored panel (on login). Listens to the player's events from then on.
     * @returns {Promise<Record<string, string>>} guildId -> what happened (for logs and tests)
     */
    async baglan() {
      stopped = false;
      if (!unsubscribe.length && context.music?.on) {
        for (const event of MUSIC_EVENTS) {
          const listener = (guildId) => poke(guildId);
          context.music.on(event, listener);
          unsubscribe.push(() => context.music.off?.(event, listener));
        }
      }
      const results = {};
      for (const guildId of [...entries.keys()]) {
        try {
          results[guildId] = await attach(guildId);
        } catch (attachError) {
          results[guildId] = 'hata';
          logger?.warn(`Panel bağlanamadı (${guildId}):`, attachError?.message ?? attachError);
        }
      }
      return results;
    },

    /** Asks for a refresh (throttled); used after something the panel shows changed. */
    poke,

    /** Stops timers and listeners; the stored panels stay for the next start. */
    durdur() {
      stopped = true;
      for (const state of live.values()) if (state.timer) clock.clearTimeout(state.timer);
      live.clear();
      for (const off of unsubscribe.splice(0)) off();
    },
  };
}
