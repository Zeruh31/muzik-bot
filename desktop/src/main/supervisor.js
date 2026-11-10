'use strict';

// Runs Lavalink and the bot together: Lavalink first, the bot once Lavalink is ready;
// stopping goes the other way. Watches their output for status lines, the YouTube sign-in
// code and secrets to hide.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { ManagedProcess, LaunchError } = require('./service');
const { RestartPolicy } = require('./backoff');
const { parseBotLine, parseLavalinkLine, redact } = require('./logLine');
const { detectYoutubeAuth } = require('./youtubeAuth');
const { parseEnv } = require('./envFile');
const { SECRET_KEYS, isTrue } = require('./envSchema');
const { buildLavalinkLaunch, buildBotLaunch, parseLavalinkPort } = require('./launchers');
const { findProjectProcesses, describeConflict, runsLavalinkJar } = require('./projectProcesses');

const LAVALINK_READY = /Lavalink is ready to accept connections/;
const BOT_READY = /Discord'a giriş yapıldı:\s*(.+?)\s*\((\d+) sunucu\)/;

/** Explains Lavalink lines that mean it cannot run. */
function lavalinkFatal(raw) {
  const port = /Port (\d+) was already in use/i.exec(raw);
  if (port) return `Port ${port[1]} başka bir program tarafından kullanılıyor; Lavalink açılamadı.`;
  if (/Unable to access jarfile/i.test(raw)) return 'Lavalink.jar açılamadı (dosya eksik ya da bozuk).';
  if (/UnsupportedClassVersionError/.test(raw))
    return 'Java sürümü Lavalink için çok eski. Java 17 veya daha yenisi gerekir.';
  if (/Could not reserve enough space|Invalid maximum heap size/i.test(raw)) {
    return 'Java bu kadar bellek ayıramadı. Ayarlar > Lavalink > Lavalink belleği değerini düşürün (ör. 512M).';
  }
  return null;
}

/** Explains bot lines that mean it cannot run (index.js prints these as "HATA: ..."). */
function botFatal(raw, parsed) {
  if (/^\s*HATA:/.test(raw)) return parsed.message.replace(/^HATA:\s*/, '').trim();
  return null;
}

class Supervisor extends EventEmitter {
  /**
   * @param {object} options
   * @param {() => string|null} options.getProjectDir
   * @param {import('./logStore').LogStore} options.logs
   * @param {() => boolean} options.autoRestart
   * @param {object} options.deps  process helpers (spawn, sendCtrlC, killTree, isAlive, isPortInUse,
   *   findListeningPids, processName, processCommandLine, listProcesses, resolveJava, resolveNode)
   * @param {{ add(pid: number): void, remove(pid: number): void }} [options.watchdog]
   * @param {string} [options.pidFile]  remembers PIDs so a Lavalink from an earlier run can be adopted
   * @param {object} [options.baseEnv]
   * @param {object} [options.timing]  timeouts (tests shorten them)
   */
  constructor({ getProjectDir, logs, autoRestart, deps, watchdog, pidFile, baseEnv = process.env, timing = {} }) {
    super();
    this.getProjectDir = getProjectDir;
    this.logs = logs;
    this.deps = deps;
    this.pidFile = pidFile;
    this.baseEnv = baseEnv;
    this.secrets = [];
    this.envValues = {};
    this.busy = null;
    this.lastError = null;
    this.bot = { name: null, guilds: null, lavalinkConnected: false };
    this.panel = { state: 'unknown', url: null, message: null };
    this.youtube = { phase: 'idle', code: null, url: null, message: null };
    this.lavalinkPort = 2333;
    this.lastLevel = { bot: 'info', lavalink: 'info' };
    // Bot/Lavalink of this project running outside the app (e.g. "npm start" in a window).
    this.conflict = null;
    this.startToken = 0;
    // PIDs from the previous run, read before this run overwrites the file.
    this.previousPids = this.#readPidFile();

    const common = {
      spawn: deps.spawn,
      gracefulStop: deps.sendCtrlC,
      killTree: deps.killTree,
      isAlive: deps.isAlive,
      watchdog,
      autoRestart,
    };

    this.lavalinkService = new ManagedProcess({
      ...common,
      name: 'lavalink',
      label: 'Lavalink',
      launch: () => this.#lavalinkLaunch(),
      parseLine: parseLavalinkLine,
      isReady: (raw) => LAVALINK_READY.test(raw),
      fatalMessage: (raw) => lavalinkFatal(raw),
      startTimeoutMs: timing.lavalinkStartMs ?? 180_000,
      stopTimeoutMs: timing.lavalinkStopMs ?? 15_000,
      // Spring logs from its "SpringApplicationShutdownHook" thread once Ctrl+C is handled.
      // Normally the JVM exits within a second; with bufferDurationMs: 0 in application.yml
      // a non-daemon audio thread keeps it alive forever, so it is ended after a short grace.
      shutdownStarted: (raw) => /ShutdownHook\]/.test(raw),
      shutdownGraceMs: timing.lavalinkShutdownGraceMs ?? 5000,
      policy: new RestartPolicy(timing.policy),
    });
    this.botService = new ManagedProcess({
      ...common,
      name: 'bot',
      label: 'Bot',
      launch: () => this.#botLaunch(),
      parseLine: parseBotLine,
      isReady: (raw) => BOT_READY.test(raw),
      fatalMessage: botFatal,
      stopTimeoutMs: timing.botStopMs ?? 10_000,
      policy: new RestartPolicy(timing.policy),
    });

