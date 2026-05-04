/**
 * bridge-retry — provider-agnostic auto-retry for detached bridge workers.
 *
 * Wraps a single-attempt runFn (returns askSession result) with at most one
 * automatic retry when the failure is classified as RECOVERABLE (transient
 * provider fault). Fresh session per attempt — no message-history carry-over.
 *
 * Cap: 2 total attempts (attempt 0 + 1 retry). Cap is in-memory only;
 * dispatch-persist stores no attempt counter, so a supervisor restart
 * resets the attempt index to startAttempt (caller-supplied).
 */

// Safety envelope: 2 total attempts (initial + 1 retry).  This is a runtime
// policy constant, not a heuristic — raising it risks amplifying provider
// load on genuine outages.  Change only with deliberate cost/reliability tradeoff.
const MAX_ATTEMPTS = 2;

// Small whitelist of Node.js / undici error codes that represent transient
// network conditions safe to retry with a fresh session.  Kept as a flat Set
// so the lookup is O(1) and the full table is visible in one place.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

// Transient WS close codes (abnormal close / server restart / overload).
const TRANSIENT_WS_CODES = new Set([1006, 1011, 1012, 4000]);

// Transient HTTP statuses: timeout (408), server fault (500), gateway (502/503/504).
const TRANSIENT_HTTP_STATUS = new Set([408, 500, 502, 503, 504]);

/**
 * Returns true when `err` represents a transient network or provider fault
 * that is safe to retry with a fresh session.  Walks err.cause and
 * err.response.data up to depth 2 so wrapped errors (axios / fetch / sdk)
 * are detected without unbounded recursion.
 *
 * Classification order (first match wins):
 *   1. err.retryable === true  — provider explicitly marks the error retryable.
 *   2. err.code in TRANSIENT_NETWORK_CODES  — raw socket / DNS transient.
 *   3. err.wsCloseCode in TRANSIENT_WS_CODES  — WS abnormal / server restart.
 *   4. err.httpStatus or err.response.status in TRANSIENT_HTTP_STATUS  — gateway fault.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTransientNetworkError(err, _depth = 0) {
  if (!err || _depth > 2) return false;
  if (err.retryable === true) return true;
  if (err.code != null && TRANSIENT_NETWORK_CODES.has(err.code)) return true;
  if (err.wsCloseCode != null && TRANSIENT_WS_CODES.has(err.wsCloseCode)) return true;
  if (err.wsCloseCode === 1000) {
    const msg = (err instanceof Error ? err.message : String(err)) || '';
    if (/before response\.completed/i.test(msg)) return true;
  }
  if (err.httpStatus != null && TRANSIENT_HTTP_STATUS.has(err.httpStatus)) return true;
  if (err.response?.status != null && TRANSIENT_HTTP_STATUS.has(err.response.status)) return true;
  if (err.cause != null) return isTransientNetworkError(err.cause, _depth + 1);
  if (err.response?.data != null) return isTransientNetworkError(err.response.data, _depth + 1);
  return false;
}
/**
 * Run `runFn(attempt)` with automatic retry on transient network errors.
 *
 * @param {object} opts
 * @param {string}   opts.role        - role label (for stderr logging)
 * @param {string}   opts.jobId       - jobId (for stderr logging)
 * @param {number}  [opts.startAttempt=0] - initial attempt counter (from persisted state)
 * @param {(attempt: number) => Promise<*>} opts.runFn
 *   Called with the current attempt index.  Must return the askSession result
 *   or throw.  A fresh session must be created by the caller inside runFn
 *   when attempt > 0 (the wrapper does NOT manage session lifecycle).
 * @returns {Promise<{ result: *, attempt: number }>}
 *   Resolves with the successful result and the attempt index that succeeded.
 *   Rejects with the last error when all attempts are exhausted or the error
 *   is non-recoverable.
 */
export async function runWithDispatchRetry({ role, jobId, startAttempt = 0, runFn }) {
  let attempt = typeof startAttempt === 'number' && startAttempt >= 0 ? startAttempt : 0;

  while (attempt < MAX_ATTEMPTS) {
    try {
      const result = await runFn(attempt);
      return { result, attempt };
    } catch (err) {
      const recoverable = isTransientNetworkError(err);
      const nextAttempt = attempt + 1;

      if (recoverable && nextAttempt < MAX_ATTEMPTS) {
        const msg = (err instanceof Error ? err.message : String(err)) || '';
        try {
          process.stderr.write(
            `[bridge-retry] worker transient error attempt=${attempt}: ${msg.slice(0, 160)}\n` +
            `[bridge-retry] role=${role} job=${jobId} → retrying as attempt=${nextAttempt}\n`,
          );
        } catch { /* best-effort */ }
        attempt = nextAttempt;
        continue;
      }

      // Non-recoverable or cap reached — surface original error.
      throw err;
    }
  }

  // Unreachable, but TypeScript / linters are happier.
  throw new Error('[bridge-retry] exhausted attempts without resolution');
}
