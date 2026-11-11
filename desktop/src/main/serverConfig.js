'use strict';

// The "Ayarlar" part of the Servers tab. The bot writes three files into <project>/data
// (src/ozellikler/_masaustu): sunucu-yapisi/<guildId>.json (channels and roles, one file per server; only
// the selected server's file is read), ayar-semasi.json (the settings
// schema) and ayarlar-gorunum.json (current values). They are read here field by field with type and
// length checks: the files come from another program and channel/role names are user data.
// Saving writes data/istekler/<uuid>.json and waits for the bot's data/yanitlar/<uuid>.json. The window
// only ever sends { guildId, modul, alan, deger }; it is checked against the schema here, and every
// path is built here. The bot checks everything again with the same validator as /ayar.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_SCHEMA = 1;
const REQUEST_VERSION = 1;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_GUILDS = 2000;
const MAX_CHANNELS = 500;
const MAX_ROLES = 250;
const MAX_MODULES = 50;
const MAX_FIELDS = 60;
const MAX_TEXT = 2000;
const MAX_LIST = 50;
const ANSWER_TIMEOUT_MS = 15_000;

const SNOWFLAKE = /^\d{17,20}$/;
const MODULE_NAME = /^[a-z][a-z0-9-]{1,19}$/;
const FIELD_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const VIEW_KEY = /^[a-z][a-z0-9-]{1,19}\.[a-z][a-z0-9-]{0,31}$/;
const COMMAND = /^\/[a-z][a-z0-9 -]{0,60}$/;
const REQUEST_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Control characters other than tab and newline (the bot refuses them too).
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/;
/** Names the bot never accepts for a module or setting (JavaScript object internals, /ayar's own subcommands). */
const RESERVED = new Set([
  '__proto__',
  ...Object.getOwnPropertyNames(Object.prototype).map((n) => n.toLowerCase()),
  'prototype',
  'goster',
  'panel',
  'oz',
]);
const CHANNEL_KINDS = ['metin', 'ses', 'kategori', 'forum'];
const FIELD_TYPES = ['kanal', 'rol', 'metin', 'sayi', 'bayrak', 'kanal-listesi', 'rol-listesi', 'ozel'];
const CATEGORIES = ['Müzik', 'Oyun', 'Seviye', 'Karşılama', 'Kayıt', 'Odalar', 'Bildirimler', 'Diğer'];

const FILES = { sema: 'ayar-semasi.json', gorunum: 'ayarlar-gorunum.json' };
const STRUCTURE_DIR = 'sunucu-yapisi';
const MAX_GUILD_FILE_BYTES = 2 * 1024 * 1024;
const CLAIMED_WAIT_MS = 30_000;

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
const bool = (v) => v === true;
const int = (v) => (Number.isSafeInteger(v) ? v : null);
const snowflake = (v) => (typeof v === 'string' && SNOWFLAKE.test(v) ? v : null);
const isName = (v, pattern) => typeof v === 'string' && pattern.test(v) && !RESERVED.has(v.toLowerCase());

// ---- reading the bot's files ---------------------------------------------------------------------

function channel(raw) {
  if (!isObject(raw) || !snowflake(raw.id) || !CHANNEL_KINDS.includes(raw.tur)) return null;
  return {
    id: raw.id,
    ad: str(raw.ad, 100) ?? '?',
    tur: raw.tur,
    kategoriId: snowflake(raw.kategoriId),
    kategori: str(raw.kategori, 100),
    yazabilir: bool(raw.yazabilir),
    baglanabilir: bool(raw.baglanabilir),
  };
}

function role(raw) {
  if (!isObject(raw) || !snowflake(raw.id)) return null;
  return {
    id: raw.id,
    ad: str(raw.ad, 100) ?? '?',
    renk: typeof raw.renk === 'string' && /^#[0-9a-f]{6}$/i.test(raw.renk) ? raw.renk.toLowerCase() : '#000000',
    pozisyon: int(raw.pozisyon) ?? 0,
    yonetilen: bool(raw.yonetilen),
    tehlikeli: bool(raw.tehlikeli),
    verilebilir: bool(raw.verilebilir),
    neden: str(raw.neden, 300),
  };
}

