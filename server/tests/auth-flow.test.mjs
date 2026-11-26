// Regression coverage for the Google callback/session transitions that used to
// show the login screen again after a successful sign-in. All fetch calls are
// mocked; no provider or network access is used.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  __resetAuthCallbackRunnerForTests,
  bumpAuthEpoch,
  chooseAuthTokenForInitialization,
  createAuthCallbackRunner,
  fragmentHashWithoutSetup,
  googleErrorMessage,
  parseAuthFragment,
  readAuthEpoch,
  shouldClearAuthHash,
  shouldClearSetupHash,
  shouldClearWorkspaceForAuthChange,
  shouldSignOutFor401,
} from '../../apps/web/src/authFlow.js';
import { AUTH_REQUIRED_CODE } from '../../apps/web/src/authResponse.js';

const USER = { id: 'user-new', email: 'new@example.com' };

beforeEach(() => {
  __resetAuthCallbackRunnerForTests();
});

function meFetch({ ok = true, status = 200, user = USER } = {}) {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.match(url, /\/api\/auth\/me$/);
    assert.equal(init.headers.Authorization, 'Bearer fresh-token');
    return {
      ok,
      status,
      json: async () => (ok ? { ok: true, user } : { ok: false, error: 'Authentication required.' }),
    };
  };
  return { fetchImpl, get calls() { return calls; } };
}

test('callback fragment survives verification failure and is cleared only after success', async () => {
  const failed = meFetch({ ok: false, status: 401 });
  const failedEvents = [];
  const failedRunner = createAuthCallbackRunner({
    fetchImpl: failed.fetchImpl,
    onAuthenticated: () => failedEvents.push('authenticated'),
    onError: () => failedEvents.push('error'),
    clearHash: () => failedEvents.push('clear'),
  });

  const failedResult = await failedRunner.run('#auth_token=fresh-token&auth_expires=2030-01-01T00%3A00%3A00.000Z');
  assert.equal(failedResult.status, 'verification_failed');
  assert.deepEqual(failedEvents, ['error']);
  assert.equal(shouldClearAuthHash({ verified: false }), false);

  __resetAuthCallbackRunnerForTests();
  const succeeded = meFetch();
  const successEvents = [];
  const successRunner = createAuthCallbackRunner({
    fetchImpl: succeeded.fetchImpl,
    onAuthenticated: (token, user, expiresAt) => {
      successEvents.push('authenticated');
      assert.equal(token, 'fresh-token');
      assert.equal(user.id, USER.id);
      assert.equal(expiresAt, '2030-01-01T00:00:00.000Z');
    },
    clearHash: () => successEvents.push('clear'),
  });

  const successResult = await successRunner.run('#auth_token=fresh-token&auth_expires=2030-01-01T00%3A00%3A00.000Z');
  assert.equal(successResult.status, 'authenticated');
  assert.deepEqual(successEvents, ['authenticated', 'clear']);
  assert.equal(shouldClearAuthHash({ verified: true }), true);
});

test('StrictMode-style remount verifies and consumes a callback token once', async () => {
  const me = meFetch();
  let authenticated = 0;
  let cleared = 0;
  const runner = createAuthCallbackRunner({
    fetchImpl: me.fetchImpl,
    onAuthenticated: () => { authenticated += 1; },
    clearHash: () => { cleared += 1; },
  });

  const hash = '#auth_token=fresh-token';
  const [first, second] = await Promise.all([runner.run(hash), runner.run(hash)]);
  assert.deepEqual([first.status, second.status].sort(), ['authenticated', 'duplicate']);
  assert.equal(me.calls, 1);
  assert.equal(authenticated, 1);
  assert.equal(cleared, 1);

  const third = await runner.run(hash);
  assert.equal(third.status, 'duplicate');
  assert.equal(me.calls, 1);
});

