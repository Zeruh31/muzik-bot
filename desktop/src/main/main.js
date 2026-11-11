'use strict';

// Electron main process: window, tray, IPC and wiring of the process supervisor.

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  dialog,
  clipboard,
  nativeImage,
  protocol,
  session,
} = require('electron');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { Supervisor } = require('./supervisor');
const { LogStore } = require('./logStore');
const { SettingsStore } = require('./settingsStore');
const { startWatchdog } = require('./watchdogClient');
const winproc = require('./winproc');
const { findJava, findExecutable, parseJavaMajor, buildScriptLaunch } = require('./launchers');
const { resolveProjectDir, validateProjectDir } = require('./projectPaths');
const { parseEnvDocument, envKeys, keyComments } = require('./envFile');
const { planEnvSave, writeFileAtomic, hashText } = require('./envStore');
const { GROUPS, FIELDS, restartNeeds } = require('./envSchema');
const { parseKontrolOutput, summarizeScript } = require('./toolOutput');
const { redact } = require('./logLine');
const { downloadVerified, LAVALINK_URL, LAVALINK_SHA256, LAVALINK_VERSION } = require('./downloader');
const { isSafeExternalUrl } = require('./externalUrl');
const { INVOKE_CHANNELS } = require('./ipcChannels');
const { createStatusWatcher } = require('./botStatus');
const { createServerConfigWatcher, validateChange, writeRequest, waitForAnswer } = require('./serverConfig');

