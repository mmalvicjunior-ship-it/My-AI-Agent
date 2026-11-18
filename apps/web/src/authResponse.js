/**
 * Decides whether a 401 response means the *user's session* is invalid.
 *
 * Not every 401 belongs to the account layer: the chat endpoint relays the AI
 * provider's status, and an upstream provider with a missing or rejected API
 * key answers 401. Treating that as an expired session used to sign the user
 * out mid-conversation, which looked like a redirect back to the login screen.
 *
 * The server marks real session failures with `code: 'AUTH_REQUIRED'`. The
 * path check keeps older servers (which omit the code) from signing the user
 * out when only the chat provider rejected its own credentials.
 */
export const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';

export function isSessionExpiredResponse({ status, code, url } = {}) {
  if (status !== 401) return false;
  if (code === AUTH_REQUIRED_CODE) return true;
  const path = String(url || '');
  // /api/chat can carry a provider 401; every other API 401 is a session 401.
  const isChatRequest = /\/api\/chat(?:[/?#]|$)/.test(path);
  return !isChatRequest;
}
