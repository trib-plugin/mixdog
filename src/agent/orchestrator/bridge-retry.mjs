/**
 * bridge-retry — provider-agnostic auto-retry for detached bridge workers.
 *
 * Wraps a single-attempt runFn (returns askSession result) with at most one
 * automatic retry when the failure is classified as RECOVERABLE (transient
 * provider fault). Fresh session per attempt — no message-history carry-over.
 *
 * Cap: 2 total attempts (attempt 0 + 1 retry). Hard cap enforced both here
 * and via the attempt counter persisted in dispatch-persist so a supervisor
 * restart cannot smuggle in a third attempt.
 */

const MAX_ATTEMPTS = 2;

/** Patterns covering Anthropic 400 tool_use pairing and OpenAI WS truncation */
const RECOVERABLE_MSG_PATTERNS = [
  /tool_use ids were found without tool_result/i,
  /messages\.\d+:.*tool_use/i,
  /Codex WS closed before response\.completed/i,
  /response\.incomplete/i,
];

const RECOVERABLE_WS_CODES   = new Set([1006, 1011, 1012, 4000]);
const RECOVERABLE_HTTP_STATUS = new Set([502, 503, 504]);
const RECOVERABLE_ERR_CODES   = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ESOCKETTIMEDOUT']);

/**
 * Returns true when the error looks like a transient provider fault that is
 * safe to retry with a fresh session.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoverableError(err) {
  if (!err) return false;
  return _isRecoverableError(err, 0);
}

function _isRecoverableError(err, depth) {
  if (!err || depth > 3) return false;
  const msg = (err instanceof Error ? err.message : String(err)) || '';
  if (RECOVERABLE_MSG_PATTERNS.some((re) => re.test(msg))) return true;
  if (err.wsCloseCode != null && RECOVERABLE_WS_CODES.has(err.wsCloseCode)) return true;
  // wsCloseCode 1000 is a normal close; only recover if it was a truncation
  if (err.wsCloseCode === 1000 && /before response\.completed/i.test(msg)) return true;
  if (err.httpStatus  != null && RECOVERABLE_HTTP_STATUS.has(err.httpStatus)) return true;
  if (err.code        != null && RECOVERABLE_ERR_CODES.has(err.code)) return true;
  if (err.cause != null) return _isRecoverableError(err.cause, depth + 1);
  return false;
}

/**
 * Run `runFn(attempt)` with automatic retry on recoverable errors.
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
      const recoverable = isRecoverableError(err);
      const nextAttempt  = attempt + 1;

      if (recoverable && nextAttempt < MAX_ATTEMPTS) {
        const msg = (err instanceof Error ? err.message : String(err)) || '';
        try {
          process.stderr.write(
            `[bridge-retry] worker recoverable error attempt=${attempt}: ${msg.slice(0, 160)}\n` +
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
