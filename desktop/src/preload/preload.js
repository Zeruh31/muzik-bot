'use strict';

// Sandboxed preload: exposes a small, fixed API to the window. Only the channels listed
// here can be used (kept in sync with src/main/ipcChannels.js by test/preload.test.js).

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = [
  'durum:al',
  'botDurumu:al',
  'servis:baslat',
  'servis:durdur',
  'servis:vazgec',
  'servis:yenidenBaslat',
  'kayit:al',
  'kayit:klasorAc',
  'kayit:temizle',
  'env:oku',
  'env:kaydet',
  'env:gizliUret',
  'uygulama:ayarlar',
  'uygulama:ayarKaydet',
  'proje:sec',
  'proje:varsayilan',
  'arac:komutKaydet',
  'arac:kontrol',
  'arac:lavalinkIndir',
  'arac:youtubeToken',
  'youtube:kapat',
  'dis:ac',
  'pano:kopyala',
  'sunucuAyar:al',
  'sunucuAyar:kaydet',
  'sesliKomut:durum',
  'sesliKomut:kur',
  'sesliKomut:iptal',
  'sesliKomut:kaldir',
];
const EVENT_CHANNELS = [
  'olay:durum',
  'olay:kayit',
  'olay:youtube',
  'olay:indirme',
  'olay:botDurumu',
  'olay:sunucuAyar',
  'olay:sunucuAyarDurum',
  'olay:sesliKomut',
];

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.includes(channel)) return Promise.reject(new Error(`İzin verilmeyen kanal: ${channel}`));
  return ipcRenderer.invoke(channel, ...args);
}

/** Subscribes to a main-process event; returns an unsubscribe function. */
function on(channel, callback) {
  if (!EVENT_CHANNELS.includes(channel) || typeof callback !== 'function') {
    throw new Error(`İzin verilmeyen olay: ${channel}`);
  }
  // Never hand the raw IpcRendererEvent (it exposes `sender`) to the page.
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('muzik', {
  status: () => invoke('durum:al'),
  botStatus: () => invoke('botDurumu:al'),
  start: (options) => invoke('servis:baslat', { takeOver: options?.takeOver === true }),
  dismissConflict: () => invoke('servis:vazgec'),
  stop: () => invoke('servis:durdur'),
  restart: (target) => invoke('servis:yenidenBaslat', target === 'bot' ? 'bot' : 'hepsi'),
  logs: () => invoke('kayit:al'),
  openLogFolder: () => invoke('kayit:klasorAc'),
  clearLogs: () => invoke('kayit:temizle'),
  readEnv: () => invoke('env:oku'),
  saveEnv: (payload) => invoke('env:kaydet', payload),
  generateSecret: () => invoke('env:gizliUret'),
  appOptions: () => invoke('uygulama:ayarlar'),
  saveAppOptions: (patch) => invoke('uygulama:ayarKaydet', patch),
  chooseProject: () => invoke('proje:sec'),
  resetProject: () => invoke('proje:varsayilan'),
  deployCommands: () => invoke('arac:komutKaydet'),
  checkSetup: () => invoke('arac:kontrol'),
  downloadLavalink: () => invoke('arac:lavalinkIndir'),
  saveYoutubeToken: () => invoke('arac:youtubeToken'),
  dismissYoutube: () => invoke('youtube:kapat'),
  openExternal: (url) => invoke('dis:ac', String(url)),
  copy: (text) => invoke('pano:kopyala', String(text)),
  serverSettings: (guildId) => invoke('sunucuAyar:al', String(guildId)),
  // Voice command component: the window only picks "gpu" or "cpu"; the main process builds every path.
  voiceStatus: () => invoke('sesliKomut:durum'),
  installVoice: (profile) => invoke('sesliKomut:kur', profile === 'gpu' ? 'gpu' : 'cpu'),
  cancelVoiceInstall: () => invoke('sesliKomut:iptal'),
  removeVoice: () => invoke('sesliKomut:kaldir'),
  // Only these four fields reach the main process, which checks them against the bot's schema.
  saveServerSetting: (change) =>
    invoke('sunucuAyar:kaydet', {
      guildId: String(change?.guildId ?? ''),
      modul: String(change?.modul ?? ''),
      alan: String(change?.alan ?? ''),
      deger: change?.deger ?? null,
    }),
  on,
});