/**
 * data/sunucu-yapisi/<guildId>.json -> the server's channels and roles, or null when it is not a file this app
 * understands or belongs to another server than its name says.
 */
function normalizeStructure(raw, guildId) {
  if (!isObject(raw) || raw.schemaVersion !== SUPPORTED_SCHEMA || !isObject(raw.sunucu)) return null;
  const g = raw.sunucu;
  if (!snowflake(g.id) || (guildId !== undefined && g.id !== guildId)) return null;
  return {
    id: g.id,
    ad: str(g.ad, 100) ?? '',
    botRolPozisyonu: int(g.botRolPozisyonu) ?? 0,
    rolleriYonetebilir: bool(g.rolleriYonetebilir),
    kanallar: (Array.isArray(g.kanallar) ? g.kanallar : []).slice(0, MAX_CHANNELS).map(channel).filter(Boolean),
    roller: (Array.isArray(g.roller) ? g.roller : []).slice(0, MAX_ROLES).map(role).filter(Boolean),
  };
}

function typedDefault(field, v) {
  if (v === null || v === undefined) return null;
  switch (field.tur) {
    case 'kanal':
    case 'rol':
      return snowflake(v);
    case 'metin':
      return typeof v === 'string' ? v.slice(0, MAX_TEXT) : null;
    case 'sayi':
      return int(v);
    case 'bayrak':
      return typeof v === 'boolean' ? v : null;
    default:
      return null;
  }
}

function field(raw) {
  if (!isObject(raw) || !isName(raw.anahtar, FIELD_NAME) || !FIELD_TYPES.includes(raw.tur)) return null;
  const out = {
    anahtar: raw.anahtar,
    tur: raw.tur,
    etiket: str(raw.etiket, 120) || raw.anahtar,
    aciklama: str(raw.aciklama, 300) ?? '',
    yalnizDiscord: typeof raw.yalnizDiscord === 'string' && COMMAND.test(raw.yalnizDiscord) ? raw.yalnizDiscord : null,
  };
  // A type the app cannot edit is always "only from Discord".
  if (out.tur === 'ozel' && !out.yalnizDiscord) out.yalnizDiscord = '/ayar';
  if (out.tur === 'kanal' || out.tur === 'kanal-listesi') {
    const kinds = (Array.isArray(raw.kanalTurleri) ? raw.kanalTurleri : []).filter((k) => CHANNEL_KINDS.includes(k));
    out.kanalTurleri = kinds.length ? [...new Set(kinds)] : ['metin'];
  }
  if (out.tur === 'rol') out.verilebilir = bool(raw.verilebilir);
  if (out.tur === 'metin') {
    const enAz = int(raw.enAz) ?? 1;
    const enFazla = int(raw.enFazla) ?? 200;
    if (enAz < 0 || enFazla < enAz || enFazla > MAX_TEXT) return null;
    Object.assign(out, { enAz, enFazla });
  }
  if (out.tur === 'sayi') {
    const [enAz, enFazla] = [int(raw.enAz), int(raw.enFazla)];
    if (enAz === null || enFazla === null || enFazla < enAz) return null;
    Object.assign(out, { enAz, enFazla });
  }
  if (out.tur === 'kanal-listesi' || out.tur === 'rol-listesi') {
    const enFazla = int(raw.enFazla);
    if (enFazla === null || enFazla < 1 || enFazla > MAX_LIST) return null;
    out.enFazla = enFazla;
  }
  out.varsayilan = typedDefault(out, raw.varsayilan);
  return out;
}

/** data/ayar-semasi.json -> { moduller: [...] }, or null. */
function normalizeSchema(raw) {
  if (!isObject(raw) || raw.schemaVersion !== SUPPORTED_SCHEMA || !Array.isArray(raw.moduller)) return null;
  const moduller = [];
  for (const m of raw.moduller.slice(0, MAX_MODULES)) {
    if (!isObject(m) || !isName(m.ad, MODULE_NAME) || moduller.some((x) => x.ad === m.ad)) continue;
    const alanlar = [];
    for (const f of (Array.isArray(m.alanlar) ? m.alanlar : []).slice(0, MAX_FIELDS)) {
      const clean = field(f);
      if (clean && !alanlar.some((x) => x.anahtar === clean.anahtar)) alanlar.push(clean);
    }
    if (!alanlar.length) continue;
    moduller.push({
      ad: m.ad,
      baslik: str(m.baslik, 60) || m.ad,
      emoji: str(m.emoji, 8) ?? '',
      kategori: CATEGORIES.includes(m.kategori) ? m.kategori : 'Diğer',
      kapali: str(m.kapali, 400),
      alanlar,
    });
  }
  return { kategoriler: CATEGORIES, moduller };
}