test('a callback token wins over a stale stored session; refresh keeps the stored token', () => {
  assert.equal(chooseAuthTokenForInitialization({
    callbackToken: 'fresh-token',
    storedToken: 'stale-token',
  }), 'fresh-token');
  assert.equal(chooseAuthTokenForInitialization({
    callbackToken: null,
    storedToken: 'stored-token',
  }), 'stored-token');
  assert.equal(chooseAuthTokenForInitialization({}), null);
  assert.deepEqual(parseAuthFragment(''), {
    present: false, token: null, error: null, expiresAt: null, setup: null,
  });
});

test('a setup fragment is read once and stripped without touching auth callbacks', () => {
  const fragment = parseAuthFragment('#setup=owner-credential');
  assert.deepEqual(fragment, {
    present: false,
    token: null,
    error: null,
    expiresAt: null,
    setup: 'owner-credential',
  });
  assert.equal(shouldClearSetupHash({ setup: fragment.setup, callbackPresent: fragment.present }), true);
  assert.equal(shouldClearSetupHash({ setup: null, callbackPresent: false }), false);
  assert.equal(shouldClearSetupHash({
    setup: 'owner-credential',
    callbackPresent: true,
  }), true, 'the setup credential is stripped even when a callback is present');

  assert.equal(fragmentHashWithoutSetup('#setup=owner-credential'), '');
  assert.equal(
    fragmentHashWithoutSetup('#setup=owner-credential&auth_token=fresh-token&auth_expires=2030-01-01'),
    '#auth_token=fresh-token&auth_expires=2030-01-01',
  );
  assert.equal(fragmentHashWithoutSetup('#auth_token=fresh-token'), null);
});

test('setup, cancellation, account, and server failures have friendly messages', () => {
  for (const code of ['google_setup_required', 'google_setup_invalid']) {
    const message = googleErrorMessage(code);
    assert.match(message, /setup link/i);
    assert.doesNotMatch(message, /undefined|null|token=/i);
  }
  assert.match(googleErrorMessage('google_cancelled'), /cancelled/i);
  assert.match(googleErrorMessage('google_account_exists'), /already exists/i);
  assert.match(googleErrorMessage('google_unverified_email'), /verified email/i);
  for (const code of ['google_not_configured', 'google_unavailable', 'google_identity_invalid', 'unexpected']) {
    assert.match(googleErrorMessage(code), /try again/i);
    assert.doesNotMatch(googleErrorMessage(code), /undefined|null|GOOGLE_/i);
  }
});

test('an OAuth error fragment is shown and consumed without verifying a token', async () => {
  let error = null;
  let cleared = 0;
  let fetched = 0;
  const runner = createAuthCallbackRunner({
    fetchImpl: async () => { fetched += 1; throw new Error('should not fetch'); },
    onError: (message) => { error = message; },
    clearHash: () => { cleared += 1; },
  });

  const result = await runner.run('#auth_error=google_cancelled');
  assert.equal(result.status, 'error');
  assert.equal(error, googleErrorMessage('google_cancelled'));
  assert.equal(cleared, 1);
  assert.equal(fetched, 0);
});

test('a 401 only signs out the token that made the request', () => {
  assert.equal(shouldSignOutFor401({
    status: 401,
    code: AUTH_REQUIRED_CODE,
    url: '/api/projects',
    requestToken: 'old-token',
    currentToken: 'new-token',
  }), false);

  assert.equal(shouldSignOutFor401({
    status: 401,
    code: AUTH_REQUIRED_CODE,
    url: '/api/projects',
    requestToken: 'old-token',
    currentToken: 'old-token',
  }), true);

  // A real session failure on /api/chat still signs out.
  assert.equal(shouldSignOutFor401({
    status: 401,
    code: AUTH_REQUIRED_CODE,
    url: '/api/chat',
    requestToken: 'old-token',
    currentToken: 'old-token',
  }), true);

  // Provider 401/403 and every non-session status leave the session alone.
  assert.equal(shouldSignOutFor401({
    status: 401,
    code: null,
    url: '/api/chat',
    requestToken: 'old-token',
    currentToken: 'old-token',
  }), false);
  assert.equal(shouldSignOutFor401({
    status: 403,
    code: AUTH_REQUIRED_CODE,
    url: '/api/projects',
    requestToken: 'old-token',
    currentToken: 'old-token',
  }), false);
  assert.equal(shouldSignOutFor401({ status: 200, requestToken: 't', currentToken: 't' }), false);
});

