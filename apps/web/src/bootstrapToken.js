// One-time first-account bootstrap token handling.
//
// The token travels in the URL fragment (#bootstrap=<token>) instead of the
// query string: fragments are never sent to any server, so they cannot appear
// in Vercel, proxy, CDN, or application logs, and they are never included in
// Referer headers. The value is read here, injected into the registration
// request body only, and then removed from the address bar; it is never
// persisted anywhere else.

/**
 * Extracts and trims the bootstrap token from a URL fragment.
 * Returns '' when the fragment is absent or carries no bootstrap token.
 */
export function extractBootstrapToken(fragment) {
  if (typeof fragment !== 'string') return '';
  const search = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  // A leading '?' means the caller passed the query string; the token is
  // only ever accepted via the URL fragment.
  if (!search || search.startsWith('?')) return '';
  const token = new URLSearchParams(search).get('bootstrap');
  return token ? token.trim() : '';
}
