'use strict';

// Search and sort for the "Sunucular" tab. Loaded by the window as a plain script
// (window.serverList) and by the tests through require().
(function (root) {
  const fold = (text) => String(text ?? '').toLocaleLowerCase('tr');

  /** Servers whose name contains the query (Turkish case rules), all when the query is empty. */
  function filterServers(servers, query) {
    const needle = fold(query).trim();
    if (!needle) return [...servers];
    return servers.filter((s) => fold(s.name).includes(needle));
  }

  const SORTS = {
    name: (a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }),
    members: (a, b) => b.memberCount - a.memberCount,
    joined: (a, b) => (b.joinedAt ?? 0) - (a.joinedAt ?? 0),
    songs: (a, b) => b.songsPlayed - a.songsPlayed,
  };

  /** Sorted copy. Ties fall back to the name so the order is stable. */
  function sortServers(servers, key = 'name') {
    const compare = SORTS[key] ?? SORTS.name;
    return [...servers].sort((a, b) => compare(a, b) || SORTS.name(a, b));
  }

  /** Up to two initials for servers without an icon ("Müzik Kulübü" -> "MK"). */
  function initials(name) {
    const words = String(name ?? '')
      .trim()
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w));
    return (
      words
        .slice(0, 2)
        .map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, '')][0] ?? '')
        .join('')
        .toLocaleUpperCase('tr') || '?'
    );
  }

  const api = { filterServers, sortServers, initials };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.serverList = api;
})(typeof window === 'undefined' ? globalThis : window);
