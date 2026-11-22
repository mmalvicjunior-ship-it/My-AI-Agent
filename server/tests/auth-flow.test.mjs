// Regression coverage for the Google callback/session transitions that used to
// show the login screen again after a successful sign-in. All fetch calls are
// mocked; no provider or network access is used.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetAuthCallbackRunnerForTests,
  chooseAuthTokenForInitialization,
  createAuthCallbackRunner,
  googleErrorMessage,
  parseAuthFragment,
  shouldClearAuthHash,
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
    present: false, token: null, error: null, expiresAt: null,
  });
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
