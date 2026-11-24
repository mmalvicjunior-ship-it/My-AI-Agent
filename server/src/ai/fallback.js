import { isFallbackEligibleProviderError } from './provider-error.js';
import {
  consumeProviderAttempt,
  normalizeRetryState,
  reportedRetryState,
} from './retry-policy.js';

/**
 * Wraps a preferred provider with one explicit alternative provider.
 *
 * Fallback is deliberately narrow: only recognised quota/availability/network
 * failures before any tool has run. Cancellation, invalid credentials,
 * malformed requests and failures after tool execution are never retried
 * through the alternative provider.
 */
export function createFallbackProvider({ primary, fallback, log = console }) {
  if (!primary || typeof primary.chat !== 'function') return primary;
  if (!fallback || typeof fallback.chat !== 'function') return primary;

  function attachRetryState(value, retryState) {
    if (!value || typeof value !== 'object') return value;
    value.retryState = normalizeRetryState(retryState);
    if (value.retryState.exhausted) {
      value.retryBudgetExhausted = true;
      value.retryable = false;
      value.fallbackEligible = false;
    }
    return value;
  }

  return {
    name: primary.name,
    displayName: primary.displayName,
    model: primary.model,
    ...(typeof primary.supportsTools === 'boolean'
      ? { supportsTools: primary.supportsTools }
      : {}),

    async chat(args) {
      // When the task executor supplies retryState it owns the shared budget.
      // The wrapper must thread the primary's consumed state into the fallback
      // so one executor call cannot make two uncounted provider attempts.
      const callerOwnsRetries = args?.retryState !== undefined && args?.retryState !== null;

      try {
        return await primary.chat(args);
      } catch (error) {
        const reason = error?.category || error?.errorType || 'UNKNOWN_ERROR';
        const cancelled = args?.signal?.aborted
          || error?.name === 'AbortError'
          || error?.statusCode === 499;
        const toolsAlreadyRan = Array.isArray(error?.toolActivity)
          && error.toolActivity.length > 0;

        // A cooldown short-circuit makes no HTTP request and consumes no shared
        // attempt. Other failures default to one consumed attempt only when the
        // adapter did not report its own state.
        const primaryState = callerOwnsRetries
          ? reportedRetryState(
            error,
            error?.providerCooldownShortCircuit === true
              ? normalizeRetryState(args.retryState)
              : consumeProviderAttempt(normalizeRetryState(args.retryState)),
          )
          : null;
        if (primaryState) attachRetryState(error, primaryState);

        if (cancelled || toolsAlreadyRan || !isFallbackEligibleProviderError(error)) {
          throw error;
        }

        // An exhausted state must never trigger another provider HTTP request.
        if (primaryState?.exhausted) {
          if (error && typeof error === 'object') {
            error.retryBudgetExhausted = true;
            error.fallbackEligible = false;
          }
          throw error;
        }

        log.warn?.(
          `[fallback] primary=${primary.name} model=${primary.model ?? 'unknown'} `
          + `reason=${reason} alternative=${fallback.name} model=${fallback.model ?? 'unknown'}`,
        );

        const fallbackArgs = callerOwnsRetries
          ? { ...args, retryState: normalizeRetryState(primaryState) }
          : args;

        try {
          const result = await fallback.chat(fallbackArgs);
          if (callerOwnsRetries) {
            const finalState = reportedRetryState(
              result,
              consumeProviderAttempt(primaryState),
            );
            attachRetryState(result, finalState);
          }
          return {
            ...result,
            fallback: {
              from: primary.name,
              fromModel: primary.model ?? null,
              reason,
              retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null,
            },
          };
        } catch (fallbackError) {
          if (callerOwnsRetries) {
            const finalState = reportedRetryState(
              fallbackError,
              consumeProviderAttempt(primaryState),
            );
            attachRetryState(fallbackError, finalState);
          }
          fallbackError.fallbackFrom = primary.name;
          fallbackError.fallbackReason = reason;
          fallbackError.fallbackAttempted = true;
          throw fallbackError;
        }
      }
    },
  };
}
