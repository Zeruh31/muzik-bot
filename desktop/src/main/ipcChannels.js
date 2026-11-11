'use strict';

// The only IPC channels the window may use. src/preload/preload.js keeps its own copy
// (a sandboxed preload cannot require local files); test/preload.test.js checks they match.

const INVOKE_CHANNELS = Object.freeze([
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
]);

const EVENT_CHANNELS = Object.freeze([
  'olay:durum',
  'olay:kayit',
  'olay:youtube',
  'olay:indirme',
  'olay:botDurumu',
  'olay:sunucuAyar',
  'olay:sunucuAyarDurum',
]);

module.exports = { INVOKE_CHANNELS, EVENT_CHANNELS };
