'use strict';

// Watches Lavalink output for the YouTube OAuth device flow (youtube-plugin):
//   "OAUTH INTEGRATION: To give youtube-source access to your account, go to
//    https://www.google.com/device and enter code XXX-XXX-XXX"
//   "Token retrieved successfully"

const DEVICE_URL = 'https://www.google.com/device';
const CODE_LINE = /google\.com\/device\b.*?\benter (?:the )?code\s+([A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6}){1,3})\b/i;
const SUCCESS_LINE = /Token retrieved successfully/i;

/**
 * @returns {{ type: 'code', code: string, url: string } | { type: 'success' } | null}
 */
function detectYoutubeAuth(line) {
  const text = String(line ?? '');
  const code = CODE_LINE.exec(text);
  if (code) return { type: 'code', code: code[1].toUpperCase(), url: DEVICE_URL };
  if (SUCCESS_LINE.test(text)) return { type: 'success' };
  return null;
}

module.exports = { detectYoutubeAuth, DEVICE_URL };