function viewValue(v) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, MAX_TEXT);
  return null;
}

/** data/ayarlar-gorunum.json -> { saltOkunur, sunucular: Map(guildId -> view) }, or null. */
function normalizeView(raw) {
  if (!isObject(raw) || raw.schemaVersion !== SUPPORTED_SCHEMA || !isObject(raw.sunucular)) return null;
  const sunucular = new Map();
  for (const [guildId, g] of Object.entries(raw.sunucular).slice(0, MAX_GUILDS)) {
    if (!snowflake(guildId) || !isObject(g)) continue;
    const entries = (object) => (isObject(object) ? Object.entries(object).filter(([k]) => VIEW_KEY.test(k)) : []);
    const degerler = Object.fromEntries(entries(g.degerler).map(([k, v]) => [k, viewValue(v)]));
    const uyarilar = Object.fromEntries(
      entries(g.uyarilar)
        .map(([k, v]) => [k, str(v, 300)])
        .filter(([, v]) => v),
    );
    const listeler = Object.fromEntries(
      entries(g.listeler)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [
          k,
          v
            .slice(0, MAX_LIST)
            .filter((x) => typeof x === 'string')
            .map((x) => x.slice(0, 300)),
        ]),
    );
    const ayarli = (Array.isArray(g.ayarli) ? g.ayarli : []).filter((k) => typeof k === 'string' && VIEW_KEY.test(k));
    sunucular.set(guildId, { degerler, ayarli, uyarilar, listeler });
  }
  return { saltOkunur: bool(raw.saltOkunur), sunucular };
}

// ---- checking what the window sends -------------------------------------------------------------

const fail = (hata) => ({ ok: false, hata });

function checkChannelId(id, guild, kinds) {
  if (typeof id !== 'string' || !SNOWFLAKE.test(id)) return 'Kanal seçimi geçersiz.';
  const found = guild.kanallar.find((c) => c.id === id);
  if (!found) return 'Seçilen kanal bu sunucuda yok (liste eskimiş olabilir).';
  if (!kinds.includes(found.tur)) return 'Bu ayar için başka türde bir kanal seçin.';
  return null;
}

function checkRoleId(id, guild, { verilebilir = false } = {}) {
  if (typeof id !== 'string' || !SNOWFLAKE.test(id) || id === guild.id) return 'Rol seçimi geçersiz.';
  const found = guild.roller.find((r) => r.id === id);
  if (!found) return 'Seçilen rol bu sunucuda yok (liste eskimiş olabilir).';
  if (found.yonetilen) return 'Bu rol bir bota ya da sunucu takviyesine ait; seçilemez.';
  if (verilebilir && !found.verilebilir) return `Bu rol verilemez: ${found.neden ?? 'bot bu rolü veremiyor'}.`;
  return null;
}

/**
 * Checks a change from the window against the schema and the server's channels and roles.
 * @returns {{ ok: true, istek: { guildId, modul, alan, deger } } | { ok: false, hata: string }}
 */