    for (const service of [this.lavalinkService, this.botService]) {
      service.on('line', (line) => this.#onLine(service.name, line));
      service.on('state', (snapshot) => this.#onState(service.name, snapshot));
      service.on('lingering', ({ afterMs }) =>
        this.logs.add(
          'app',
          'info',
          `${service.label} kapanma adımlarını bitirdi ama ${Math.round(afterMs / 1000)} saniyede çıkmadı; süreç sonlandırıldı.`,
        ),
      );
      service.on('forced', ({ afterMs }) =>
        this.logs.add(
          'app',
          'warn',
          `${service.label} ${Math.round(afterMs / 1000)} saniyede kapanmadı, zorla kapatılıyor.`,
        ),
      );
    }
    this.refreshEnv();
  }

  // ---- .env --------------------------------------------------------------------------

  envPath() {
    const dir = this.getProjectDir();
    return dir ? path.join(dir, '.env') : null;
  }

  /** Re-reads .env (values for the status cards and secrets to hide in logs). */
  refreshEnv() {
    const file = this.envPath();
    let values = {};
    try {
      if (file && fs.existsSync(file)) values = parseEnv(fs.readFileSync(file, 'utf8'));
    } catch {
      values = {};
    }
    this.envValues = values;
    this.secrets = SECRET_KEYS.map((key) => values[key]).filter(Boolean);
    try {
      this.lavalinkPort = parseLavalinkPort(values.LAVALINK_PORT);
    } catch {
      this.lavalinkPort = null;
    }
    this.#emitStatus();
    return values;
  }

  // ---- launching ----------------------------------------------------------------------

  #projectDirOrThrow() {
    const dir = this.getProjectDir();
    if (!dir) throw new LaunchError('Proje klasörü bulunamadı. Ayarlar sekmesinden botun klasörünü seçin.');
    return dir;
  }

