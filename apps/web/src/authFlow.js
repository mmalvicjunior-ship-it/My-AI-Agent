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
  google_setup_required: 'This deployment is waiting for its first account. Open the owner-provided setup link and try again.',
  google_setup_invalid: 'The setup authorization is invalid or has expired. Open the owner-provided setup link again.',
};

export function googleErrorMessage(code) {
  return GOOGLE_ERRORS[code] || 'Google sign-in could not be completed. Please try again.';
}

/**
 * Reads the fragment without consuming it. `setup` is the owner-supplied
 * first-account credential: it is returned to the caller in memory only, is
 * never used as an auth callback, and is stripped from the URL as soon as it
 * is read. It is not the administrator provisioning token.
 */
export function parseAuthFragment(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  if (!raw || raw.length < 2) {
    return { present: false, token: null, error: null, expiresAt: null, setup: null };
  }
  const params = new URLSearchParams(raw.startsWith('#') ? raw.slice(1) : raw);
  const token = params.get('auth_token') || null;
  const error = params.get('auth_error') || null;
  const expiresAt = params.get('auth_expires') || null;
  const setup = params.get('setup') || null;
  return { present: Boolean(token || error), token, error, expiresAt, setup };
}

/** A setup credential is removed immediately, even alongside a callback. */
export function shouldClearSetupHash({ setup } = {}) {
  return Boolean(setup);
}

/**
 * Returns the replacement hash with only `setup` removed. `null` means the
 * current hash has no setup credential and must be left completely untouched.
 */
export function fragmentHashWithoutSetup(hash) {
  const raw = typeof hash === 'string' ? hash : '';
  if (!raw) return null;
  const params = new URLSearchParams(raw.startsWith('#') ? raw.slice(1) : raw);
  if (!params.has('setup')) return null;
  params.delete('setup');
  const remaining = params.toString();
  return remaining ? `#${remaining}` : '';
}

/** Removes only a setup fragment, leaving callback fragments for the runner. */
export function stripSetupHash() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  const replacement = fragmentHashWithoutSetup(window.location.hash);
  if (replacement === null) return;
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${window.location.search}${replacement}`,
  );
}

/**
 * Reads and strips the setup fragment at module load, before React renders.
 * This minimizes the time the owner credential is visible in the address bar.
 */
export function readInitialAuthFragment() {
  const hash = typeof window === 'undefined' ? '' : window.location.hash;
  const fragment = parseAuthFragment(hash);
  if (shouldClearSetupHash(fragment)) stripSetupHash();
  return fragment;
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
// verifying/consuming the same one-time callback token twice. A persisted
// digest extends that protection across reloads and tabs; the raw callback
// token is never stored in this separate key.
const completedCallbackKeys = new Set();
let activeCallbackKey = null;

const CONSUMED_CALLBACKS_KEY = 'myai.auth.consumed-callbacks.v1';
const CALLBACK_EPOCHS_KEY = 'myai.auth.callback-epochs.v1';
const AUTH_EPOCH_KEY = 'myai.auth.epoch.v1';
const MAX_CONSUMED_CALLBACKS = 24;

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

const fallbackStorage = (() => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
  };
})();

function resolveStorage(storage) {
  return storage || browserStorage() || fallbackStorage;
}

function callbackStorageKey(key) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `v1.${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}