test('auth changes reset workspace state; stable accounts do not', () => {
  assert.equal(shouldClearWorkspaceForAuthChange('account-a', 'account-b'), true);
  assert.equal(shouldClearWorkspaceForAuthChange('account-a', 'account-a'), false);
  assert.equal(shouldClearWorkspaceForAuthChange('account-a', null), true);
  assert.equal(shouldClearWorkspaceForAuthChange(null, 'account-a'), true);
  assert.equal(shouldClearWorkspaceForAuthChange(null, null), false);
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => { values.clear(); },
  };
}

function stubMeFetch({ token = 'fresh-token', user = USER, ok = true, status = 200 } = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.match(url, /\/api\/auth\/me$/);
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      return {
        ok,
        status,
        json: async () => (ok ? { ok: true, user } : { ok: false, error: 'Authentication required.' }),
      };
    },
  };
}

test('a consumed callback cannot be replayed after a page reload', async () => {
  const storage = memoryStorage();
  const first = stubMeFetch();
  let applied = 0;
  let settled = 0;
  const runner = createAuthCallbackRunner({
    fetchImpl: first.fetchImpl,
    storage,
    onAuthenticated: () => { applied += 1; },
    onSettled: () => { settled += 1; },
  });
  assert.equal((await runner.run('#auth_token=fresh-token')).status, 'authenticated');
  assert.equal(applied, 1);
  assert.equal(settled, 1);

  // Emulate a reload: module state resets while persisted storage survives.
  __resetAuthCallbackRunnerForTests();
  const replay = stubMeFetch();
  let replayApplied = 0;
  let replayCleared = 0;
  let replaySettled = 0;
  const replayed = createAuthCallbackRunner({
    fetchImpl: replay.fetchImpl,
    storage,
    onAuthenticated: () => { replayApplied += 1; },
    clearHash: () => { replayCleared += 1; },
    onSettled: () => { replaySettled += 1; },
  });
  const result = await replayed.run('#auth_token=fresh-token');
  assert.equal(result.status, 'replay');
  assert.equal(replay.calls, 0);
  assert.equal(replayApplied, 0);
  assert.equal(replayCleared, 1);
  assert.equal(replaySettled, 1);
});

test('a failed callback cannot restore its account after a newer account is selected', async () => {
  const storage = memoryStorage();
  const failed = stubMeFetch({ ok: false, status: 401 });
  const runner = createAuthCallbackRunner({
    fetchImpl: failed.fetchImpl,
    storage,
    getAuthEpoch: () => readAuthEpoch(storage),
    onAuthenticated: () => assert.fail('failed callback was applied'),
  });
  assert.equal((await runner.run('#auth_token=old-token')).status, 'verification_failed');
  assert.equal(failed.calls, 1);
  assert.equal(readAuthEpoch(storage), 0);

  bumpAuthEpoch(storage); // newer account selected before the retry/reload
  __resetAuthCallbackRunnerForTests();
  const stale = stubMeFetch({ token: 'old-token', user: { id: 'account-a' } });
  let applied = 0;
  let cleared = 0;
  let settled = 0;
  const replayed = createAuthCallbackRunner({
    fetchImpl: stale.fetchImpl,
    storage,
    getAuthEpoch: () => readAuthEpoch(storage),
    onAuthenticated: () => { applied += 1; },
    clearHash: () => { cleared += 1; },
    onSettled: () => { settled += 1; },
  });
  const result = await replayed.run('#auth_token=old-token');
  assert.equal(result.status, 'superseded');
  assert.equal(stale.calls, 0);
  assert.equal(applied, 0);
  assert.equal(cleared, 1);
  assert.equal(settled, 1);
});

