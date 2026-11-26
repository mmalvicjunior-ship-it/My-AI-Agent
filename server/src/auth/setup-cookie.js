// HttpOnly cookie helpers for the first-account Google retry authorization.
// The cookie carries only a random handle. It is scoped to /api/auth so it is
// never attached to static assets or sent to JavaScript, and it has no Domain
// attribute so the same-origin Vercel /api/* rewrite works unchanged.
import { SETUP_RETRY_COOKIE } from './setup.js';

export { SETUP_RETRY_COOKIE };

/**
 * Express derives req.secure from the encrypted socket plus X-Forwarded-Proto
 * only when the immediate peer is trusted by app.set('trust proxy'). That makes
 * this the request's trusted HTTPS state, not a client-supplied header value.
 */
export function secureCookieForRequest(req) {
  return Boolean(req?.secure);
}

function options({ secure }) {
  return {
    httpOnly: true,
    secure: Boolean(secure),
    sameSite: 'lax',
    path: '/api/auth',
  };
}

export function setSetupRetryCookie(res, handle, { expiresAt, secure }) {
  const expiryMs = Date.parse(expiresAt);
  const safeExpiry = Number.isFinite(expiryMs) ? expiryMs : Date.now();
  res.cookie(SETUP_RETRY_COOKIE, handle, {
    ...options({ secure }),
    expires: new Date(safeExpiry),
    maxAge: Math.max(0, safeExpiry - Date.now()),
  });
}

export function clearSetupRetryCookie(res, { secure }) {
  res.clearCookie(SETUP_RETRY_COOKIE, options({ secure }));
}

/** Reads the raw handle without making it available to browser JavaScript. */
export function readSetupRetryCookie(req) {
  const header = req?.headers?.cookie;
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SETUP_RETRY_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return '';
}
