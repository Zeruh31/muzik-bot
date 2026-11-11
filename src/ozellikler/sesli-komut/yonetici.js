// Sesli komutun yöneticisi: hangi sunucuda dinlendiğini, işçinin ne zaman çalışacağını ve anlaşılan komutların
// müzik servisine nasıl gideceğini belirler.
//   - Dinleme yalnız özelliği açık (/ayar sesli-komut acik) ve bileşeni kurulu bir sunucuda, bot ses kanalındayken.
//     Bot o sunucuda yalnız o zaman sağır olmadan katılır (src/music/GuildPlayer.js > listening).
//   - Komutlar eğik çizgi komutlarıyla aynı kurallardan geçer: konuşan botla aynı ses kanalında olmalı, DJ rolü
//     (src/bot/dj.js) geçerli; ayrıca kişi ve sunucu başına hız sınırı.
//   - Konuşma metni hiçbir yere yazılmaz (konsol dahil); yalnız anlaşılan komutun cevabı kanala gider.
// Normalde bu dosyaya dokunmana gerek yok.

import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { DJ_COMMANDS, isAloneWithBot, isDjAllowed, memberRoleIds } from '../../bot/dj.js';
import { MusicError, translateLavalinkError } from '../../music/errors.js';
import { RateLimiter, VOLUME_MAX, VOLUME_MIN } from '../../music/MusicService.js';
import { escapeMarkdown, truncate } from '../../util/format.js';
import { createListener } from './dinleyici.js';
import { createUnknownLog, UNKNOWN_FILE } from './ogrenme.js';
import { createWorkerSupervisor, SttWorker } from './isci.js';
import { ayniNiyet, ciftKanitGerekir, degerlendir, durumKapisi, kirpikKaniti } from './kapilar.js';
import { DJ_KARSILIGI, HOTWORDS, SARKIYA_BAGLI } from './komutlar.js';
import { componentDir, componentStatus, pythonPath, WORKER_SCRIPT } from './kurulum.js';
import { bildirim, cevap, konsol, varsayilanUyandirma } from './mesajlar.js';
import { fold, levenshtein, parseCommand, wakeOf, words } from './niyet.js';
import { formatDuration } from '../../util/format.js';

export const MODUL = 'sesli-komut';
/** Per person and per server: at most this many voice commands (and "anlamadım" answers) per window. */
export const HIZ_SINIRI = Object.freeze({ windowMs: 30_000, perUser: 5, perGuild: 15 });
/** A sentence that ended longer ago than this is not acted on (it would hit a later song or a changed state). */
export const EN_ESKI_CUMLE_MS = 5000;
export { SARKIYA_BAGLI };
/** "Sesli komut açık" is said once per voice channel in this time (joins, moves, re-joins). */
export const BILDIRIM_ARALIGI_MS = 10 * 60_000;

const own = (value, fallback) => (value === undefined || value === null ? fallback : value);

/**
 * @param {object} deps
 * @param {object} deps.context the bot context (music, client, settings, ozellikler)
 * @param {{ has(guildId, userId): boolean }} deps.exclusions who excluded themselves (depo.js)
 * @param {() => { kurulu: boolean, dizin: string }} [deps.status] component check (tests pass a fake)
 * @param {(model: string) => SttWorker} [deps.createWorker]
 * @param {Function} [deps.Opus] OpusEncoder class for the listener (tests)
 */
const toModel = (choice) => (choice === 'turbo' || choice === 'small' ? choice : 'auto');

