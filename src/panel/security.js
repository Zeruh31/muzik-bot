// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Web panelinin güvenlik parçaları: rastgele anahtarlar,
// tarayıcı güvenlik başlıkları ve CSRF (başka sitelerin sizin adınıza istek göndermesini) önleme.
// ---------------------------------------------------------------------------------------

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { panel as M } from '../mesajlar.js';

/** URL-safe random token (state, CSRF, generated secrets). */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison; false for missing values or different lengths. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Conservative browser security headers. Everything is served from this origin. */
export function securityHeaders(_req, res, next) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      // Avatars, server icons and track artwork come from Discord / YouTube / Spotify CDNs.
      "img-src 'self' https: data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

/**
 * CSRF protection for state-changing requests (synchronizer token pattern):
 *  1. the request must come from the panel's own origin (Origin, else Referer header),
 *  2. it must carry the per-session token in the X-CSRF-Token header.
 * The token is only readable through a same-origin JSON call (/api/me).
 */
export function requireCsrf(publicOrigin) {
  return (req, res, next) => {
    const origin = req.get('origin') ?? originOf(req.get('referer'));
    if (origin !== publicOrigin) {
      return res.status(403).json({ error: M.kaynakDogrulanamadi });
    }
    if (!safeEqual(req.get('x-csrf-token'), req.session?.csrfToken)) {
      return res.status(403).json({ error: M.csrfGecersiz });
    }
    next();
  };
}

function originOf(url) {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
