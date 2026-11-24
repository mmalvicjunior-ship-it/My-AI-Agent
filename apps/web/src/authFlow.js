// Pure auth-transition helpers shared by the React app and the server test
// runner. Keeping these rules free of React/browser APIs lets the session and
// Google-callback regressions run with the existing node:test suite.

import { isSessionExpiredResponse } from './authResponse.js';

export const GOOGLE_ERRORS = {
  google_not_configured: 'Google sign-in is temporarily unavailable. Please try again later.',
  google_registration_disabled: 'New accounts are not being accepted right now. Please contact your administrator.',
  google_account_exists: 'An account with this email already exists. Sign in with your password instead.',
  google_identity_conflict: 'That Google account is already associated with a different account. Please contact support.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_state: 'That sign-in link has expired. Please try again.',
  google_unverified_email: 'Please use a Google account with a verified email address.',
  google_unavailable: 'Google sign-in is unavailable right now. Please try again later.',
  google_identity_invalid: 'Google sign-in could not be completed. Please try again.',
};

export function googleErrorMessage(code) {
  return GOOGLE_ERRORS[code] || 'Google sign-in could not be completed. Please try again.';
}

/** Reads the Google callback fragment without consuming it. */
export function parseAuthFragment(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  if (!raw || raw.length < 2) {
    return { present: false, token: null, error: null, expiresAt: null };
  }
  const params = new URLSearchParams(raw.startsWith('#') ? raw.slice(1) : raw);
  const token = params.get('auth_token') || null;
  const error = params.get('auth_error') || null;
  const expiresAt = params.get('auth_expires') || null;
  return { present: Boolean(token || error), token, error, expiresAt };
}

/**
 * A successful Google callback always wins over a token left in storage by
 * another session. With no callback, a refresh restores the stored token.
 */
export function chooseAuthTokenForInitialization({ callbackToken, storedToken } = {}) {
  return callbackToken || storedToken || null;
}

/**
 * A 401 may only clear the session that actually made the request. Otherwise a
 * slow response from an old token can sign out the newer Google session.
 */
export function shouldSignOutFor401({
  status,
  code,
  url,
  requestToken,
  currentToken,
} = {}) {
  if (status !== 401) return false;
  if (!requestToken || currentToken !== requestToken) return false;
  return isSessionExpiredResponse({ status, code, url });
}

/** The callback fragment is only stripped after a token error or verified auth. */
export function shouldClearAuthHash({ verified, error } = {}) {
  return Boolean(verified || error);
}

/** Switching to or away from an account must reset workspace-scoped UI state. */
export function shouldClearWorkspaceForAuthChange(previousUserId, nextUserId) {
  return previousUserId !== nextUserId;
}

/**
 * A renewal result may only be applied if the account/token and transition
 * generation are unchanged. This is what makes sign-out or account switching
 * during an in-flight renewal safe.
 */
export function shouldApplyRenewalResult({
  result = null,
  generationAtStart = 0,
  currentGeneration = 0,
  requestToken = null,
  currentToken = null,
} = {}) {
  if (!result || result.status === 'in_flight' || result.status === 'superseded' || result.status === 'no_token') return false;
  if (generationAtStart !== currentGeneration) return false;
  return Boolean(requestToken) && currentToken === requestToken;
}

/**
 * Renews the existing DB-backed session through the already-public /api/auth/me
 * endpoint. This is not a new token system: the same bearer token is verified,
 * and the server extends its already-bounded expiry. The single-flight guard
 * prevents repeated requests on browser refresh/StrictMode, and the identity
 * check prevents a response for another account from restoring its workspace.
 */
export async function renewExistingSession({
  token,
  expectedUserId = null,
  apiBase = '',
  endpoint = '/api/auth/me',
  fetchImpl = globalThis.fetch,
  state = null,
} = {}) {
  if (typeof token !== 'string' || !token) return { status: 'no_token' };
  const guard = state || {};
  if (guard.inFlightToken === token) return { status: 'in_flight' };
  if (guard.inFlightToken) return { status: 'superseded' };
  guard.inFlightToken = token;
  try {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // A network failure keeps the stored session for a later user-initiated
      // retry; it must never trigger an automatic refresh loop.
      return { status: 'unavailable' };
    }
    if (response.status === 401) return { status: 'invalid', reason: 'auth_required' };
    let data = null;
    try {
      data = await response.json();
    } catch {
      return { status: 'unavailable' };
    }
    if (!response.ok || !data?.ok || !data.user) return { status: 'unavailable' };
    if (expectedUserId !== null && expectedUserId !== undefined
      && data.user.id !== null && data.user.id !== undefined
      && String(expectedUserId) !== String(data.user.id)) {
      return { status: 'invalid', reason: 'identity_mismatch' };
    }
    return {
      status: 'authenticated',
      user: data.user,
      expiresAt: data.expiresAt ?? undefined,
      absoluteExpiresAt: data.absoluteExpiresAt ?? undefined,
    };
  } finally {
    guard.inFlightToken = null;
  }
}

// Module-level dedupe keeps React StrictMode's development remount from
// verifying/consuming the same one-time callback token twice. It is reset only
// by a full page load or by the exported test helper.
const completedCallbackKeys = new Set();
let activeCallbackKey = null;

export function __resetAuthCallbackRunnerForTests() {
  completedCallbackKeys.clear();
  activeCallbackKey = null;
}

/**
 * Verifies a Google callback token before the hash is removed and applies it
 * exactly once. Verification failures keep the fragment so a refresh can retry
 * instead of leaving the user on a stale stored session.
 */
export function createAuthCallbackRunner({
  apiBase = '',
  fetchImpl = globalThis.fetch,
  onAuthenticated = () => {},
  onError = () => {},
  clearHash = () => {},
  getTransitionGeneration = () => 0,
} = {}) {
  return {
    async run(hash) {
      const callback = parseAuthFragment(hash);
      if (!callback.present) return { status: 'absent' };

      const key = callback.error
        ? `error:${callback.error}`
        : `token:${callback.token}`;
      if (activeCallbackKey || completedCallbackKeys.has(key)) {
        return { status: 'duplicate' };
      }
      activeCallbackKey = key;
      const transitionGeneration = getTransitionGeneration();

      try {
        if (callback.error) {
          if (getTransitionGeneration() !== transitionGeneration) return { status: 'stale' };
          onError(googleErrorMessage(callback.error));
          if (shouldClearAuthHash({ error: callback.error })) clearHash();
          completedCallbackKeys.add(key);
          return { status: 'error' };
        }

        let response;
        let data = null;
        try {
          response = await fetchImpl(`${apiBase}/api/auth/me`, {
            headers: { Authorization: `Bearer ${callback.token}` },
          });
          data = await response.json().catch(() => null);
        } catch {
          onError('Could not verify the Google session.');
          return { status: 'verification_failed' };
        }

        if (getTransitionGeneration() !== transitionGeneration) return { status: 'stale' };
        if (!response.ok || !data?.ok || !data.user) {
          onError('Could not verify the Google session.');
          return { status: 'verification_failed' };
        }

        onAuthenticated(callback.token, data.user, callback.expiresAt ?? undefined);
        if (shouldClearAuthHash({ verified: true })) clearHash();
        completedCallbackKeys.add(key);
        return { status: 'authenticated' };
      } finally {
        activeCallbackKey = null;
      }
    },
  };
}