test('a failed callback retries after its own session cleanup bumps the epoch', async () => {
  const storage = memoryStorage();
  let currentAuth = { token: 'stale-stored', user: { id: 'account-a' } };
  const failed = stubMeFetch({ ok: false, status: 401 });
  const runner = createAuthCallbackRunner({
    fetchImpl: failed.fetchImpl,
    storage,
    getCurrentAuth: () => currentAuth,
    getAuthEpoch: () => readAuthEpoch(storage),
    onError: () => {
      // App.jsx clears a stored session when callback verification fails.
      currentAuth = null;
      bumpAuthEpoch(storage);
    },
    onAuthenticated: () => assert.fail('failed callback was applied'),
  });
  assert.equal((await runner.run('#auth_token=fresh-token')).status, 'verification_failed');
  assert.equal(failed.calls, 1);
  assert.equal(readAuthEpoch(storage), 1);

  __resetAuthCallbackRunnerForTests();
  const retry = stubMeFetch();
  let appliedToken = null;
  const retried = createAuthCallbackRunner({
    fetchImpl: retry.fetchImpl,
    storage,
    getCurrentAuth: () => currentAuth,
    getAuthEpoch: () => readAuthEpoch(storage),
    onAuthenticated: (token) => { appliedToken = token; },
  });
  assert.equal((await retried.run('#auth_token=fresh-token')).status, 'authenticated');
  assert.equal(retry.calls, 1);
  assert.equal(appliedToken, 'fresh-token');
});

test('a newer account selected during callback verification suppresses the result', async () => {
  const storage = memoryStorage();
  let release;
  const gate = new Promise((done) => { release = done; });
  let applied = 0;
  let cleared = 0;
  let settled = 0;
  const runner = createAuthCallbackRunner({
    fetchImpl: async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ ok: true, user: USER }) };
    },
    storage,
    getAuthEpoch: () => readAuthEpoch(storage),
    getCurrentAuth: () => null,
    onAuthenticated: () => { applied += 1; },
    clearHash: () => { cleared += 1; },
    onSettled: () => { settled += 1; },
  });
  const pending = runner.run('#auth_token=old-token');
  bumpAuthEpoch(storage); // another tab selects a newer account while /me is pending
  release();
  const result = await pending;
  assert.equal(result.status, 'superseded');
  assert.equal(applied, 0);
  assert.equal(cleared, 1);
  assert.equal(settled, 1);
});

test('a fresh callback still replaces an older stored session', async () => {
  const storage = memoryStorage();
  const stored = { token: 'stale-stored', user: { id: 'account-a' } };
  const me = stubMeFetch();
  let appliedToken = null;
  const runner = createAuthCallbackRunner({
    fetchImpl: me.fetchImpl,
    storage,
    getCurrentAuth: () => stored,
    getAuthEpoch: () => readAuthEpoch(storage),
    onAuthenticated: (token) => { appliedToken = token; },
  });
  const result = await runner.run('#auth_token=fresh-token');
  assert.equal(result.status, 'authenticated');
  assert.equal(appliedToken, 'fresh-token');
  assert.equal(me.calls, 1);
});

test('the app bumps the shared epoch and wires callback freshness guards', () => {
  const appSource = fs.readFileSync(
    fileURLToPath(new URL('../../apps/web/src/App.jsx', import.meta.url)),
    'utf8',
  );
  assert.match(appSource, /bumpAuthEpoch\(\)/);
  assert.match(appSource, /getCurrentAuth: \(\) => authRef\.current/);
  assert.match(appSource, /getAuthEpoch: \(\) => readAuthEpoch\(\)/);
  assert.match(appSource, /onSettled: \(\) => setAuthChecking\(false\)/);
});
