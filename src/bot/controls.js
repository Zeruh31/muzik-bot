// "Şimdi çalıyor" mesajındaki kontrol düğmeleri: önceki, duraklat/devam, atla, durdur, döngü, karıştır.
// Düğmeler eğik çizgi komutlarıyla aynı kurallara uyar: botla aynı ses kanalında olmak ve
// (sunucuda ayarlıysa) DJ rolü (src/bot/dj.js). Yetkisi olmayana yalnız onun göreceği kısa bir uyarı gider.
// Düğme yazıları src/mesajlar.js > kontrol bölümünde. Normalde bu dosyaya dokunmana gerek yok.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { genel, kontrol } from '../mesajlar.js';
import { MusicError, translateLavalinkError } from '../music/errors.js';
import { nextRepeatMode } from '../music/MusicService.js';
import { requireSameVoice } from '../util/voice.js';
import { missingDjRole } from './dj.js';

/** Every control button's customId starts with this; other components use other prefixes. */
export const CONTROL_PREFIX = 'muzikbot-kontrol:';

/** Button action -> the slash command whose DJ rule it follows. */
export const CONTROL_ACTIONS = Object.freeze({
  previous: 'previous',
  toggle: 'pause',
  skip: 'skip',
  stop: 'stop',
  loop: 'loop',
  shuffle: 'shuffle',
});

const LOOP_EMOJI = { off: '🔁', track: '🔂', queue: '🔁' };

export { nextRepeatMode };

export const controlId = (action) => `${CONTROL_PREFIX}${action}`;

/** The action of a control button's customId, or null for any other component. */
export function controlAction(customId) {
  if (typeof customId !== 'string' || !customId.startsWith(CONTROL_PREFIX)) return null;
  const action = customId.slice(CONTROL_PREFIX.length);
  return Object.hasOwn(CONTROL_ACTIONS, action) ? action : null;
}

/** What the buttons show; the message is only edited when this changes. */
export function controlSignature(state) {
  if (!state?.current) return 'yok';
  return [state.paused, state.repeatMode, state.hasPrevious, state.queue.length >= 2].join('|');
}

/**
 * Two rows of buttons for a getState() snapshot (Discord allows 5 buttons per row).
 * `idOf` gives each button's customId; the control center (src/ozellikler/muzik) uses its own ids.
 */
export function controlRows(state, { disabled = false, idOf = controlId } = {}) {
  const off = (flag) => disabled || flag;
  const button = (action, emoji, label, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(idOf(action)).setEmoji(emoji).setLabel(label).setStyle(style);
  const L = kontrol.dugmeler;
  const repeat = state?.repeatMode ?? 'off';
  return [
    new ActionRowBuilder().addComponents(
      button('previous', '⏮️', L.previous).setDisabled(off(!state?.hasPrevious)),
      state?.paused
        ? button('toggle', '▶️', L.resume, ButtonStyle.Success).setDisabled(off(false))
        : button('toggle', '⏸️', L.pause, ButtonStyle.Primary).setDisabled(off(false)),
      button('skip', '⏭️', L.skip).setDisabled(off(false)),
      button('stop', '⏹️', L.stop, ButtonStyle.Danger).setDisabled(off(false)),
    ),
    new ActionRowBuilder().addComponents(
      button(
        'loop',
        LOOP_EMOJI[repeat] ?? '🔁',
        L.loop,
        repeat === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success,
      ).setDisabled(off(false)),
      button('shuffle', '🔀', L.shuffle).setDisabled(off((state?.queue?.length ?? 0) < 2)),
    ),
  ];
}

/** Runs one control action through MusicService (the same operations as the slash commands). */
export async function runControl(music, guildId, action) {
  switch (action) {
    case 'previous':
      return music.previous(guildId);
    case 'toggle':
      // Decided in the player's operation chain: quick presses alternate, never a "zaten" warning.
      return music.togglePause(guildId);
    case 'skip':
      return music.skip(guildId);
    case 'stop':
      return music.stop(guildId);
    case 'loop':
      return music.cycleRepeatMode(guildId); // one step per press
    case 'shuffle':
      return music.shuffle(guildId);
    default:
      return null;
  }
}

const warn = (interaction, text) =>
  interaction.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

/**
 * Handles a click on a control button. Checks, in order: the message is the current
 * "now playing" one, the clicker is in the bot's voice channel, the DJ rule. A refused click
 * gets a short ephemeral warning; an allowed one is acknowledged silently and the message is
 * refreshed by the announcer when the state changes.
 * @returns {Promise<'stale'|'denied'|'done'|'failed'|null>} null when it was not a control button
 */
export async function handleControlButton(interaction, context) {
  const action = controlAction(interaction.customId);
  if (!action) return null;
  const { nowPlaying } = context;
  const guildId = interaction.guildId;

  if (!guildId || (nowPlaying && !nowPlaying.isCurrent(guildId, interaction.message?.id))) {
    await warn(interaction, kontrol.eskiPanel).catch(() => {});
    await interaction.message?.edit({ components: [] }).catch(() => {});
    return 'stale';
  }
  return runCheckedControl(interaction, context, action);
}

/**
 * The checks and the action of a control button, without the "is this the live message" check:
 * the clicker must be in the bot's voice channel and pass the DJ rule. Also used by the control
 * center's buttons (/menu and the fixed panel).
 * @returns {Promise<'denied'|'done'|'failed'>}
 */
export async function runCheckedControl(interaction, context, action) {
  const { music, logger } = context;
  const guildId = interaction.guildId;
  try {
    requireSameVoice(interaction, music);
  } catch (error) {
    if (!(error instanceof MusicError)) throw error;
    await warn(interaction, error.message).catch(() => {});
    return 'denied';
  }
  const djRoleId = missingDjRole(interaction, context, CONTROL_ACTIONS[action]);
  if (djRoleId) {
    await warn(interaction, genel.djGerekli(djRoleId)).catch(() => {});
    return 'denied';
  }

  // Acknowledge first: starting the next track can take longer than Discord's 3 seconds.
  await interaction.deferUpdate().catch(() => {});
  try {
    await runControl(music, guildId, action);
    return 'done';
  } catch (rawError) {
    const error = translateLavalinkError(rawError);
    const text = error instanceof MusicError ? error.message : genel.beklenmeyenHata;
    if (!(error instanceof MusicError)) logger?.error(`Kontrol düğmesi (${action}) hatası:`, rawError);
    await interaction
      .followUp({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
      .catch(() => {});
    return 'failed';
  }
}
