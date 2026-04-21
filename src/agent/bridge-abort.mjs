/**
 * Bridge request-abort wiring — factored out of the `bridge` tool handler so
 * the reject-kill contract can be unit-tested without having to spin up a
 * full session + provider stack.
 *
 * Contract (v0.6.242):
 *   The MCP SDK hands `setRequestHandler` an `extra.signal` AbortSignal that
 *   fires when the client cancels the in-flight CallTool. For bridge, that's
 *   typically a user reject/interrupt in Claude Code. The bridge handler
 *   returns a jobId synchronously and then runs askSession in a detached
 *   async IIFE — so without an explicit abort wire-up, the IIFE keeps hitting
 *   the provider after the user bails out (the zombie-session symptom).
 *
 *   attachBridgeAbort() installs a listener that closes the session on abort,
 *   emits a silent-to-agent status ping, and writes a trace line to stderr
 *   so ops can see why the session died. Returns a detach() so the finally
 *   block of a completed IIFE can remove the listener when abort never fired.
 */

/**
 * @param {object} params
 * @param {AbortSignal|null|undefined} params.signal   request-lifecycle signal from MCP extra
 * @param {string}   params.sessionId
 * @param {string}   params.role
 * @param {string}   params.jobId
 * @param {string}  [params.modelTag]                  `[model] ` prefix for emit
 * @param {(id: string) => void} params.closeSession   closeSession from session manager
 * @param {(msg: string, meta?: object) => void} [params.emit]  notifyFn-style emitter
 * @param {(msg: string) => void} [params.log]         stderr writer (defaults to process.stderr.write)
 * @returns {{ detach: () => void, fired: () => boolean }}
 */
export function attachBridgeAbort(params) {
    const {
        signal,
        sessionId,
        role = 'worker',
        jobId = 'unknown',
        modelTag = '',
        closeSession,
        emit = () => {},
        log = (msg) => { try { process.stderr.write(msg); } catch { /* best-effort */ } },
    } = params || {};

    if (typeof closeSession !== 'function') {
        throw new Error('attachBridgeAbort: closeSession is required');
    }
    if (!sessionId) {
        throw new Error('attachBridgeAbort: sessionId is required');
    }

    let fired = false;
    const onAbort = () => {
        if (fired) return;
        fired = true;
        try { log(`[bridge] worker aborted by user: session=${sessionId} role=${role} job=${jobId}\n`); }
        catch { /* best-effort */ }
        try { emit(`${modelTag}${role} aborted by user`, { silent_to_agent: true }); }
        catch { /* best-effort */ }
        try { closeSession(sessionId, 'request-abort'); }
        catch (e) {
            try { log(`[bridge] closeSession failed during abort: ${e && e.message || e}\n`); }
            catch { /* best-effort */ }
        }
    };

    if (!signal) {
        // No signal → no-op detach. fired() always returns false.
        return { detach: () => {}, fired: () => false };
    }

    if (signal.aborted) {
        // Client cancelled before we even registered — still propagate,
        // but run out-of-band so the caller can finish its sync setup first.
        queueMicrotask(onAbort);
        return { detach: () => {}, fired: () => fired };
    }

    signal.addEventListener('abort', onAbort, { once: true });
    return {
        detach: () => {
            if (fired) return;
            try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        },
        fired: () => fired,
    };
}