  async #lavalinkLaunch() {
    const projectDir = this.#projectDirOrThrow();
    const values = this.refreshEnv();
    const java = await this.deps.resolveJava();
    const launch = buildLavalinkLaunch({
      projectDir,
      envValues: values,
      baseEnv: this.baseEnv,
      javaPath: java.path,
      javaMajor: java.major,
    });
    this.youtube = launch.youtubeLoggedIn
      ? { phase: 'idle', code: null, url: null, message: null }
      : { phase: 'waiting', code: null, url: null, message: 'Lavalink giriş kodunu hazırlıyor...' };
    if (await this.deps.isPortInUse(launch.port)) await this.#portBusy(launch.port);
    return launch;
  }

  /** Port taken: adopt our own Lavalink from an earlier run, otherwise explain. */
  async #portBusy(port) {
    const pids = await this.deps.findListeningPids(port).catch(() => []);
    const remembered = this.previousPids.lavalink;
    const pid = pids[0];
    const name = pid ? await this.deps.processName(pid).catch(() => null) : null;
    if (pid && remembered?.pid === pid && remembered?.port === port && /^java(w)?\.exe$/i.test(name ?? '')) {
      // PIDs get reused: only adopt when the process really runs this project's Lavalink.jar.
      const commandLine = await this.deps.processCommandLine(pid).catch(() => null);
      if (commandLine && runsLavalinkJar(commandLine, this.getProjectDir())) {
        const error = new LaunchError('adopt');
        error.adoptPid = pid;
        throw error;
      }
    }
    const who = pid ? `${name ?? 'bilinmeyen program'}, PID ${pid}` : 'bilinmeyen program';
    const hint = /^java/i.test(name ?? '')
      ? 'Büyük olasılıkla ayrı bir pencerede açık başka bir Lavalink var ("npm run lavalink" ya da "npm run hepsi"). O pencereyi kapatın'
      : 'Bu portu kullanan programı kapatın';
    throw new LaunchError(
      `${port} portu kullanımda (${who}). ${hint} ya da Ayarlar > Lavalink bölümünden LAVALINK_PORT'u değiştirin.`,
    );
  }

  async #botLaunch() {
    const projectDir = this.#projectDirOrThrow();
    this.refreshEnv();
    const node = await this.deps.resolveNode();
    this.bot = { name: null, guilds: null, lavalinkConnected: false };
    this.panel = { state: isTrue(this.envValues.PANEL_ENABLED) ? 'waiting' : 'disabled', url: null, message: null };
    return buildBotLaunch({ projectDir, baseEnv: this.baseEnv, nodePath: node.path, nodeMajor: node.major });
  }

  // ---- pid file -------------------------------------------------------------------------

  #readPidFile() {
    try {
      return JSON.parse(fs.readFileSync(this.pidFile, 'utf8'));
    } catch {
      return {};
    }
  }

  #writePidFile() {
    if (!this.pidFile) return;
    const data = {};
    if (this.lavalinkService.pid) data.lavalink = { pid: this.lavalinkService.pid, port: this.lavalinkPort };
    if (this.botService.pid) data.bot = { pid: this.botService.pid };
    try {
      fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
      fs.writeFileSync(this.pidFile, JSON.stringify(data));
    } catch {
      // not critical
    }
  }

  // ---- output ---------------------------------------------------------------------------

  #onLine(source, { raw, parsed }) {
    const level = parsed.level ?? (parsed.structured ? 'info' : this.lastLevel[source]);
    if (parsed.structured || parsed.level) this.lastLevel[source] = level;
    // Time and level have their own columns; keep the scope ("bot:panel", "UndertowWebServer").
    const scope = source === 'lavalink' ? parsed.scope?.split('.').pop() : parsed.scope;
    const shown = parsed.structured ? `${scope ? `[${scope}] ` : ''}${parsed.message}` : (parsed.message ?? raw);
    const text = redact(shown, this.secrets);
    if (text.trim() !== '') this.logs.add(source, level, text);

    if (source === 'lavalink') {
      const auth = detectYoutubeAuth(raw);
      if (auth?.type === 'code') {
        this.youtube = { phase: 'code', code: auth.code, url: auth.url, message: null };
        this.emit('youtube', { ...this.youtube });
        this.#emitStatus();
      } else if (auth?.type === 'success' && this.youtube.phase !== 'saved') {
        this.youtube = { ...this.youtube, phase: 'success', message: 'Giriş başarılı. Token kaydediliyor...' };
        this.emit('youtube', { ...this.youtube });
        this.#emitStatus();
      }
      return;
    }

    const ready = BOT_READY.exec(raw);
    if (ready) this.bot = { ...this.bot, name: ready[1], guilds: Number(ready[2]) };
    if (/Lavalink bağlandı/.test(raw)) this.bot.lavalinkConnected = true;
    if (/Lavalink bağlantısı koptu|Lavalink'e yeniden bağlanılıyor|Lavalink'e ulaşılamıyor/.test(raw))
      this.bot.lavalinkConnected = false;
    const panelOpen = /Web paneli açık:\s*(\S+)/.exec(raw);
    if (panelOpen) this.panel = { state: 'open', url: panelOpen[1], message: null };
    const panelFail = /Web paneli (?:açılmadı|başlatılamadı):\s*(.*)$/.exec(raw);
    if (panelFail) this.panel = { state: 'error', url: null, message: panelFail[1] };
    if (ready || panelOpen || panelFail || /Lavalink (bağlandı|bağlantısı koptu|'e)/.test(raw)) this.#emitStatus();
  }

  #onState(name, snapshot) {
    if (
      name === 'bot' &&
      (snapshot.state === 'stopped' || snapshot.state === 'error' || snapshot.state === 'restarting')
    ) {
      this.bot.lavalinkConnected = false;
      if (this.panel.state === 'open' || this.panel.state === 'waiting')
        this.panel = { state: 'closed', url: null, message: null };
    }
    if (name === 'lavalink' && snapshot.state !== 'starting' && this.youtube.phase === 'waiting') {
      this.youtube = { phase: 'idle', code: null, url: null, message: null };
    }
    const label = name === 'bot' ? 'Bot' : 'Lavalink';
    if (snapshot.error && (snapshot.state === 'error' || snapshot.state === 'restarting')) {
      this.logs.add(
        'app',
        'error',
        `${label}: ${redact(snapshot.error, this.secrets)}${snapshot.detail ? ` ${snapshot.detail}` : ''}`,
      );
    }
    this.#writePidFile();
    this.#emitStatus();
  }

  #emitStatus() {
    this.emit('status', this.status());
  }

  status() {
    const values = this.envValues;
    const panelEnabled = isTrue(values.PANEL_ENABLED);
    const port = Number(values.PANEL_PORT) || 3000;
    const configuredUrl = (values.PANEL_PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
    return {
      projectDir: this.getProjectDir(),
      busy: this.busy,
      lastError: this.lastError,
      lavalink: { ...this.lavalinkService.snapshot(), port: this.lavalinkPort },
      bot: { ...this.botService.snapshot(), ...this.bot },
      youtube: { ...this.youtube, loggedIn: Boolean(values.YOUTUBE_OAUTH_REFRESH_TOKEN?.trim()) },
      panel: { ...this.panel, enabled: panelEnabled, configuredUrl, url: this.panel.url ?? configuredUrl },
      running: this.isRunning(),
      conflict: this.conflict,
    };
  }

  isRunning() {
    return [this.lavalinkService.state, this.botService.state].some((s) => s !== 'stopped' && s !== 'error');
  }

  // ---- control --------------------------------------------------------------------------

  // ---- other copies of this bot ------------------------------------------------------------

  /** This project's bot / Lavalink processes that the app did not start. */
  async findConflicts() {
    const projectDir = this.getProjectDir();
    if (!projectDir || !this.deps.listProcesses) return [];
    const list = await this.deps.listProcesses().catch(() => []);
    const own = [this.lavalinkService.pid, this.botService.pid, this.previousPids.lavalink?.pid];
    return findProjectProcesses(list, projectDir, own);
  }

  /** Called when the app opens: only reports, never kills. */
  async checkConflicts() {
    const processes = await this.findConflicts();
    this.conflict = processes.length ? { processes, message: describeConflict(processes), startup: true } : null;
    if (this.conflict) this.logs.add('app', 'warn', this.conflict.message);
    this.#emitStatus();
    return this.conflict;
  }

  clearConflict() {
    this.conflict = null;
    this.#emitStatus();
  }

  async #killConflicts(processes) {
    for (const p of processes) {
      await this.deps.killTree(p.pid).catch(() => {});
      for (let i = 0; i < 40 && this.deps.isAlive(p.pid); i += 1) await new Promise((r) => setTimeout(r, 250));
      this.logs.add(
        'app',
        'info',
        `Başka pencerede açık olan ${p.kind === 'bot' ? 'bot' : 'Lavalink'} (PID ${p.pid}) kapatıldı.`,
      );
    }
  }

  // ---- control --------------------------------------------------------------------------

  /**
   * Starts Lavalink, waits until it is ready, then starts the bot.
   * When this bot already runs elsewhere it stops and reports a conflict, unless
   * `takeOver` (user confirmed: close the other copy and start here). `auto` (autostart)
   * never asks, it only warns.
   */
  async startAll({ takeOver = false, auto = false } = {}) {
    if (this.busy) return this.status();
    await this.#runStart({ takeOver, auto });
    return this.status();
  }

  async #runStart({ takeOver, auto }) {
    const token = ++this.startToken;
    this.busy = 'starting';
    this.lastError = null;
    this.#emitStatus();
    try {
      const conflicts = await this.findConflicts();
      if (conflicts.length) {
        const message = describeConflict(conflicts);
        if (!takeOver) {
          this.conflict = { processes: conflicts, message, auto };
          if (auto) this.lastError = `${message} Otomatik başlatma yapılmadı.`;
          this.logs.add('app', 'warn', auto ? this.lastError : message);
          return;
        }
        await this.#killConflicts(conflicts);
      }
      this.conflict = null;
      if (token !== this.startToken) return;
      if (this.lavalinkService.state !== 'ready') {
        await this.#startLavalinkOrAdopt();
        await this.lavalinkService.waitReady();
      }
      // Durdur was pressed while Lavalink was starting: do not start the bot.
      if (token !== this.startToken) return;
      await this.botService.start();
    } catch (error) {
      if (token === this.startToken) this.lastError = error.message;
    } finally {
      if (this.busy === 'starting' && token === this.startToken) this.busy = null;
      this.#emitStatus();
    }
  }

  /**
   * Starts Lavalink. When its port is held by the Lavalink this app started in an earlier
   * run (PID remembered in the pid file), that process is adopted instead.
   */
  async #startLavalinkOrAdopt() {
    const service = this.lavalinkService;
    const originalLaunch = service.launch;
    let adoptPid = null;
    service.launch = async () => {
      try {
        return await originalLaunch();
      } catch (error) {
        if (error.adoptPid) {
          adoptPid = error.adoptPid;
          throw new LaunchError('Önceki oturumdan kalan Lavalink devralınıyor...');
        }
        throw error;
      }
    };
    try {
      await service.start();
    } finally {
      service.launch = originalLaunch;
    }
    if (adoptPid) {
      service.stop();
      service.adopt(adoptPid, { detail: 'Uygulamanın daha önce başlattığı Lavalink devralındı.' });
      this.logs.add(
        'app',
        'info',
        `Lavalink zaten çalışıyordu (PID ${adoptPid}); uygulama onu yönetmeye devam ediyor.`,
      );
    }
  }

  /** Stops the bot first, then Lavalink. Also cancels a start that is still in progress. */
  async stopAll() {
    if (this.busy === 'stopping') return this.status();
    this.startToken += 1;
    this.busy = 'stopping';
    this.lastError = null;
    this.#emitStatus();
    try {
      await this.botService.stop();
      await this.lavalinkService.stop();
    } finally {
      this.busy = null;
      this.#emitStatus();
    }
    return this.status();
  }

  /** Restarts both (new Lavalink settings also need a fresh bot connection). */
  async restartAll() {
    await this.stopAll();
    return this.startAll();
  }

  async restartBot() {
    await this.botService.stop();
    if (this.lavalinkService.state !== 'ready') return this.startAll();
    await this.botService.start();
    return this.status();
  }

  /** YouTube token was stored in .env by scripts/youtube-token.js. */
  markYoutubeSaved(ok, message) {
    this.refreshEnv();
    this.youtube = { ...this.youtube, phase: ok ? 'saved' : 'error', message };
    this.emit('youtube', { ...this.youtube });
    this.#emitStatus();
  }

  dismissYoutube() {
    this.youtube = { phase: 'idle', code: null, url: null, message: null };
    this.#emitStatus();
  }

  /** Last resort while the app is crashing: kill both trees synchronously. */
  killAllSync(killSync) {
    this.botService.killNow(killSync);
    this.lavalinkService.killNow(killSync);
  }
}

module.exports = { Supervisor, lavalinkFatal, botFatal, BOT_READY, LAVALINK_READY };
