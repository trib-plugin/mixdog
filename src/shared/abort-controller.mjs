/**
 * AbortController helpers — ported from the Claude Code CLI pattern.
 *
 * `createAbortController()` raises the signal's max listener cap so long-running
 * sessions with many per-iteration handlers don't trip Node's default warning.
 *
 * `createChildAbortController(parent)` creates a child tied to a parent via
 * WeakRef-based listeners, so an unreferenced child can be GC'd without leaking
 * an abort handler on the parent signal. The child aborts when the parent does
 * (with the parent's reason); the parent-side listener is removed if the child
 * aborts first.
 */
import { setMaxListeners } from 'events';

const DEFAULT_MAX_LISTENERS = 50;

export function createAbortController(maxListeners = DEFAULT_MAX_LISTENERS) {
  const controller = new AbortController();
  try { setMaxListeners(maxListeners, controller.signal); } catch { /* node < 19 fallback */ }
  return controller;
}

function propagateAbort(weakChild) {
  const parent = this.deref();
  weakChild.deref()?.abort(parent?.signal.reason);
}

function removeAbortHandler(weakHandler) {
  const parent = this.deref();
  const handler = weakHandler.deref();
  if (parent && handler) parent.signal.removeEventListener('abort', handler);
}

export function createChildAbortController(parent, maxListeners = DEFAULT_MAX_LISTENERS) {
  const child = createAbortController(maxListeners);
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }
  const weakChild = new WeakRef(child);
  const weakParent = new WeakRef(parent);
  const handler = propagateAbort.bind(weakParent, weakChild);
  parent.signal.addEventListener('abort', handler, { once: true });
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  );
  return child;
}
