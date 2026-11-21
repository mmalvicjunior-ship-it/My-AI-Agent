import { isFallbackEligibleProviderError } from './provider-error.js';

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

  return {
    name: primary.name,
    displayName: primary.displayName,
    model: primary.model,
    ...(typeof primary.supportsTools === 'boolean'
      ? { supportsTools: primary.supportsTools }
      : {}),

    async chat(args) {
      try {
        return await primary.chat(args);
      } catch (error) {
        const reason = error?.category || error?.errorType || 'UNKNOWN_ERROR';
        const cancelled = args?.signal?.aborted
          || error?.name === 'AbortError'
          || error?.statusCode === 499;
        const toolsAlreadyRan = Array.isArray(error?.toolActivity)
          && error.toolActivity.length > 0;

        if (cancelled || toolsAlreadyRan || !isFallbackEligibleProviderError(error)) {
          throw error;
        }

        log.warn?.(
          `[fallback] primary=${primary.name} model=${primary.model ?? 'unknown'} `
          + `reason=${reason} alternative=${fallback.name} model=${fallback.model ?? 'unknown'}`,
        );

        try {
          const result = await fallback.chat(args);
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
          fallbackError.fallbackFrom = primary.name;
          fallbackError.fallbackReason = reason;
          fallbackError.fallbackAttempted = true;
          throw fallbackError;
        }
      }
    },
  };
}
