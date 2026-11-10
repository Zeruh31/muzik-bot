// Bir parçanın ham ses akışının NEREDEN alınacağını bulur. Ses kaynağı Lavalink'teki YouTube
// eklentisinin akış rotasıdır; Spotify gibi eşlenen kaynaklar önce YouTube'da aranır.
// Normalde dokunmana gerek yok.

import { muzik as M } from '../mesajlar.js';
import { ErrorCodes, MusicError } from './errors.js';

/** Sources LavaSrc only mirrors: the track is found on YouTube when it is played. */
export const MIRRORED_SOURCES = new Set(['spotify', 'applemusic', 'deezer', 'yandexmusic', 'tidal', 'qobuz']);

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

/** Lower-case source name of a track ("youtube", "spotify", "soundcloud", ...). */
export function sourceOf(track) {
  return String(track?.info?.sourceName ?? '').toLowerCase();
}

/** Whether the bot can play this track at all (YouTube, or a source mirrored to YouTube). */
export function isStreamable(track) {
  const source = sourceOf(track);
  return (source === 'youtube' && Boolean(track?.info?.identifier)) || MIRRORED_SOURCES.has(source);
}

/** Throws SOURCE_UNSUPPORTED for a track the bot cannot play, so it is refused before queueing. */
export function assertStreamable(track) {
  if (!isStreamable(track)) {
    throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, M.kaynakDesteklenmiyor(sourceOf(track) || '?'));
  }
}

/**
 * Picks the YouTube video that will be streamed for `track`:
 *  - YouTube tracks: the video id itself;
 *  - mirrored sources (Spotify, ...): the first YouTube search hit for the ISRC, then title + artist.
 *    The pick is remembered on the track (`track.mirror`) so seeks, filter changes and recoveries
 *    keep playing the very same video; it is also shown to users ("Şimdi çalıyor", panel).
 *  - anything else (SoundCloud, Bandcamp, ...): not streamable yet -> SOURCE_UNSUPPORTED.
 * @param {object} track Lavalink track object
 * @param {{ loadTracks(identifier: string): Promise<{ loadType: string, tracks: object[] }> }} rest
 * @returns {Promise<{ videoId: string, mirrored: object|null }>} mirrored = the YouTube track used
 */
export async function resolveStreamSource(track, rest) {
  const info = track?.info ?? {};
  const source = sourceOf(track);
  if (source === 'youtube' && info.identifier) return { videoId: info.identifier, mirrored: null };

  if (MIRRORED_SOURCES.has(source)) {
    if (track.mirror?.videoId) return { videoId: track.mirror.videoId, mirrored: track.mirror.track ?? null };
    for (const query of mirrorQueries(track)) {
      const result = await rest.loadTracks(query);
      const hit = (result.tracks ?? []).find((t) => t.info?.sourceName === 'youtube' && t.info?.identifier);
      if (hit) {
        track.mirror = {
          videoId: hit.info.identifier,
          title: hit.info.title ?? null,
          author: hit.info.author ?? null,
          uri: hit.info.uri ?? null,
          duration: Number.isFinite(hit.info.duration) ? hit.info.duration : 0,
          track: hit,
        };
        return { videoId: hit.info.identifier, mirrored: hit };
      }
    }
    throw new MusicError(ErrorCodes.LOAD_FAILED, M.youtubeEslesmesiYok);
  }

  throw new MusicError(ErrorCodes.SOURCE_UNSUPPORTED, M.kaynakDesteklenmiyor(source || '?'));
}
