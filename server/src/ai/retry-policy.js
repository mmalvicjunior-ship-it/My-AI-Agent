// One bounded retry policy shared by the provider adapters, task executor and
// task runner. The authoritative budget is the total number of provider HTTP
// attempts for one request phase (inspection or planning); tool rounds and
// adapter-local retries consume that budget instead of creating an independent
// retry loop. A successful phase receives a fresh bounded budget for the next
// phase, while failures and recovered tasks keep their consumed state.

export const RETRY_POLICY = Object.freeze({
  maxProviderAttempts: 5,
  maxAdapterAttempts: 3,
  maxRecoveryAttempts: 5,
  interactiveRetryAfterCapMs: 15_000,
  taskRetryAfterCapMs: 24 * 60 * 60 * 1000,
  clientRetryAfterCapMs: 24 * 60 * 60 * 1000,
});

export function normalizeRetryState(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const parsed = Number(raw.attemptsUsed);
  const attemptsUsed = Number.isFinite(parsed)
    ? Math.min(RETRY_POLICY.maxProviderAttempts, Math.max(0, Math.floor(parsed)))
    : 0;
  return {
    attemptsUsed,
    exhausted: Boolean(raw.exhausted) || attemptsUsed >= RETRY_POLICY.maxProviderAttempts,
  };
}

export function remainingProviderAttempts(value) {
  const state = normalizeRetryState(value);
  return state.exhausted ? 0 : RETRY_POLICY.maxProviderAttempts - state.attemptsUsed;
}

export function consumeProviderAttempt(value) {
  const state = normalizeRetryState(value);
  if (state.exhausted) return state;
  const attemptsUsed = state.attemptsUsed + 1;
  return {
    attemptsUsed,
    exhausted: attemptsUsed >= RETRY_POLICY.maxProviderAttempts,
  };
}

export function reportedRetryState(errorOrResult, fallback) {
  const candidate = errorOrResult?.retryState;
  return candidate === undefined || candidate === null
    ? normalizeRetryState(fallback)
    : normalizeRetryState(candidate);
}

export function cappedRetryAfterMs(value, capMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const cap = Number.isFinite(Number(capMs)) && Number(capMs) > 0
    ? Number(capMs)
    : RETRY_POLICY.taskRetryAfterCapMs;
  return Math.min(cap, Math.round(parsed));
}
