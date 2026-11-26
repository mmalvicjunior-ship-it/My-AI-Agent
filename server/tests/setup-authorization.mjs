// Test helper for the first-account setup gate.
//
// The production browser flow exchanges the dedicated owner setup credential
// for a short-lived opaque authorization before registering. Tests use the
// same public endpoints instead of reaching into the database, so the gate is
// exercised end to end. These values are synthetic tokens installed by
// setup-test-env.mjs and are distinct from the administrator token.
import assert from 'node:assert/strict';

export const TEST_BOOTSTRAP_TOKEN = 'test-bootstrap-token';
export const TEST_SETUP_CREDENTIAL = 'test-first-account-setup-token';

/**
 * Returns a fresh setup authorization only while the deployment is waiting for
 * its first account. Later registrations intentionally receive `null` and
 * follow the normal ALLOW_REGISTRATION policy.
 *
 * `force` exists for tests that assert how the setup endpoint behaves after a
 * first account already exists.
 */
export async function authorizeFirstAccount(base, { setupCredential = TEST_SETUP_CREDENTIAL, force = false } = {}) {
  if (!force) {
    const statusResponse = await fetch(`${base}/api/auth/setup/status`);
    const status = await statusResponse.json().catch(() => null);
    assert.equal(statusResponse.status, 200, 'setup status must be publicly readable');
    assert.equal(status?.ok, true);
    if (status.required === false) return null;
  }

  const response = await fetch(`${base}/api/auth/setup/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupCredential }),
  });
  const data = await response.json().catch(() => null);
  assert.equal(response.status, 200, `setup authorization failed: HTTP ${response.status}`);
  assert.equal(data?.ok, true);
  assert.ok(typeof data.setupToken === 'string' && data.setupToken, 'server returns an opaque setup authorization');
  return data.setupToken;
}

/** Convenience wrapper for the common `request(method, path, { body })` shape. */
export async function registerWithSetup(base, body, request) {
  const setupToken = await authorizeFirstAccount(base);
  const requestBody = setupToken ? { ...body, setupToken } : body;
  return request('POST', '/api/auth/register', { body: requestBody });
}