function readConsumedCallbacks(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(CONSUMED_CALLBACKS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function hasConsumedCallback(storage, key) {
  return readConsumedCallbacks(storage).includes(callbackStorageKey(key));
}

function markCallbackConsumed(storage, key) {
  try {
    const digest = callbackStorageKey(key);
    const keys = readConsumedCallbacks(storage).filter((item) => item !== digest);
    keys.push(digest);
    storage.setItem(CONSUMED_CALLBACKS_KEY, JSON.stringify(keys.slice(-MAX_CONSUMED_CALLBACKS)));
    const seen = readCallbackEpochs(storage);
    delete seen[digest];
    storage.setItem(CALLBACK_EPOCHS_KEY, JSON.stringify(seen));
  } catch {
    /* Storage may be unavailable; the in-memory set still covers this page. */
  }
}

// A callback that fails verification deliberately keeps its fragment so a
// refresh can retry. Remembering the account-selection epoch of the first
// attempt lets a later reload detect that a newer account was chosen in the
// meantime and discard the old fragment instead of restoring its account.
function readCallbackEpochs(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(CALLBACK_EPOCHS_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function recordCallbackSeen(storage, digest, epoch, { force = false } = {}) {
  try {
    const seen = readCallbackEpochs(storage);
    if (force || !Number.isSafeInteger(seen[digest])) seen[digest] = epoch;
    storage.setItem(CALLBACK_EPOCHS_KEY, JSON.stringify(seen));
  } catch {
    /* Retry-on-refresh still works from the in-memory state. */
  }
}

function authIdentity(auth) {
  if (!auth) return '';
  return `${auth.user?.id ?? ''}:${auth.token ?? ''}`;
}

/** Monotonic account-selection epoch shared by all tabs on this origin. */
export function readAuthEpoch(storage) {
  const store = resolveStorage(storage);
  try {
    const value = Number(store.getItem(AUTH_EPOCH_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Called only when the selected account/token actually changes. */
export function bumpAuthEpoch(storage) {
  const store = resolveStorage(storage);
  const next = readAuthEpoch(store) + 1;
  try {
    store.setItem(AUTH_EPOCH_KEY, String(next));
  } catch {
    /* Private browsing still has the in-page generation guard. */
  }
  return next;
}

export function __resetAuthCallbackRunnerForTests() {
  completedCallbackKeys.clear();
  activeCallbackKey = null;
  fallbackStorage.clear();
}

/**
 * Verifies a Google callback token before the hash is removed and applies it
 * exactly once. A replayed fragment, a newer selected account, or a changed
 * cross-tab auth epoch all discard it without restoring the older session.
 * Verification failures keep the fragment so a refresh can retry instead of
 * leaving the user on a stale stored session.
 */
export function createAuthCallbackRunner({
  apiBase = '',
  fetchImpl = globalThis.fetch,
  onAuthenticated = () => {},
  onError = () => {},
  onSettled = () => {},
  clearHash = () => {},
  storage = null,
  getCurrentAuth = () => null,
  getTransitionGeneration = () => 0,
  getAuthEpoch = null,
} = {}) {
  const store = resolveStorage(storage);
  const epochOf = getAuthEpoch || (() => readAuthEpoch(store));

  return {
    async run(hash) {
      let ownsKey = false;
      try {
        const callback = parseAuthFragment(hash);
        if (!callback.present) return { status: 'absent' };

        const key = callback.error
          ? `error:${callback.error}`
          : `token:${callback.token}`;
        if (activeCallbackKey || completedCallbackKeys.has(key)) {
          return { status: 'duplicate' };
        }
        // A page reload resets the module set. The persisted digest prevents an
        // old-but-still-valid fragment from being replayed after another account
        // has been selected.
        if (hasConsumedCallback(store, key)) {
          clearHash();
          return { status: 'replay' };
        }

        activeCallbackKey = key;
        ownsKey = true;
        const transitionGeneration = getTransitionGeneration();
        const epochAtStart = epochOf();
        const digest = callbackStorageKey(key);
        const seenEpoch = readCallbackEpochs(store)[digest];
        const authAtStart = authIdentity(getCurrentAuth());
        recordCallbackSeen(store, digest, epochAtStart);
        // Superseded means newer account state appeared after this callback was
        // first observed. An older stored session present at the start is
        // exactly what a fresh callback is meant to replace.
        const isSuperseded = () => epochOf() !== epochAtStart
          || authIdentity(getCurrentAuth()) !== authAtStart
          || (Number.isSafeInteger(seenEpoch) && seenEpoch !== epochAtStart);
        const discardSuperseded = () => {
          clearHash();
          completedCallbackKeys.add(key);
          markCallbackConsumed(store, key);
        };
        // onError clears a stored session when one exists, which bumps the
        // shared epoch. That transition belongs to this failed callback, not
        // to a newer account selection, so a refresh must still be able to
        // retry the same fragment.
        const failVerification = () => {
          onError('Could not verify the Google session.');
          recordCallbackSeen(store, digest, epochOf(), { force: true });
          return { status: 'verification_failed' };
        };

        if (callback.error) {
          if (getTransitionGeneration() !== transitionGeneration) return { status: 'stale' };
          if (epochOf() !== epochAtStart || isSuperseded()) {
            discardSuperseded();
            return { status: 'superseded' };
          }
          onError(googleErrorMessage(callback.error));
          if (shouldClearAuthHash({ error: callback.error })) clearHash();
          completedCallbackKeys.add(key);
          markCallbackConsumed(store, key);
          return { status: 'error' };
        }

        if (isSuperseded()) {
          discardSuperseded();
          return { status: 'superseded' };
        }

        let response;
        let data = null;
        try {
          response = await fetchImpl(`${apiBase}/api/auth/me`, {
            headers: { Authorization: `Bearer ${callback.token}` },
          });
          data = await response.json().catch(() => null);
        } catch {
          return failVerification();
        }

        // Keep the existing in-page generation guard first: its stale result
        // intentionally leaves the fragment for the newer sign-in to consume.
        if (getTransitionGeneration() !== transitionGeneration) return { status: 'stale' };
        if (epochOf() !== epochAtStart || isSuperseded()) {
          discardSuperseded();
          return { status: 'superseded' };
        }
        if (!response.ok || !data?.ok || !data.user) {
          return failVerification();
        }

        onAuthenticated(callback.token, data.user, callback.expiresAt ?? undefined);
        if (shouldClearAuthHash({ verified: true })) clearHash();
        completedCallbackKeys.add(key);
        markCallbackConsumed(store, key);
        return { status: 'authenticated' };
      } finally {
        if (ownsKey) activeCallbackKey = null;
        onSettled();
      }
    },
  };
}
