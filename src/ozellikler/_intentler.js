// Hangi gateway intent'lerinin açılacağına modüllere bakarak karar verir. Müzik için Guilds ve
// GuildVoiceStates her zaman açıktır; diğerlerini yalnız onları isteyen bir modül varsa açar.
// Ayrıcalıklı (privileged) bir intent Developer Portal'da kapalıysa bot çökmez: o intent olmadan
// yeniden bağlanır, onu isteyen özellikleri kapatır ve konsola Türkçe açıklama yazar.
// Normalde bu dosyaya dokunmana gerek yok.

import { GatewayIntentBits, Partials } from 'discord.js';
import { konsol } from './_mesajlar.js';

/** Needed by music (voice) and by every slash command. */
export const BASE_INTENTS = Object.freeze(['Guilds', 'GuildVoiceStates']);
/** Intents Discord only gives when they are switched on in the Developer Portal. */
export const PRIVILEGED_INTENTS = new Set(['GuildMembers', 'GuildPresences', 'MessageContent']);

/**
 * Collects the intents (and partials) of the enabled modules.
 * @param {Iterable<object>} modules module definitions (each may list `intentler`, `istegeBagliIntentler`, `partials`)
 * @param {{ allowPrivileged?: boolean|'zorunlu' }} [options] false: modules needing a privileged intent are
 *   turned off instead (used after Discord refused them); 'zorunlu': only the privileged intents some module
 *   cannot work without are asked for, optional ones are left out
 * @returns {{ names: string[], intents: number[], privileged: string[], optionalPrivileged: string[],
 *   partials: number[], disabled: Map<string, string[]> }}
 */
export function planIntents(modules, { allowPrivileged = true } = {}) {
  const names = new Set(BASE_INTENTS);
  const partials = new Set();
  const disabled = new Map();
  const required = new Set();
  const check = (module, name) => {
    if (!Object.hasOwn(GatewayIntentBits, name) || typeof GatewayIntentBits[name] !== 'number') {
      throw new Error(`src/ozellikler/${module.ad}: bilinmeyen intent "${name}".`);
    }
  };
  const optional = [];
  for (const module of modules) {
    const wanted = module.intentler ?? [];
    for (const name of [...wanted, ...(module.istegeBagliIntentler ?? [])]) check(module, name);
    for (const name of module.partials ?? []) {
      if (!Object.hasOwn(Partials, name) || typeof Partials[name] !== 'number') {
        throw new Error(`src/ozellikler/${module.ad}: bilinmeyen partial "${name}".`);
      }
    }
    const privileged = wanted.filter((name) => PRIVILEGED_INTENTS.has(name));
    if (allowPrivileged === false && privileged.length) {
      disabled.set(module.ad, privileged);
      continue;
    }
    for (const name of wanted) names.add(name);
    for (const name of privileged) required.add(name);
    for (const name of module.partials ?? []) partials.add(Partials[name]);
    optional.push(...(module.istegeBagliIntentler ?? []));
  }
  // Optional intents: a module works without them (it switches off what needs them).
  for (const name of optional) {
    if (!PRIVILEGED_INTENTS.has(name) || allowPrivileged === true) names.add(name);
  }
  const list = [...names];
  const privileged = list.filter((name) => PRIVILEGED_INTENTS.has(name));
  return {
    names: list,
    intents: list.map((name) => GatewayIntentBits[name]),
    privileged,
    optionalPrivileged: privileged.filter((name) => !required.has(name)),
    partials: [...partials],
    disabled,
  };
}

/** True for the login error Discord's gateway gives when a privileged intent is not switched on (4014). */
export function isDisallowedIntentsError(error) {
  return /disallowed intents|4014/i.test(`${error?.code ?? ''} ${error?.message ?? error}`);
}

/**
 * Starts the bot and logs in. When Discord refuses a privileged intent, stops what was started and starts
 * again: first without the optional privileged intents (when there are any), then without any privileged
 * intent (their features are off), and logs in once more each time.
 * @param {object} deps
 * @param {(options: { allowPrivileged: boolean|'zorunlu' }) => Promise<object>} deps.start builds the bot
 * @param {(started: object) => Promise<void>} deps.login
 * @param {(started: object) => Promise<void>} deps.stop closes a started bot
 * @param {(started: object) => { privileged: string[], optionalPrivileged?: string[] }} deps.planOf the intent
 *   plan of a started bot
 * @param {(started: object) => void} [deps.onStart] told about every started bot (for cleanup on errors)
 * @returns {Promise<object>} the started bot that is logged in
 */
export async function startWithIntentFallback({ start, login, stop, planOf, onStart = () => {}, logger }) {
  let started = await start({ allowPrivileged: true });
  onStart(started);
  const levels = ['zorunlu', false];
  for (;;) {
    try {
      await login(started);
      return started;
    } catch (error) {
      const plan = planOf(started);
      if (!isDisallowedIntentsError(error) || !plan.privileged.length || !levels.length) throw error;
      // Skip the "required only" level when it would ask for the same intents again.
      if (levels[0] === 'zorunlu' && !plan.optionalPrivileged?.length) levels.shift();
      const level = levels.shift();
      await stop(started);
      started = await start({ allowPrivileged: level });
      onStart(started);
      const next = planOf(started);
      const off = [...next.disabled.keys()];
      const dropped = plan.privileged.filter((name) => !next.privileged.includes(name));
      logger?.error(konsol.intentReddedildi(dropped.join(', ') || plan.privileged.join(', '), off.join(', ') || '-'));
    }
  }
}