function validateChange(payload, { schema, guildOf }) {
  if (!isObject(payload)) return fail('Geçersiz istek.');
  const keys = Object.keys(payload).sort();
  if (keys.join(',') !== 'alan,deger,guildId,modul') return fail('Geçersiz istek.');
  const { guildId, modul, alan, deger } = payload;
  if (!snowflake(guildId) || !isName(modul, MODULE_NAME) || !isName(alan, FIELD_NAME)) return fail('Geçersiz istek.');
  if (!schema) return fail("Botun ayar bilgileri henüz yok. Bot bir kez Discord'a bağlanınca gelir.");
  const guild = guildOf?.(guildId) ?? null;
  if (!guild) return fail('Bu sunucunun kanal ve rol listesi yok (bot bu sunucuda değil mi?).');
  const module = schema.moduller.find((m) => m.ad === modul);
  const f = module?.alanlar.find((x) => x.anahtar === alan);
  if (!f) return fail('Bilinmeyen ayar.');
  if (module.kapali) return fail(module.kapali);
  if (f.yalnizDiscord) return fail(`Bu ayarı Discord'da ${f.yalnizDiscord} ile yapın.`);

  const ok = (value) => ({ ok: true, istek: { guildId, modul, alan, deger: value } });
  if (deger === null && !f.tur.endsWith('-listesi')) return ok(null);
  switch (f.tur) {
    case 'kanal': {
      const error = checkChannelId(deger, guild, f.kanalTurleri);
      return error ? fail(error) : ok(deger);
    }
    case 'rol': {
      const error = checkRoleId(deger, guild, { verilebilir: f.verilebilir });
      return error ? fail(error) : ok(deger);
    }
    case 'metin': {
      if (typeof deger !== 'string') return fail('Metin bekleniyordu.');
      const text = deger.trim();
      if (text.length < f.enAz || text.length > f.enFazla) return fail(`Metin ${f.enAz}-${f.enFazla} karakter olmalı.`);
      if (CONTROL_CHARS.test(text)) return fail('Metin görünmeyen denetim karakterleri içeremez.');
      return ok(text);
    }
    case 'sayi':
      if (!Number.isSafeInteger(deger) || deger < f.enAz || deger > f.enFazla)
        return fail(`Değer ${f.enAz} ile ${f.enFazla} arasında bir tam sayı olmalı.`);
      return ok(deger);
    case 'bayrak':
      return typeof deger === 'boolean' ? ok(deger) : fail('Açık ya da kapalı seçin.');
    case 'kanal-listesi':
    case 'rol-listesi': {
      const list = deger === null ? [] : deger;
      if (!Array.isArray(list)) return fail('Liste bekleniyordu.');
      const unique = [...new Set(list)];
      if (unique.length !== list.length) return fail('Listede aynı öğe iki kez var.');
      if (unique.length > f.enFazla) return fail(`En fazla ${f.enFazla} öğe seçilebilir.`);
      for (const id of unique) {
        const error = f.tur === 'kanal-listesi' ? checkChannelId(id, guild, f.kanalTurleri) : checkRoleId(id, guild);
        if (error) return fail(error);
      }
      return ok(unique);
    }
    default:
      return fail('Bu ayar uygulamadan değiştirilemez.');
  }
}

// ---- request and answer files -------------------------------------------------------------------

const requestDir = (projectDir) => path.join(projectDir, 'data', 'istekler');
const answerDir = (projectDir) => path.join(projectDir, 'data', 'yanitlar');

/** Writes data/istekler/<uuid>.json atomically (temporary name first, which the bot ignores). */
function writeRequest(projectDir, istek, { fsImpl = fs, now = Date.now, randomUUID = crypto.randomUUID } = {}) {
  const id = randomUUID();
  if (!REQUEST_NAME.test(id)) throw new Error('Geçersiz istek kimliği');
  const dir = requestDir(projectDir);
  fsImpl.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const temp = `${file}.tmp`;
  const body = { surum: REQUEST_VERSION, ...istek, istenen: new Date(now()).toISOString() };
  fsImpl.writeFileSync(temp, JSON.stringify(body), 'utf8');
  fsImpl.renameSync(temp, file);
  return id;
}

function readAnswer(projectDir, id, fsImpl) {
  const file = path.join(answerDir(projectDir), `${id}.json`);
  let stat;
  try {
    stat = fsImpl.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_ANSWER_BYTES) return { ok: false, hata: 'Botun yanıtı okunamadı.' };
  let raw;
  try {
    raw = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return null; // being written: look again
  }
  try {
    fsImpl.rmSync(file, { force: true });
  } catch {
    // the bot removes old answers too
  }
  if (!isObject(raw) || typeof raw.ok !== 'boolean') return { ok: false, hata: 'Botun yanıtı anlaşılamadı.' };
  const yeniDeger = Array.isArray(raw.yeniDeger)
    ? raw.yeniDeger.filter((x) => typeof x === 'string').slice(0, MAX_LIST)
    : viewValue(raw.yeniDeger);
  return { ok: raw.ok, hata: raw.ok ? null : (str(raw.hata, 500) ?? 'Ayar uygulanamadı.'), yeniDeger };
}

