// Bir parçanın ham ses akışının NEREDEN alınacağını bulur:
//  - YouTube: Lavalink'teki YouTube eklentisinin akış rotası (Spotify gibi eşlenen kaynaklar önce
//    YouTube'da aranır);
//  - SoundCloud: SoundCloud'un verdiği HLS/MP3 adresi (src/music/soundcloud.js);
//  - doğrudan ses bağlantıları: bağlantının kendisi (src/music/directLink.js).
// Normalde dokunmana gerek yok.

import { muzik as M } from '../mesajlar.js';
import { ErrorCodes, MusicError } from './errors.js';

/** Sources LavaSrc only mirrors: the track is found on YouTube when it is played. */
export const MIRRORED_SOURCES = new Set(['spotify', 'applemusic', 'deezer', 'yandexmusic', 'tidal', 'qobuz']);

const HTTP_URI = /^https?:\/\//i;

/**
 * YouTube searches that find the mirrored track, most precise first. Same idea as
 * lavasrc.providers in application.yml: the ISRC, then "title artist".
 */
export function mirrorQueries(track) {
  const info = track?.info ?? {};
  const queries = [];
  if (info.isrc) queries.push(`ytsearch:"${info.isrc}"`);
  const text = [info.title, info.author].filter(Boolean).join(' ').trim();
  if (text) queries.push(`ytsearch:${text}`);
  return queries;
}

/** Lower-case source name of a track ("youtube", "spotify", "soundcloud", "http", ...). */
export function sourceOf(track) {
  return String(track?.info?.sourceName ?? '').toLowerCase();
}

/** Whether a track is a live stream (no end, no seeking, no crossfade, no prefetch). */
export function isLive(track) {
  return Boolean(track?.info?.isStream);
}

/**
 * Why the bot cannot play a track (Turkish), or null when it can:
 *  - YouTube videos (not live streams: youtube-plugin's stream route cannot serve them, see
 *    README > Bilinen sınırlar), sources mirrored to YouTube (Spotify, ...);
 *  - SoundCloud tracks and direct audio links (http/https);
 *  - anything else (Bandcamp, Twitch, Vimeo, ...) is not supported.
 */
export function unsupportedReason(track) {
  const source = sourceOf(track);
  const info = track?.info ?? {};
  if (source === 'youtube') {
    if (!info.identifier) return M.kaynakDesteklenmiyor('youtube');
    return isLive(track) ? M.youtubeCanliDesteklenmiyor : null;
  }
  if (MIRRORED_SOURCES.has(source)) return null;
  if ((source === 'soundcloud' || source === 'http') && HTTP_URI.test(String(info.uri ?? ''))) return null;
  return M.kaynakDesteklenmiyor(source || '?');
}

/** Whether the bot can play this track at all. */
export function isStreamable(track) {
  return unsupportedReason(track) === null;
}

/** Throws SOURCE_UNSUPPORTED for a track the bot cannot play, so it is refused before queueing. */
export function assertStreamable(track) {
  const reason = unsupportedReason(track);
  if (reason) throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, reason);
}

/**
 * Decides where the audio of `track` comes from:
 *  - { kind: 'youtube', videoId, mirrored }: youtube-plugin's REST stream of that video
 *    (mirrored = the YouTube track a Spotify & co. track is played with, else null). The pick of a
 *    mirrored track is remembered on it (`track.mirror`) so seeks, filter changes and recoveries
 *    keep playing the very same video; it is also shown to users ("Şimdi çalıyor", panel);
 *  - { kind: 'url', url }: an https address ffmpeg opens itself (SoundCloud HLS/MP3);
 *  - { kind: 'http', url, live }: a direct link the bot downloads safely and pipes to ffmpeg.
 * @param {object} track track object
 * @param {{ loadTracks(identifier: string): Promise<{ loadType: string, tracks: object[] }> }} rest
 * @param {{ soundcloud?: { streamUrl(track): Promise<{ url: string }> } }} [sources]
 */
export async function resolveStreamSource(track, rest, { soundcloud } = {}) {
  const info = track?.info ?? {};
  const source = sourceOf(track);
  const reason = unsupportedReason(track);
  if (reason) throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, reason);

  if (source === 'youtube') return { kind: 'youtube', videoId: info.identifier, mirrored: null };
  if (source === 'soundcloud') {
    if (!soundcloud) throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, M.kaynakDesteklenmiyor('soundcloud'));
    const { url } = await soundcloud.streamUrl(track);
    return { kind: 'url', url };
  }
  if (source === 'http') return { kind: 'http', url: info.uri, live: isLive(track) };

  // Mirrored sources (Spotify, ...): the first YouTube hit for the ISRC, then title + artist.
  if (track.mirror?.videoId) {
    return { kind: 'youtube', videoId: track.mirror.videoId, mirrored: track.mirror.track ?? null };
  }
  for (const query of mirrorQueries(track)) {
    const result = await rest.loadTracks(query);
    const hit = (result.tracks ?? []).find(
      (t) => t.info?.sourceName === 'youtube' && t.info?.identifier && !t.info?.isStream,
    );
    if (hit) {
      track.mirror = {
        videoId: hit.info.identifier,
        title: hit.info.title ?? null,
        author: hit.info.author ?? null,
        uri: hit.info.uri ?? null,
        duration: Number.isFinite(hit.info.duration) ? hit.info.duration : 0,
        track: hit,
      };
      return { kind: 'youtube', videoId: hit.info.identifier, mirrored: hit };
    }
  }
  throw new MusicError(ErrorCodes.LOAD_FAILED, M.youtubeEslesmesiYok);
}
