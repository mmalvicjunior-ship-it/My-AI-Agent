// Google sign-in: standard OAuth 2.0 authorization-code flow.
//
// The browser is sent to Google's consent screen; Google returns an
// authorization code to this server's callback; this module exchanges the
// code server-to-server and validates the returned identity against Google's
// own tokeninfo endpoint. The client secret is used only here, on the server,
// and is never exposed to the frontend or to browser responses.
import crypto from 'node:crypto';

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const STATE_TTL_MS = 10 * 60 * 1000;

/** Builds the Google consent-screen URL for a one-time `state` value. */
export function googleAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Exchanges the authorization code and validates the returned identity using
 * Google's trusted tokeninfo endpoint. Resolves to { email, sub } or throws
 * with a stable machine-readable `code` (never a raw upstream error).
 */
export async function verifyGoogleIdentity({ code, clientId, clientSecret, redirectUri }) {
  let tokenResponse;
  try {
    tokenResponse = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
  } catch {
    throw Object.assign(new Error('Google sign-in is unavailable right now.'), { code: 'google_unavailable' });
  }
  if (!tokenResponse.ok) {
    throw Object.assign(new Error('Google sign-in is unavailable right now.'), { code: 'google_unavailable' });
  }
  const tokens = await tokenResponse.json().catch(() => null);
  const idToken = tokens && typeof tokens.id_token === 'string' ? tokens.id_token : '';
  if (!idToken) {
    throw Object.assign(new Error('Google did not return an identity token.'), { code: 'google_unavailable' });
  }

  // tokeninfo is Google's own validation endpoint: it checks the signature,
  // expiry and audience, and returns the verified claims.
  let claims;
  try {
    const infoResponse = await fetchWithTimeout(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`);
    if (!infoResponse.ok) {
      throw Object.assign(new Error('Google identity could not be verified.'), { code: 'google_identity_invalid' });
    }
    claims = await infoResponse.json();
  } catch (error) {
    if (error && error.code) throw error;
    throw Object.assign(new Error('Google identity could not be verified.'), { code: 'google_identity_invalid' });
  }

  if (claims.aud !== clientId) {
    throw Object.assign(new Error('Google identity could not be verified.'), { code: 'google_identity_invalid' });
  }
  const issuer = claims.iss;
  if (issuer !== 'accounts.google.com' && issuer !== 'https://accounts.google.com') {
    throw Object.assign(new Error('Google identity could not be verified.'), { code: 'google_identity_invalid' });
  }
  if (String(claims.email_verified) !== 'true') {
    throw Object.assign(new Error('The Google email address is not verified.'), { code: 'google_unverified_email' });
  }
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!email || !sub) {
    throw Object.assign(new Error('Google identity could not be verified.'), { code: 'google_identity_invalid' });
  }
  return { email, sub };
}

/** Small helper so upstream calls can never hang the callback. */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One-time OAuth state: random, stored only as a SHA-256 hash. */
export function createOAuthState() {
  return crypto.randomBytes(32).toString('hex');
}

export { STATE_TTL_MS };