/**
 * Waits for the bot's answer. The bot claims a request by renaming it to <uuid>.isleniyor before it reads it;
 * from then on it will be applied, so `onProgress('uygulaniyor')` is called and the wait goes on (up to
 * `claimedWaitMs` more). On timeout a request still named <uuid>.json is taken back, also by renaming: either
 * the bot's rename or this one wins, so a request is never both taken back and applied.
 */
async function waitForAnswer(
  projectDir,
  id,
  {
    fsImpl = fs,
    timeoutMs = ANSWER_TIMEOUT_MS,
    claimedWaitMs = CLAIMED_WAIT_MS,
    intervalMs = 150,
    onProgress = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  if (!REQUEST_NAME.test(id)) return fail('Geçersiz istek kimliği.');
  const dir = requestDir(projectDir);
  const original = path.join(dir, `${id}.json`);
  const claimedFile = path.join(dir, `${id}.isleniyor`);
  let claimed = false;
  const noteClaim = () => {
    if (claimed || !fsImpl.existsSync(claimedFile)) return;
    claimed = true;
    onProgress('uygulaniyor');
  };
  const waitUntil = async (end) => {
    while (Date.now() < end) {
      const answer = readAnswer(projectDir, id, fsImpl);
      if (answer) return answer;
      noteClaim();
      await sleep(intervalMs);
    }
    return readAnswer(projectDir, id, fsImpl);
  };
  const answer = await waitUntil(Date.now() + timeoutMs);
  if (answer) return answer;

  const seconds = Math.round(timeoutMs / 1000);
  let withdrawn = false;
  try {
    fsImpl.renameSync(original, path.join(dir, `${id}.geri-alindi`));
    withdrawn = true;
  } catch {
    // Not there any more: the bot has claimed it (or already answered).
  }
  if (withdrawn) {
    try {
      fsImpl.rmSync(path.join(dir, `${id}.geri-alindi`), { force: true });
    } catch {
      // the bot never applies *.geri-alindi and removes it in its clean-up round
    }
    return {
      ok: false,
      zamanAsimi: true,
      hata: `Bot ${seconds} sn içinde yanıt vermedi; istek geri alındı, ayar değişmedi. Bot çalışıyor mu?`,
    };
  }
  noteClaim();
  const late = await waitUntil(Date.now() + claimedWaitMs);
  if (late) return late;
  return {
    ok: false,
    zamanAsimi: true,
    hata: claimed
      ? 'Bot isteği aldı ve uyguluyor ama henüz yanıt vermedi. Sonuç ekrana yansıyınca görürsünüz.'
      : 'İstek bot tarafından yanıtsız kaldırıldı (çok fazla bekleyen istek olabilir). Ayarı yeniden kaydedin.',
  };
}

// ---- watching the files ---------------------------------------------------------------------------

/**
 * Watches ayar-semasi.json and ayarlar-gorunum.json in <project>/data (fs.watch on the folder plus polling as
 * a fallback) and reads a server's sunucu-yapisi/<guildId>.json only when that server is asked for.
 * snapshot() gives { schema, view } (null each until the bot wrote a valid file).
 */
function createServerConfigWatcher({ getProjectDir, onChange, pollMs = 3000, fsImpl = fs }) {
  const state = { sema: null, gorunum: null };
  const keys = { sema: null, gorunum: null };
  const normalize = { sema: normalizeSchema, gorunum: normalizeView };
  /** guildId -> { key, value } of the last structure file read */
  const structures = new Map();
  let watcher = null;
  let structureWatcher = null;
  let watchedDir = null;
  let poll = null;
  let lastGuild = null;
  const dataDir = () => {
    const dir = getProjectDir();
    return dir ? path.join(dir, 'data') : null;
  };

  function read(name) {
    const dir = dataDir();
    const file = dir ? path.join(dir, FILES[name]) : null;
    let stat = null;
    try {
      stat = file ? fsImpl.statSync(file) : null;
    } catch {
      stat = null;
    }
    if (!stat) return false; // keep the last good data while the file is being replaced
    const key = `${file}|${stat.mtimeMs}|${stat.size}`;
    if (key === keys[name]) return false;
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      keys[name] = key;
      state[name] = null;
      return true;
    }
    let next;
    try {
      next = normalize[name](JSON.parse(fsImpl.readFileSync(file, 'utf8')));
    } catch {
      return false; // half-written: the next event or poll reads it again
    }
    keys[name] = key;
    state[name] = next;
    return true;
  }

  /** The server's channels and roles (cached until its file changes); null when there is no valid file. */
  function guildStructure(guildId) {
    if (!snowflake(guildId)) return null;
    const dir = dataDir();
    const file = dir ? path.join(dir, STRUCTURE_DIR, `${guildId}.json`) : null;
    let stat = null;
    try {
      stat = file ? fsImpl.lstatSync(file) : null;
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile() || stat.size > MAX_GUILD_FILE_BYTES) {
      structures.delete(guildId);
      return null;
    }
    const key = `${file}|${stat.mtimeMs}|${stat.size}`;
    const cached = structures.get(guildId);
    if (cached?.key === key) return cached.value;
    let value;
    try {
      value = normalizeStructure(JSON.parse(fsImpl.readFileSync(file, 'utf8')), guildId);
    } catch {
      return cached?.value ?? null; // half-written: keep the last good one
    }
    structures.set(guildId, { key, value });
    if (structures.size > 20) structures.delete(structures.keys().next().value);
    return value;
  }

  /** Whether the file of the server on screen changed since it was last read. */
  function shownStructureChanged() {
    if (!lastGuild) return false;
    const before = structures.get(lastGuild)?.key ?? null;
    guildStructure(lastGuild);
    return (structures.get(lastGuild)?.key ?? null) !== before;
  }

  function readAll() {
    const changed = ['sema', 'gorunum'].map(read).some(Boolean);
    if (shownStructureChanged() || changed) onChange?.();
  }

  function watchFolder() {
    const dir = dataDir();
    if (dir === watchedDir && watcher) return;
    watcher?.close();
    watcher = null;
    watchedDir = dir;
    if (!dir) return;
    try {
      watcher = fsImpl.watch(dir, (_event, name) => {
        if (!name || Object.values(FILES).includes(String(name))) readAll();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
    structureWatcher?.close();
    structureWatcher = null;
    try {
      structureWatcher = fsImpl.watch(path.join(dir, STRUCTURE_DIR), (_event, name) => {
        if (!name || String(name) === `${lastGuild}.json`) readAll();
      });
      structureWatcher.on('error', () => {
        structureWatcher?.close();
        structureWatcher = null;
      });
    } catch {
      structureWatcher = null; // not written yet: polling covers it
    }
  }

  return {
    start() {
      readAll();
      watchFolder();
      poll = setInterval(() => {
        if (!structureWatcher) watchedDir = null; // the folder may exist now
        watchFolder();
        readAll();
      }, pollMs);
      poll.unref?.();
    },
    refresh() {
      for (const name of Object.keys(keys)) {
        keys[name] = null;
        state[name] = null;
      }
      structures.clear();
      watchedDir = null;
      watchFolder();
      readAll();
      onChange?.();
    },
    stop() {
      clearInterval(poll);
      watcher?.close();
      structureWatcher?.close();
    },
    snapshot: () => ({ schema: state.sema, view: state.gorunum }),
    guildStructure,
    /** What the window gets for one server: plain data only (no Maps, no paths). */
    guildView(guildId) {
      if (!snowflake(guildId)) return null;
      lastGuild = guildId;
      const view = state.gorunum?.sunucular.get(guildId) ?? null;
      return {
        sema: state.sema,
        yapi: guildStructure(guildId),
        gorunum: view,
        saltOkunur: Boolean(state.gorunum?.saltOkunur),
      };
    },
  };
}

module.exports = {
  normalizeStructure,
  normalizeSchema,
  normalizeView,
  validateChange,
  writeRequest,
  waitForAnswer,
  createServerConfigWatcher,
  REQUEST_NAME,
  FILES,
};