const APP_ORIGIN = 'app://muzik';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', '..', 'assets');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  // Server icons and the bot avatar come from Discord's CDN; nothing else is loaded from outside.
  "img-src 'self' data: https://cdn.discordapp.com",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const STATIC_FILES = {
  '/': { file: path.join(RENDERER_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: path.join(RENDERER_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/app.js': { file: path.join(RENDERER_DIR, 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: path.join(RENDERER_DIR, 'styles.css'), type: 'text/css; charset=utf-8' },
  '/serverList.js': { file: path.join(RENDERER_DIR, 'serverList.js'), type: 'text/javascript; charset=utf-8' },
  '/serverSettings.js': {
    file: path.join(RENDERER_DIR, 'serverSettings.js'),
    type: 'text/javascript; charset=utf-8',
  },
  '/icon.png': { file: path.join(ASSETS_DIR, 'icon.png'), type: 'image/png' },
};

// Tests and power users can keep this instance's data apart (it also separates the
// single-instance lock, which Electron ties to the user-data folder).
if (process.env.MUZIKBOT_DESKTOP_USERDATA) app.setPath('userData', path.resolve(process.env.MUZIKBOT_DESKTOP_USERDATA));

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  const userData = app.getPath('userData');
  const settings = new SettingsStore(path.join(userData, 'ayarlar.json'));
  const logDir = path.join(userData, 'kayitlar');
  const logs = new LogStore({ dir: logDir });
  const startHidden = process.argv.includes('--gizli');

  let mainWindow = null;
  let tray = null;
  let quitting = false;
  let lastStatus = null;

  const appLog = (level, text) => logs.add('app', level, text);

  // ---- child-process guard ----------------------------------------------------------
  const watchdog = startWatchdog({
    execPath: findExecutable('node.exe', process.env),
    onLog: (msg) => appLog('warn', msg),
  });

  // ---- project folder ---------------------------------------------------------------
  let projectDir = null;
  const projectDirFor = (saved) =>
    resolveProjectDir({
      override: process.env.MUZIKBOT_PROJECT_DIR,
      saved,
      appPath: app.isPackaged ? null : app.getAppPath(),
      portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
      exeDir: path.dirname(process.execPath),
    });
  const refreshProjectDir = () => {
    projectDir = projectDirFor(settings.get('projectDir'));
    return projectDir;
  };
  refreshProjectDir();

  // ---- runtimes -----------------------------------------------------------------------
  const versionCache = new Map();
  async function versionOf(exe, args, parse) {
    if (!exe) return { path: null, major: null };
    const hit = versionCache.get(exe);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const result = await winproc.run(exe, args, { timeoutMs: 20_000, encoding: 'utf8' });
    const value = { path: exe, major: parse(`${result.stderr}\n${result.stdout}`) };
    versionCache.set(exe, { at: Date.now(), value });
    return value;
  }
  const resolveJava = () => versionOf(findJava(process.env), ['-version'], parseJavaMajor);
  const resolveNode = () =>
    versionOf(findExecutable('node.exe', process.env), ['-v'], (text) => Number(/v(\d+)\./.exec(text)?.[1]) || null);

  // ---- supervisor -------------------------------------------------------------------
  const supervisor = new Supervisor({
    getProjectDir: () => projectDir,
    logs,
    autoRestart: () => settings.get('autoRestart'),
    watchdog,
    pidFile: path.join(userData, 'surecler.json'),
    deps: {
      spawn: childProcess.spawn,
      sendCtrlC: winproc.sendCtrlC,
      killTree: winproc.killTree,
      isAlive: winproc.isAlive,
      isPortInUse: (port) => winproc.isPortInUse(port),
      findListeningPids: winproc.findListeningPids,
      processName: winproc.processName,
      processCommandLine: winproc.processCommandLine,
      listProcesses: winproc.listProcesses,
      resolveJava,
      resolveNode,
    },
  });

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  supervisor.on('status', (status) => {
    lastStatus = status;
    send('olay:durum', status);
    updateTray();
  });
  supervisor.on('youtube', (youtube) => {
    send('olay:youtube', youtube);
    if (youtube.phase === 'success') saveYoutubeToken({ automatic: true });
    if (youtube.phase === 'code' && mainWindow && !mainWindow.isVisible()) showWindow();
  });

  let pendingEntries = [];
  let entryTimer = null;
  logs.onEntry((entry) => {
    pendingEntries.push(entry);
    if (entryTimer) return;
    entryTimer = setTimeout(() => {
      entryTimer = null;
      const batch = pendingEntries;
      pendingEntries = [];
      send('olay:kayit', batch);
    }, 150);
  });

  appLog('info', `Uygulama açıldı (sürüm ${app.getVersion()}). Proje klasörü: ${projectDir ?? 'bulunamadı'}`);

  // ---- data/durum.json (Sunucular, İstatistikler) ---------------------------------------
  // PIDs of bots this app saw exit: their data is "last known" at once, without waiting 60 s.
  const stoppedBotPids = new Set();
  const statusWatcher = createStatusWatcher({
    getProjectDir: () => projectDir,
    onChange: (snapshot) => send('olay:botDurumu', snapshot),
    isAlive: winproc.isAlive,
    stoppedPids: stoppedBotPids,
  });
  let lastBotPid = null;
  supervisor.on('status', (s) => {
    if (s.bot.pid) lastBotPid = s.bot.pid;
    if (!s.bot.pid && lastBotPid) {
      stoppedBotPids.add(lastBotPid);
      lastBotPid = null;
      send('olay:botDurumu', statusWatcher.snapshot());
    }
  });
  statusWatcher.start();
  // "Stale" depends on the clock too (no update for 60 s), so re-send now and then.
  setInterval(() => send('olay:botDurumu', statusWatcher.snapshot()), 10_000).unref();

  // ---- server settings (data/sunucu-yapisi.json, ayar-semasi.json, ayarlar-gorunum.json) ----------------
  const configWatcher = createServerConfigWatcher({
    getProjectDir: () => projectDir,
    onChange: () => send('olay:sunucuAyar', { at: Date.now() }),
  });
  configWatcher.start();
  const MAX_PENDING_SAVES = 4;
  let pendingSaves = 0;

  /** Saves one setting through the bot (data/istekler -> data/yanitlar); see serverConfig.js. */
  async function saveServerSetting(payload) {
    if (!projectDir) return { ok: false, hata: 'Proje klasörü bulunamadı.' };
    // A request is never left waiting for a bot that is off: it would apply by surprise later.
    if (statusWatcher.snapshot().stale) {
      return { ok: false, botKapali: true, hata: 'Bot kapalı; ayarlar bot açıkken uygulanır.' };
    }
    const { schema } = configWatcher.snapshot();
    const checked = validateChange(payload, { schema, guildOf: configWatcher.guildStructure });
    if (!checked.ok) return checked;
    if (pendingSaves >= MAX_PENDING_SAVES)
      return { ok: false, hata: 'Önceki kayıtlar bekleniyor; biraz sonra deneyin.' };
    pendingSaves += 1;
    try {
      const id = writeRequest(projectDir, checked.istek);
      const { guildId, modul, alan } = checked.istek;
      // The bot has claimed it: it will be applied, so the window says "uygulanıyor" until the answer comes.
      const answer = await waitForAnswer(projectDir, id, {
        onProgress: (durum) => send('olay:sunucuAyarDurum', { guildId, modul, alan, durum }),
      });
      const name = `${checked.istek.modul}.${checked.istek.alan}`;
      appLog(answer.ok ? 'info' : 'warn', `Sunucu ayarı ${name}: ${answer.ok ? 'kaydedildi' : answer.hata}`);
      return answer;
    } catch (error) {
      return { ok: false, hata: `İstek yazılamadı: ${error.message}` };
    } finally {
      pendingSaves -= 1;
    }
  }

  // ---- helper scripts -----------------------------------------------------------------
  async function runScript(script, args = []) {
    if (!projectDir) return { code: -1, stdout: '', stderr: 'HATA: Proje klasörü bulunamadı.' };
    const node = await resolveNode();
    if (!node.path) return { code: -1, stdout: '', stderr: 'HATA: Node.js bulunamadı.' };
    const launch = buildScriptLaunch({ projectDir, baseEnv: process.env, nodePath: node.path, script, args });
    const result = await winproc.runCollect(launch.command, launch.args, { cwd: launch.cwd, env: launch.env });
    const secrets = supervisor.secrets;
    return { code: result.code, stdout: redact(result.stdout, secrets), stderr: redact(result.stderr, secrets) };
  }

  let youtubeSaving = null;
  function saveYoutubeToken({ automatic = false } = {}) {
    if (youtubeSaving) return youtubeSaving;
    youtubeSaving = (async () => {
      // Give Lavalink a moment to write the token line into lavalink/logs.
      if (automatic) await new Promise((r) => setTimeout(r, 1500));
      let result = await runScript('youtube-token.js');
      if (result.code !== 0 && automatic) {
        await new Promise((r) => setTimeout(r, 3000));
        result = await runScript('youtube-token.js');
      }
      const summary = summarizeScript(result.code, '', result.stderr);
      const ok = result.code === 0;
      const message = ok
        ? "YouTube girişi kaydedildi. Lavalink'i yeniden başlatınca artık kod sorulmayacak."
        : `Token kaydedilemedi: ${summary.message}`;
      appLog(ok ? 'info' : 'error', message);
      supervisor.markYoutubeSaved(ok, message);
      return { ok, message };
    })().finally(() => {
      youtubeSaving = null;
    });
    return youtubeSaving;
  }

  // ---- .env form --------------------------------------------------------------------
  const envPath = () => (projectDir ? path.join(projectDir, '.env') : null);

  function readEnvForm() {
    const file = envPath();
    const exists = Boolean(file && fs.existsSync(file));
    const text = exists ? fs.readFileSync(file, 'utf8') : '';
    const doc = parseEnvDocument(text);
    const values = {};
    for (const entry of doc.entries) values[entry.key] = entry.value;
    // Keys the form does not know (in .env or in a newer .env.example) are still shown,
    // described by their comment in .env.example.
    const examplePath = path.join(projectDir ?? '', '.env.example');
    const exampleText = projectDir && fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
    const extraKeys = [...new Set([...envKeys(text), ...envKeys(exampleText)])].filter((key) => !FIELDS.has(key));
    const comments = { ...keyComments(exampleText) };
    for (const [key, comment] of Object.entries(keyComments(text))) comments[key] ??= comment;
    const extraHelp = Object.fromEntries(extraKeys.map((key) => [key, comments[key] ?? '']));
    return { exists, path: file, groups: GROUPS, values, extraKeys, extraHelp, revision: hashText(text) };
  }

  const readExample = () => {
    const file = projectDir ? path.join(projectDir, '.env.example') : null;
    return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };

  /**
   * payload: { changes, base, revision, force }. `base` and `revision` describe the file as
   * the form loaded it; see envStore.planEnvSave for the merge and conflict rules.
   */
  function saveEnvForm(payload) {
    const file = envPath();
    if (!file) return { ok: false, errors: { _: 'Proje klasörü bulunamadı.' } };
    if (!payload || typeof payload !== 'object' || !payload.changes || typeof payload.changes !== 'object') {
      return { ok: false, errors: { _: 'Geçersiz istek.' } };
    }
    const exists = fs.existsSync(file);
    // Re-read right before writing: youtube-token.js or an editor may have changed it.
    const currentText = exists ? fs.readFileSync(file, 'utf8') : readExample();
    const externallyChanged =
      exists && typeof payload.revision === 'string' && payload.revision !== hashText(currentText);
    let plan;
    try {
      plan = planEnvSave({
        currentText,
        exampleText: readExample(),
        changes: payload.changes,
        base: payload.base ?? {},
      });
    } catch (error) {
      return { ok: false, errors: { [error.key ?? '_']: error.message } };
    }
    if (!plan.ok) return { ok: false, errors: plan.errors };
    if (plan.conflicts.length && !payload.force) {
      return { ok: false, conflict: true, conflictKeys: plan.conflicts, errors: {} };
    }
    if (!plan.changed.length && exists)
      return { ok: true, changed: [], merged: externallyChanged, restart: { lavalink: false, bot: false } };

    writeFileAtomic(file, plan.nextText);
    supervisor.refreshEnv();
    const needs = restartNeeds(plan.changed);
    const status = supervisor.status();
    const running = (s) => s.state !== 'stopped' && s.state !== 'error';
    appLog(
      'info',
      `Ayarlar kaydedildi: ${plan.changed.join(', ')}${externallyChanged ? ' (dosya dışarıda da değişmişti, birleştirildi)' : ''}`,
    );
    return {
      ok: true,
      changed: plan.changed,
      merged: externallyChanged,
      restart: { lavalink: needs.lavalink && running(status.lavalink), bot: needs.bot && running(status.bot) },
    };
  }

  // ---- app options ------------------------------------------------------------------
  const loginExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

  function appOptions() {
    return {
      ...settings.all(),
      projectDir,
      projectValid: Boolean(projectDir),
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      dataDir: userData,
      logDir,
    };
  }

  function saveAppOptions(patch) {
    const allowed = {};
    for (const key of ['autoStartBot', 'openAtLogin', 'autoRestart']) {
      if (typeof patch?.[key] === 'boolean') allowed[key] = patch[key];
    }
    if ('openAtLogin' in allowed) {
      if (!app.isPackaged) {
        delete allowed.openAtLogin;
      } else {
        app.setLoginItemSettings({ openAtLogin: allowed.openAtLogin, path: loginExe(), args: ['--gizli'] });
      }
    }
    settings.set(allowed);
    return appOptions();
  }

  /**
   * Switches the project folder. Does nothing when the folder in use would not change;
   * asks before stopping a running bot.
   */
  async function changeProjectDir(saved, resulting) {
    const same = (a, b) => (a ? path.resolve(a).toLowerCase() : null) === (b ? path.resolve(b).toLowerCase() : null);
    if (same(resulting, projectDir)) {
      if (resulting && !same(settings.get('projectDir'), saved)) settings.set({ projectDir: saved });
      return { ok: true, unchanged: true, options: appOptions() };
    }
    if (supervisor.isRunning() || supervisor.busy) {
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Durdur ve değiştir', 'Vazgeç'],
        defaultId: 1,
        cancelId: 1,
        title: 'Proje klasörü',
        message: 'Bot şu an çalışıyor.',
        detail: 'Proje klasörünü değiştirmek için bot ve Lavalink durdurulacak. Devam edilsin mi?',
      });
      if (answer.response !== 0) return { ok: false, canceled: true, options: appOptions() };
      await supervisor.stopAll();
    }
    settings.set({ projectDir: saved });
    refreshProjectDir();
    supervisor.refreshEnv();
    statusWatcher.refresh();
    configWatcher.refresh();
    appLog('info', `Proje klasörü: ${projectDir ?? 'bulunamadı'}`);
    supervisor.checkConflicts();
    return { ok: Boolean(projectDir), options: appOptions() };
  }

  // ---- IPC ----------------------------------------------------------------------------
  // Node's URL reports origin "null" for custom schemes, so compare scheme and host.
  const isTrustedSender = (event) => {
    try {
      const url = new URL(event.senderFrame?.url ?? '');
      return url.protocol === 'app:' && url.host === 'muzik';
    } catch {
      return false;
    }
  };
  const handlers = {
    'durum:al': () => supervisor.status(),
    'botDurumu:al': () => statusWatcher.snapshot(),
    'servis:baslat': (options) => supervisor.startAll({ takeOver: options?.takeOver === true }),
    'servis:vazgec': () => {
      supervisor.clearConflict();
      return supervisor.status();
    },
    'servis:durdur': () => supervisor.stopAll(),
    'servis:yenidenBaslat': (target) => (target === 'bot' ? supervisor.restartBot() : supervisor.restartAll()),
    'kayit:al': () => logs.query({}).slice(-3000),
    'kayit:klasorAc': async () => {
      fs.mkdirSync(logDir, { recursive: true });
      return (await shell.openPath(logDir)) === '';
    },
    'kayit:temizle': () => {
      logs.clear();
      return true;
    },
    'env:oku': () => readEnvForm(),
    'env:kaydet': (payload) => saveEnvForm(payload),
    'env:gizliUret': () => crypto.randomBytes(32).toString('base64url'),
    'uygulama:ayarlar': () => appOptions(),
    'uygulama:ayarKaydet': (patch) => saveAppOptions(patch),
    'proje:sec': async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Müzik Bot klasörünü seçin',
        properties: ['openDirectory'],
        defaultPath: projectDir ?? undefined,
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, options: appOptions() };
      const chosen = path.resolve(result.filePaths[0]);
      const check = validateProjectDir(chosen);
      if (!check.ok) {
        return {
          ok: false,
          message: `Bu klasör Müzik Bot klasörü gibi görünmüyor (${check.problems.join(', ')}). İçinde package.json ve src\\index.js olan klasörü seçin.`,
          options: appOptions(),
        };
      }
      return changeProjectDir(chosen, chosen);
    },
    'proje:varsayilan': async () => changeProjectDir(null, projectDirFor(null)),
    'arac:komutKaydet': async () => {
      const result = await runScript('deploy-commands.js');
      const summary = summarizeScript(result.code, result.stdout, result.stderr);
      appLog(summary.ok ? 'info' : 'error', `Komut kaydı: ${summary.message}`);
      return { ...summary, output: `${result.stdout}${result.stderr}`.trim() };
    },
    'arac:kontrol': async () => {
      const result = await runScript('kontrol.js');
      return { ...parseKontrolOutput(result.stdout), code: result.code, error: result.code < 0 ? result.stderr : null };
    },
    'arac:lavalinkIndir': async () => {
      if (!projectDir) return { ok: false, message: 'Proje klasörü bulunamadı.' };
      const dest = path.join(projectDir, 'lavalink', 'Lavalink.jar');
      const lavalinkState = supervisor.status().lavalink.state;
      try {
        const result = await downloadVerified({
          url: LAVALINK_URL,
          dest,
          sha256: LAVALINK_SHA256,
          onProgress: (p) => send('olay:indirme', p),
          // Never replace the jar of a running Lavalink.
          ...(lavalinkState !== 'stopped' && lavalinkState !== 'error' && fs.existsSync(dest)
            ? {
                fetchImpl: () =>
                  Promise.reject(new Error("Lavalink çalışırken dosya değiştirilemez. Önce Durdur'a basın.")),
              }
            : {}),
        });
        const message =
          result.status === 'present'
            ? `Lavalink ${LAVALINK_VERSION} zaten indirilmiş ve doğrulanmış.`
            : `Lavalink ${LAVALINK_VERSION} indirildi ve SHA-256 ile doğrulandı.`;
        appLog('info', message);
        return { ok: true, message };
      } catch (error) {
        const message = `İndirme başarısız: ${error.message}`;
        appLog('error', message);
        return { ok: false, message };
      }
    },
    'arac:youtubeToken': () => saveYoutubeToken(),
    'youtube:kapat': () => {
      supervisor.dismissYoutube();
      return true;
    },
    'dis:ac': async (url) => {
      if (!isSafeExternalUrl(url)) return false;
      await shell.openExternal(String(url));
      return true;
    },
    'sunucuAyar:al': (guildId) => configWatcher.guildView(String(guildId ?? '')),
    'sunucuAyar:kaydet': (payload) => saveServerSetting(payload),
    'pano:kopyala': (text) => {
      clipboard.writeText(String(text ?? '').slice(0, 2_000_000));
      return true;
    },
  };
  for (const channel of INVOKE_CHANNELS) {
    const fn = handlers[channel];
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error('İzin verilmeyen kaynak.');
      return fn(...args);
    });
  }

  // ---- window -----------------------------------------------------------------------
  function iconImage(name) {
    return nativeImage.createFromPath(path.join(ASSETS_DIR, name));
  }

  function showWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow(true);
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function createWindow(show) {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 920,
      minHeight: 620,
      show: false,
      title: 'Müzik Bot',
      backgroundColor: '#0e1016',
      icon: iconImage('icon.png'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    mainWindow.removeMenu();
    mainWindow.once('ready-to-show', () => {
      if (show) mainWindow.show();
    });
    mainWindow.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      mainWindow.hide();
      if (!settings.get('trayNoticeShown') && tray) {
        tray.displayBalloon({
          title: 'Müzik Bot arka planda çalışıyor',
          content:
            'Pencere kapandı ama bot çalışmaya devam ediyor. Simgeye çift tıklayarak açabilir, sağ tıklayıp Çıkış diyerek kapatabilirsiniz.',
          iconType: 'info',
        });
        settings.set({ trayNoticeShown: true });
      }
    });
    mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }

  // ---- tray -------------------------------------------------------------------------
  function updateTray() {
    if (!tray) return;
    const status = lastStatus ?? supervisor.status();
    const running = status.running;
    const panelOpen = status.panel.state === 'open';
    const botLabel =
      { ready: 'çevrimiçi', starting: 'bağlanıyor', error: 'hata', restarting: 'yeniden başlatılacak' }[
        status.bot.state
      ] ?? 'kapalı';
    tray.setToolTip(`Müzik Bot: ${botLabel}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Göster', click: showWindow },
        { type: 'separator' },
        {
          // While Lavalink is starting, Durdur cancels the start.
          label: running || status.busy === 'starting' ? 'Durdur' : 'Başlat',
          enabled: status.busy !== 'stopping',
          click: async () => {
            if (running || status.busy === 'starting') return supervisor.stopAll();
            const result = await supervisor.startAll();
            if (result.conflict) showWindow(); // the window asks what to do
            return result;
          },
        },
        {
          label: 'Paneli aç',
          enabled: panelOpen && isSafeExternalUrl(status.panel.url),
          click: () => shell.openExternal(status.panel.url),
        },
        { type: 'separator' },
        { label: 'Çıkış', click: () => quitApp() },
      ]),
    );
  }

  function createTray() {
    tray = new Tray(iconImage('tray.png'));
    tray.on('double-click', showWindow);
    tray.on('click', showWindow);
    updateTray();
  }

  // ---- quitting -----------------------------------------------------------------------
  let shutdownPromise = null;
  function shutdown() {
    shutdownPromise ??= (async () => {
      quitting = true;
      appLog('info', 'Uygulama kapanıyor; bot ve Lavalink durduruluyor...');
      const timeout = new Promise((resolve) => setTimeout(resolve, 45_000));
      await Promise.race([supervisor.stopAll().catch(() => {}), timeout]);
      supervisor.killAllSync(winproc.killTreeSync); // anything left after the timeout
      logs.flush();
      watchdog.quit();
    })();
    return shutdownPromise;
  }

  function quitApp() {
    shutdown().finally(() => app.exit(0));
  }

  app.on('before-quit', (event) => {
    event.preventDefault();
    quitApp();
  });

  process.on('uncaughtException', (error) => {
    try {
      appLog('error', `Beklenmeyen hata: ${error?.stack ?? error}`);
      logs.flush();
    } catch {
      // ignore
    }
  });

  app.on('second-instance', () => showWindow());
  app.on('window-all-closed', () => {
    // Stay in the tray.
  });

  // ---- security: no navigation, no new windows, no permissions --------------------------
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) setImmediate(() => shell.openExternal(url));
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.muzikbot.masaustu');
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      const entry = url.host === 'muzik' ? STATIC_FILES[url.pathname] : null;
      if (!entry) return new Response('Bulunamadı', { status: 404 });
      const body = await fs.promises.readFile(entry.file);
      return new Response(body, {
        headers: {
          'content-type': entry.type,
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    });

    if (app.isPackaged && settings.get('openAtLogin')) {
      // Keep the Run entry pointing at the current exe (portable copies can move).
      app.setLoginItemSettings({ openAtLogin: true, path: loginExe(), args: ['--gizli'] });
    }

    createTray();
    createWindow(!startHidden);
    // Another copy of the bot (e.g. "npm start" in a window)? Autostart then only warns.
    supervisor.checkConflicts().then(() => {
      if (settings.get('autoStartBot') && projectDir) supervisor.startAll({ auto: true });
    });
  });
}
