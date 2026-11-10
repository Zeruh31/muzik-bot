'use strict';

/**
 * Links may only leave the app to https sites or to the bot's local web panel
 * (http://127.0.0.1). Everything else (file:, javascript:, other http hosts) is refused.
 */
function isSafeExternalUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && url.hostname === '127.0.0.1';
}

module.exports = { isSafeExternalUrl };
