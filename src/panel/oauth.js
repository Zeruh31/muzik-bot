// ---------------------------------------------------------------------------------------
// BURAYA DOKUNMANA GEREK YOK. Web paneline "Discord ile giriş" bu dosyayla yapılır.
// ---------------------------------------------------------------------------------------

// Minimal Discord OAuth2 (authorization code grant) client built on fetch.
// Docs: https://discord.com/developers/docs/topics/oauth2

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const API = 'https://discord.com/api/v10';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const REVOKE_URL = 'https://discord.com/api/oauth2/token/revoke';
export const OAUTH_SCOPES = ['identify', 'guilds'];

export class OAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OAuthError';
    this.status = status;
  }
}

/**
 * @param {{ clientId: string, clientSecret: string, redirectUri: string, fetchImpl?: typeof fetch }} options
 */
export function createDiscordOAuth({ clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const basicAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  async function call(url, init) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!response.ok)
      throw new OAuthError(`Discord ${response.status} döndü (${new URL(url).pathname})`, response.status);
    return response.status === 204 ? null : response.json();
  }

  return {
    redirectUri,

    /** URL the browser is sent to. `state` must be random and stored in the session. */
    authorizeUrl(state) {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        scope: OAUTH_SCOPES.join(' '),
        state,
        redirect_uri: redirectUri,
        prompt: 'none',
      });
      return `${AUTHORIZE_URL}?${params}`;
    },

    /** Exchanges the callback `code` for tokens (form-urlencoded, as Discord requires). */
    exchangeCode(code) {
      return call(TOKEN_URL, {
        method: 'POST',
        headers: { Authorization: basicAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      });
    },

    fetchUser(accessToken) {
      return call(`${API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    },

    fetchGuilds(accessToken) {
      return call(`${API}/users/@me/guilds`, { headers: { Authorization: `Bearer ${accessToken}` } });
    },

    /** Best effort: invalidates the token at Discord on logout. */
    async revoke(accessToken) {
      await call(REVOKE_URL, {
        method: 'POST',
        headers: { Authorization: basicAuth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }),
      });
    },
  };
}