export function createSesliKomut({
  context,
  exclusions,
  status = () => componentStatus(),
  createWorker = null,
  Opus,
  logger,
  timers = globalThis,
  now = Date.now,
  supervisorOptions = {},
  unknownLog = null,
  unknownFile = UNKNOWN_FILE,
}) {
  const { music, client } = context;
  const setting = (guildId, key) => context.ozellikler?.ayarlar.get(guildId, MODUL, key);
  const enabled = (guildId) => setting(guildId, 'acik') === true;
  const wakePhrase = (guildId) => own(setting(guildId, 'uyandirma'), varsayilanUyandirma);
  // Bot-wide (one worker for every server): SESLI_KOMUT_MODEL in .env, only the bot owner changes it.
  const modelChoice = toModel(context.config?.voice?.model);

  /** guildId -> { listener, wake, textNotified } */
  const sessions = new Map();
  const starting = new Set();
  /** Guilds told "kurulu değil" / "hata" during the current player (not again until the bot leaves). */
  const told = new Set();
  const chains = new Map();
  const rate = new RateLimiter({ windowMs: HIZ_SINIRI.windowMs, now });
  const counters = { cumle: 0, komut: 0, yoksay: 0 };
  // SESLI_KOMUT_TANI=true (.env): one log line per sentence, the recognised text included. Only for debugging.
  const diagnose = Boolean(context.config?.voice?.tani);
  // Diagnosis mode only: sentences with a wake phrase but no command, for adding patterns (ogrenme.js).
  const unknown = diagnose ? (unknownLog ?? createUnknownLog({ file: unknownFile, logger })) : null;
  // Diagnosis mode off: what an earlier diagnosis session collected is not kept.
  if (!diagnose) {
    try {
      rmSync(unknownFile, { force: true });
    } catch (error) {
      logger?.warn(`Eski anlaşılmayan sesli komut dosyası silinemedi: ${error?.message ?? error}`);
    }
  }
  /** Low-detail counters logged once a minute while listening (no text): proof of life and why sentences fail. */
  let minute = { ses: 0, cumle: 0, sonuc: {}, atlanan: {} };
  /** "guildId:channelId" -> when "Sesli komut açık" was last said there */
  const announced = new Map();
  /** guildId -> when the playing song last changed (a command must not act on a song started after it was said) */
  const trackChangedAt = new Map();

  const makeWorker =
    createWorker ??
    ((model) => {
      const dir = componentDir();
      return new SttWorker({ python: pythonPath(dir), script: WORKER_SCRIPT, dir, model });
    });

  const supervisor = createWorkerSupervisor({
    createWorker: () => makeWorker(modelChoice),
    onMessage: (message) => onWorkerMessage(message),
    onReady: (worker) => {
      worker.send({ t: 'config', hotwords: HOTWORDS });
      for (const [guildId, session] of sessions) worker.send({ t: 'guild', g: guildId, wake: session.wakeText });
    },
    onChange: (state) => {
      context.status?.poke?.();
      if (state.durum !== 'hata') return;
      for (const guildId of sessions.keys()) tellOnce(guildId, bildirim.hata);
    },
    logger,
    timers,
    now,
    ...supervisorOptions,
  });

  function textChannelOf(guildId) {
    const id = music.getPlayer(guildId)?.textChannelId;
    return id ? client.channels?.cache?.get(id) : null;
  }

  async function say(guildId, content, channel = textChannelOf(guildId)) {
    if (!channel?.send) return;
    await channel
      .send({ content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds })
      .catch((error) => logger?.debug(`Sesli komut cevabı gönderilemedi: ${error?.message}`));
  }

  function tellOnce(guildId, content) {
    if (told.has(guildId)) return;
    told.add(guildId);
    say(guildId, content);
  }

  const worker = () => supervisor.worker;
  const sink = {
    audio: (key, pcm) => {
      minute.ses++;
      return worker()?.audio(key, pcm);
    },
    idle: (key) => worker()?.send({ t: 'idle', k: key }),
    end: (key) => worker()?.send({ t: 'end', k: key }),
  };

  /**
   * Discord policy: everyone in the channel is told that the bot listens - on every join and every move to
   * another channel, at most once per channel in BILDIRIM_ARALIGI_MS (no spam on quick re-joins).
   */
  function announce(guildId) {
    const session = sessions.get(guildId);
    const channelId = music.getPlayer(guildId)?.voiceChannelId;
    if (!session || !channelId) return;
    const key = `${guildId}:${channelId}`;
    const last = announced.get(key);
    if (last !== undefined && now() - last < BILDIRIM_ARALIGI_MS) return;
    announced.set(key, now());
    if (announced.size > 1000) announced.delete(announced.keys().next().value);
    say(guildId, bildirim.acik(escapeMarkdown(session.wakeText)));
  }

  /** Whether the bot should join this guild's voice channel undeafened. */
  function listening(guildId) {
    return enabled(guildId) && status().kurulu;
  }

  async function startSession(guildId) {
    if (sessions.has(guildId) || starting.has(guildId) || !enabled(guildId)) return;
    const player = music.getPlayer(guildId);
    const receiver = player?.voiceReceiver;
    if (!receiver) return;
    const component = status();
    if (!component.kurulu) {
      logger?.warn(konsol.kuruluDegil(component.dizin));
      tellOnce(guildId, bildirim.kuruluDegil);
      return;
    }
    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return;
    starting.add(guildId);
    let listener;
    try {
      listener = await createListener({
        guildId,
        receiver,
        humans: () => {
          const channelId = music.getPlayer(guildId)?.voiceChannelId;
          return [...guild.voiceStates.cache.entries()]
            .filter(([, state]) => channelId && state.channelId === channelId)
            .map(([userId]) => userId);
        },
        isBot: (userId) => userId === client.user?.id || Boolean(guild.members?.cache?.get(userId)?.user?.bot),
        isExcluded: (userId) => exclusions.has(guildId, userId),
        sink,
        Opus,
        logger,
        timers,
      });
    } finally {
      starting.delete(guildId);
    }
    // The setting or the player may have changed while the decoder loaded.
    if (!enabled(guildId) || music.getPlayer(guildId) !== player || player.destroyed) {
      listener.stop();
      return;
    }
    const wakeText = wakePhrase(guildId);
    sessions.set(guildId, { listener, wake: wakeOf(wakeText), wakeText });
    supervisor.want();
    worker()?.send({ t: 'guild', g: guildId, wake: wakeText });
    announce(guildId);
    if (supervisor.state().durum === 'hata') tellOnce(guildId, bildirim.hata);
    context.status?.poke?.();
  }

  function endSession(guildId) {
    const session = sessions.get(guildId);
    if (!session) return;
    sessions.delete(guildId);
    session.listener.stop();
    worker()?.send({ t: 'endGuild', g: guildId });
    if (!sessions.size) supervisor.release().catch(() => {});
    context.status?.poke?.();
  }

  // ------------------------------------------------------------------ utterances

  function onWorkerMessage(message) {
    if (message.t === 'utt') {
      const guildId = String(message.k ?? '').split(':')[0];
      // When the sentence ended, fixed on arrival: the worker says how long ago (decoding and its queue), and
      // the wait in the chain below counts too.
      const endedAt = now() - Math.max(0, Number(message.age) || 0) * 1000;
      // One guild's commands run one after another (a "geç" right after a "çal" sees the new state).
      const previous = chains.get(guildId) ?? Promise.resolve();
      const next = previous
        .then(() => handleUtterance(message, endedAt))
        .catch((error) => logger?.error('Sesli komut işlenemedi:', error?.message ?? error));
      chains.set(guildId, next);
      next.finally(() => chains.get(guildId) === next && chains.delete(guildId));
    } else if (message.t === 'skip') {
      // short / long / busy / stale / prefix / vad (audio that never reached the speech threshold)
      bump(minute.atlanan, String(message.why));
      if (diagnose)
        logger?.info(
          `[sesli-komut tanı] kişi=${userTag(String(message.k ?? '').split(':')[1])} işçi attı: ${message.why} ` +
            `süre=${message.dur ?? '-'}sn vad=${fmt(message.vad)}`,
        );
    } else if (message.t === 'error') {
      logger?.warn(`Sesli komut işçisi hatası: ${message.msg}`);
    }
  }

  const bump = (map, key) => (map[key] = (map[key] ?? 0) + 1);
  function countResult(sonuc) {
    minute.cumle++;
    bump(
      minute.sonuc,
      String(sonuc ?? 'hata').split(':')[0] === 'yoksay' ? sonuc : String(sonuc ?? 'hata').split(':')[0],
    );
  }
  // A new random salt every start: the tag tells one speaker from another within a session, never across them.
  const tagSalt = randomBytes(16);
  const userTag = (userId) => createHash('sha256').update(tagSalt).update(String(userId)).digest('hex').slice(0, 8);
  const fmt = (value) => (value === undefined || value === null ? '-' : JSON.stringify(value));

  /** Diagnosis mode only: everything about one sentence on one line. */
  function logDiagnosis({ userId, message, endedAt, sonuc, uyandirma, niyet, ikinci, yasMs, promptsuz }) {
    if (!uyandirma) {
      // Ordinary talk (no wake phrase): never its text, only that it was skipped.
      logger?.info(
        `[sesli-komut tanı] ${new Date(endedAt).toISOString()} kişi=${userTag(userId)} süre=${message.dur}sn ` +
          `vad=${fmt(message.vad)} sonuç=${sonuc}`,
      );
      return;
    }
    const wake = uyandirma
      ? `${uyandirma.dropped ? 'kırpık' : 'tam'} '${uyandirma.bulunan ?? '?'}' mesafe ${uyandirma.dist} konum ${uyandirma.konum ?? '?'}`
      : 'yok';
    logger?.info(
      `[sesli-komut tanı] ${new Date(endedAt).toISOString()} kişi=${userTag(userId)} süre=${message.dur}sn ` +
        `vad=${fmt(message.vad)} nsp=${fmt(message.nsp)} cr=${fmt(message.cr)} logp=${fmt(message.logp)} stt=${fmt(message.sec)}sn ` +
        `metin=${fmt(message.text)} uyandırma=${wake} niyet=${fmt(niyet)} ikinci=${fmt(ikinci)} ` +
        `promptsuz=${Boolean(promptsuz)} yaş=${yasMs ?? Math.round(now() - endedAt)}ms sonuç=${sonuc}`,
    );
  }

  const minuteTimer = timers.setInterval?.(() => {
    if (!sessions.size) return;
    const m = minute;
    minute = { ses: 0, cumle: 0, sonuc: {}, atlanan: {} };
    logger?.info(
      `Sesli komut (son 1 dk): ${sessions.size} sunucuda dinleniyor, ${m.ses} ses çerçevesi, ${m.cumle} cümle; ` +
        `sonuçlar ${fmt(m.sonuc)}; işçinin attıkları ${fmt(m.atlanan)}`,
    );
  }, 60_000);
  minuteTimer?.unref?.();

  /** Whether a text without a wake phrase would be a command (then a pass without prompt is worth it). */
  function isCommand(text) {
    return parseCommand(words(text ?? '')).tur !== 'anlasilmadi';
  }

  function rateLimited(guildId, userId) {
    if (rate.waitFor(`u:${guildId}:${userId}`, HIZ_SINIRI.perUser) > 0) return true;
    if (rate.waitFor(`g:${guildId}`, HIZ_SINIRI.perGuild) > 0) return true;
    rate.record(`u:${guildId}:${userId}`);
    rate.record(`g:${guildId}`);
    return false;
  }

  async function handleUtterance(message, endedAt) {
    counters.cumle++;
    const [guildId, userId] = String(message.k ?? '').split(':');
    const trace = { userId, message, endedAt, sonuc: null };
    try {
      return await decide(guildId, userId, message, endedAt, trace);
    } finally {
      countResult(trace.sonuc);
      if (diagnose) logDiagnosis(trace);
      if (unknown && (trace.sonuc === 'anlamadim' || trace.sonuc === 'yoksay:anlasilmadi')) unknown.add(message.text);
    }
  }

  async function decide(guildId, userId, message, endedAt, trace) {
    const out = (sonuc) => {
      trace.sonuc = sonuc;
    };
    const session = sessions.get(guildId);
    if (!session) return out('oturum-yok');
    if (exclusions.has(guildId, userId)) return out('haric');
    let first = degerlendir(message, session.wake);
    // The wake-phrase prompt can make Whisper leave the wake phrase out ("Sırada ne var?"). Only when the text
    // alone is a command is the worker asked for one more pass without any prompt (not for ordinary talk).
    if (first.sonuc === 'yoksay' && first.neden === 'uyandirma' && isCommand(message.text)) {
      const again = await worker()?.retry(message.id, { hotwords: true });
      if (again && !again.gone) {
        const retried = degerlendir({ ...message, ...again, vad: message.vad }, session.wake);
        if (retried.sonuc !== 'yoksay' || retried.neden !== 'uyandirma') {
          first = retried;
          trace.promptsuz = true;
          trace.message = { ...message, text: again.text, nsp: again.nsp, cr: again.cr, logp: again.logp };
        }
      }
    }
    trace.uyandirma = first.uyandirma ?? null;
    if (first.sonuc === 'yoksay') {
      counters.yoksay++;
      return out(`yoksay:${first.neden}`);
    }
    const guild = client.guilds?.cache?.get(guildId);
    const player = music.getPlayer(guildId);
    if (!guild || !player) return out('oynatici-yok');
    // Only someone in the bot's channel (who else could it hear?) - and checked again, as for slash commands.
    if (guild.voiceStates?.cache?.get(userId)?.channelId !== player.voiceChannelId) return out('baska-kanal');
    const member = guild.members?.cache?.get(userId) ?? null;
    const name = escapeMarkdown(truncate(member?.displayName ?? member?.user?.username ?? 'Biri', 40));
    const channel = textChannelOf(guildId);

    if (first.sonuc === 'anlamadim') {
      if (rateLimited(guildId, userId)) return out('hiz-siniri');
      await say(guildId, first.oneri ? cevap.anlamadimOneri(name, first.oneri) : cevap.anlamadim(name), channel);
      return out('anlamadim');
    }
    const { niyet } = first;
    trace.niyet = niyet;
    if (!durumKapisi(niyet, music.getState(guildId))) return out('yoksay:durum');
    if (ciftKanitGerekir(niyet, first.uyandirma)) {
      const evidence = { akustik: false, kirpik: kirpikKaniti(message) };
      let second = await worker()?.verify(message.id);
      let again = second && !second.gone ? degerlendir(second, session.wake, evidence) : null;
      // The same omission of the wake phrase on the second pass: then the same pass without any prompt.
      if (again?.sonuc === 'yoksay' && again.neden === 'uyandirma' && isCommand(second.text)) {
        const retried = await worker()?.retry(message.id, { hotwords: false });
        if (retried && !retried.gone) {
          second = retried;
          again = degerlendir(retried, session.wake, evidence);
        }
      }
      trace.ikinci = second
        ? { text: second.text ?? null, gone: Boolean(second.gone), niyet: again?.niyet ?? null }
        : null;
      if (again?.sonuc !== 'niyet' || !ayniNiyet(niyet, again.niyet)) return out('yoksay:cift-kanit');
    }
    // Too late: a command said 5 s ago, or before the song changed, would act on the wrong song.
    trace.yasMs = Math.round(now() - endedAt);
    if (now() - endedAt > EN_ESKI_CUMLE_MS) return out('yoksay:yas');
    if (SARKIYA_BAGLI.has(niyet.tur) && (trackChangedAt.get(guildId) ?? -Infinity) > endedAt)
      return out('yoksay:sarki-degisti');
    if (rateLimited(guildId, userId)) return out('hiz-siniri');
    const djCommand = DJ_KARSILIGI[niyet.tur];
    if (DJ_COMMANDS.has(djCommand)) {
      const djRoleId = context.settings?.getDjRole?.(guildId) ?? null;
      const allowed = isDjAllowed({
        djRoleId,
        roleIds: memberRoleIds(member),
        canManageGuild: Boolean(member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)),
        aloneWithBot: isAloneWithBot(guild, userId, player.voiceChannelId),
      });
      if (!allowed) {
        await say(guildId, cevap.djGerekli(name, djRoleId), channel);
        return out('dj');
      }
    }
    out(`uygulandi:${niyet.tur}`);
    counters.komut++;
    try {
      await say(guildId, await apply(), channel);
    } catch (rawError) {
      const error = translateLavalinkError(rawError);
      if (error instanceof MusicError) {
        await say(guildId, cevap.hata(name, error.message), channel);
        return;
      }
      logger?.error(`Sesli komut (${niyet.tur}) hatası:`, rawError);
      await say(guildId, cevap.hata(name, 'beklenmeyen bir hata oldu'), channel);
    }

    async function apply() {
      const title = (track) => escapeMarkdown(truncate(track?.title ?? '?', 100));
      switch (niyet.tur) {
        case 'cal': {
          const resolved = await music.resolve(niyet.sorgu, member?.user ?? { id: userId }, { guildId });
          const result = await music.playResolved({
            guildId,
            voiceChannelId: player.voiceChannelId,
            textChannelId: player.textChannelId,
            resolved,
          });
          if (result.kind === 'playlist')
            return cevap.liste(
              name,
              escapeMarkdown(truncate(result.playlistName ?? 'liste', 80)),
              result.tracks.length,
            );
          const track = result.tracks[0];
          return result.queuePosition === 0
            ? cevap.caliyor(name, title(track))
            : cevap.siraya(name, title(track), result.queuePosition);
        }
        case 'kapat':
          // Unlike /stop the bot stays in the channel (and keeps listening); it leaves by the usual rules.
          await music.stopKeepChannel(guildId);
          return cevap.kapat(name);
        case 'gec':
          return cevap.gec(name, title(await music.skip(guildId)));
        case 'duraklat':
          await music.pause(guildId);
          return cevap.duraklat(name, sessions.get(guildId)?.wakeText);
        case 'devam':
          await music.resume(guildId);
          return cevap.devam(name);
        case 'sessiz':
          await music.mute(guildId);
          return cevap.sessiz(name);
        case 'sesi-geri-ac':
          return cevap.sesGeriAcildi(name, await music.unmute(guildId));
        case 'ses-kis':
        case 'ses-ac': {
          // "sesi aç" while muted means "unmute" (back to the level before the mute).
          if (niyet.tur === 'ses-ac' && music.getState(guildId)?.muted)
            return cevap.sesGeriAcildi(name, await music.unmute(guildId));
          const current = music.getState(guildId)?.volume ?? 100;
          const level = Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, current + niyet.adim));
          await music.setVolume(guildId, level);
          return cevap.ses(name, level);
        }
        case 'onceki':
          await music.previous(guildId);
          return cevap.onceki(name);
        case 'karistir':
          await music.shuffle(guildId);
          return cevap.karistir(name);
        case 'tekrarla':
          await music.setRepeatMode(guildId, 'track');
          return cevap.tekrarla(name, true);
        case 'tekrar-liste':
          await music.setRepeatMode(guildId, 'queue');
          return cevap.donguListe(name);
        case 'dongu-kapat':
          await music.setRepeatMode(guildId, 'off');
          return cevap.donguKapali(name);
        case 'otomatik-ac':
        case 'otomatik-kapat':
          return cevap.otomatik(name, music.setAutoplay(guildId, niyet.tur === 'otomatik-ac'));
        case 'ses-ayarla':
          await music.setVolume(guildId, niyet.seviye);
          return cevap.sesSeviye(name, niyet.seviye);
        case 'sar-ileri':
        case 'sar-geri': {
          const state = music.getState(guildId);
          const duration = state?.current?.duration ?? 0;
          const target = (state?.position ?? 0) + (niyet.tur === 'sar-ileri' ? niyet.ms : -niyet.ms);
          const clamped = Math.max(0, duration > 0 ? Math.min(target, duration - 1000) : target);
          await music.seek(guildId, clamped);
          return cevap.sarildi(name, formatDuration(clamped));
        }
        case 'sar-konum': {
          const duration = music.getState(guildId)?.current?.duration ?? 0;
          const clamped = duration > 0 ? Math.min(niyet.ms, duration - 1000) : niyet.ms;
          await music.seek(guildId, clamped);
          return cevap.sarildi(name, formatDuration(clamped));
        }
        case 'basa-sar':
          await music.seek(guildId, 0);
          return cevap.basaSarildi(name);
        case 'siraya-atla':
          return cevap.sirayaAtlandi(name, niyet.sira, title(await music.skipTo(guildId, niyet.sira)));
        case 'bilgi-calan': {
          const current = music.getState(guildId)?.current;
          return current
            ? cevap.calan(name, title(current), escapeMarkdown(truncate(current.author ?? '', 60)))
            : cevap.calanYok(name);
        }
        case 'bilgi-sira': {
          const queue = music.getState(guildId)?.queue ?? [];
          if (!queue.length) return cevap.siraBos(name);
          return cevap.sira(name, queue.slice(0, 3).map(title), Math.max(0, queue.length - 3));
        }
        case 'bilgi-sayi':
          return cevap.sayi(name, music.getState(guildId)?.queue?.length ?? 0);
        case 'kuyruga-ekle':
        case 'hemen-cal': {
          const resolved = await music.resolve(niyet.sorgu, member?.user ?? { id: userId }, { guildId });
          const result = await music.playResolved({
            guildId,
            voiceChannelId: player.voiceChannelId,
            textChannelId: player.textChannelId,
            resolved,
          });
          const track = result.tracks[0];
          if (result.queuePosition === 0) return cevap.caliyor(name, title(track));
          if (niyet.tur === 'hemen-cal') {
            // As /playfirst: it plays next.
            if (result.queuePosition > 1) await music.playNext(guildId, result.queuePosition);
            return cevap.siradaki(name, title(track));
          }
          return cevap.siraya(name, title(track), result.queuePosition);
        }
        case 'liste-cal': {
          const playlists = context.playlists;
          const wanted = fold(niyet.ad).replace(/\s+/g, '');
          const match = (playlists?.list(guildId) ?? []).find((l) => {
            const name = fold(l.name).replace(/\s+/g, '');
            return name === wanted || (wanted.length >= 4 && levenshtein(name, wanted) <= 1);
          });
          if (!match) return cevap.listeYok(name, escapeMarkdown(truncate(niyet.ad, 40)));
          const list = playlists.get(guildId, match.name);
          const result = await music.playSaved({
            guildId,
            voiceChannelId: player.voiceChannelId,
            textChannelId: player.textChannelId,
            entries: list.tracks,
            requester: member?.user ?? { id: userId },
            playlistName: list.name,
          });
          return cevap.listeBaslar(name, escapeMarkdown(truncate(list.name, 40)), result.total ?? list.tracks.length);
        }
        default:
          throw new Error(`Bilinmeyen sesli komut: ${niyet.tur}`);
      }
    }
  }

  // ------------------------------------------------------------------ events

  const onConnected = (guildId) => {
    if (sessions.has(guildId)) {
      announce(guildId); // a reconnect or a move to another channel
      return;
    }
    startSession(guildId).catch((error) => logger?.error('Sesli komut başlatılamadı:', error?.message ?? error));
  };
  const onDestroyed = (guildId) => {
    endSession(guildId);
    told.delete(guildId);
    trackChangedAt.delete(guildId);
  };
  const onTrackStarted = (guildId) => trackChangedAt.set(guildId, now());
  const onVoiceState = (oldState, newState) => {
    const guildId = newState?.guild?.id ?? oldState?.guild?.id;
    const session = sessions.get(guildId);
    const userId = newState?.id ?? oldState?.id;
    if (!session || !userId) return;
    if (userId === client.user?.id) {
      // The bot was moved: listen to the people of the new channel and tell them.
      if (newState?.channelId && newState.channelId !== oldState?.channelId) {
        const g = guild(guildId);
        for (const [id, state] of g?.voiceStates?.cache ?? [])
          if (state.channelId === newState.channelId) session.listener.add(id);
        announce(guildId);
      }
      return;
    }
    const channelId = music.getPlayer(guildId)?.voiceChannelId;
    if (newState?.channelId === channelId) session.listener.add(userId);
    else if (oldState?.channelId === channelId) session.listener.remove(userId);
  };
  music.on('voiceConnected', onConnected);
  music.on('playerDestroyed', onDestroyed);
  music.on('trackStarted', onTrackStarted);
  client.on?.(Events.VoiceStateUpdate, onVoiceState);

  return {
    listening,
    /** For tests and the status file. */
    sessions,
    counters,
    supervisor,
    /** A setting of this module changed (from /ayar or the desktop app). */
    async ayarDegisti(guildId, anahtar) {
      if (anahtar === 'acik') {
        const player = music.getPlayer(guildId);
        if (enabled(guildId)) {
          if (!player?.connected) return;
          if (!status().kurulu) {
            await startSession(guildId); // tells "kurulu değil"
            return;
          }
          player.setListening(true); // rejoin undeafened: the receiver gets packets from now on
          await startSession(guildId);
        } else {
          endSession(guildId);
          player?.setListening(false);
        }
      } else if (anahtar === 'uyandirma') {
        const session = sessions.get(guildId);
        if (!session) return;
        session.wakeText = wakePhrase(guildId);
        session.wake = wakeOf(session.wakeText);
        worker()?.send({ t: 'guild', g: guildId, wake: session.wakeText });
      }
    },
    /** Someone excluded themselves (or came back): their stream is closed / opened at once. */
    exclusionChanged(guildId, userId, excluded) {
      const session = sessions.get(guildId);
      if (!session) return;
      if (excluded) session.listener.remove(userId);
      else if (guild(guildId)?.voiceStates?.cache?.get(userId)?.channelId === music.getPlayer(guildId)?.voiceChannelId)
        session.listener.add(userId);
    },
    /** For data/durum.json and /muzik sesli-komut durum. */
    durum() {
      const component = status();
      const worker = supervisor.state();
      return {
        kurulu: component.kurulu,
        dinlenenSunucu: sessions.size,
        isci: worker.durum,
        cihaz: worker.cihaz,
        model: worker.model,
      };
    },
    async kapat() {
      music.off?.('voiceConnected', onConnected);
      music.off?.('playerDestroyed', onDestroyed);
      music.off?.('trackStarted', onTrackStarted);
      client.off?.(Events.VoiceStateUpdate, onVoiceState);
      timers.clearInterval?.(minuteTimer);
      for (const guildId of [...sessions.keys()]) endSession(guildId);
      await supervisor.release();
    },
  };

  function guild(guildId) {
    return client.guilds?.cache?.get(guildId);
  }
}
