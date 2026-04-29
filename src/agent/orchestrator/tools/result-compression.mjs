/**
 * Tool Result Compression — single entry helper.
 *
 * One deterministic pass per tool result:
 *   1. dedupRepeatedLines (3+ adjacent byte-equal lines → one marker line)
 *   2. expand guard: accept the output only if it is strictly shorter
 *   3. trace material savings (≥ 5% AND ≥ 512B) for `gain` analytics
 *
 * No keyword heuristics. No command-family detection. No per-tool
 * strategy switches. The expand guard is the only correctness check —
 * if marker insertion would lengthen a result with short alternating
 * runs, the original is returned unchanged. Adjacent byte-equal lines
 * are by definition redundant; nothing about their *meaning* needs to
 * be inspected to decide whether folding them is safe.
 */

import { traceBridgeCompress, traceBridgeBatch } from '../bridge-trace.mjs';

const COMPRESS_MIN_BYTES = 512;
const DEDUP_MIN_LINES = 6;
const DEDUP_TRIGGER = 3;
const TRACE_MIN_SAVINGS_PCT = 5;
const TRACE_MIN_SAVINGS_BYTES = 512;

export function dedupRepeatedLines(text) {
    if (typeof text !== 'string') return text;
    const lines = text.split('\n');
    if (lines.length < DEDUP_MIN_LINES) return text;
    const out = [];
    let prev = null;
    let dupRun = 0;
    const flush = () => {
        if (dupRun === 0) return;
        if (dupRun < DEDUP_TRIGGER - 1) {
            for (let i = 0; i < dupRun; i++) out.push(prev);
        } else {
            out.push(`  (×${dupRun + 1} identical lines collapsed)`);
        }
        dupRun = 0;
    };
    for (const line of lines) {
        if (prev !== null && line === prev) {
            dupRun += 1;
        } else {
            flush();
            out.push(line);
            prev = line;
            dupRun = 0;
        }
    }
    flush();
    return out.join('\n');
}

export function compressToolResult(toolName, args, result, ctx) {
    if (typeof result !== 'string' || result.length < COMPRESS_MIN_BYTES) return result;
    const before = result.length;
    const out = dedupRepeatedLines(result);
    // Expand guard — never lengthen a result. Marker insertion can grow
    // the string when runs are short and alternate frequently
    // (`a\na\na\nb\nb\nb...`), so a deterministic byte-equal compare is
    // the only safe accept criterion. Falling back to the original also
    // preserves any caller-significant content that adjacent-byte-equal
    // dedup cannot misinterpret because it never ran.
    if (out.length >= before) return result;
    if (ctx?.sessionId) {
        const saved = before - out.length;
        const savingsPct = Math.round((saved / before) * 100);
        if (savingsPct >= TRACE_MIN_SAVINGS_PCT && saved >= TRACE_MIN_SAVINGS_BYTES) {
            try { traceBridgeCompress({ sessionId: ctx.sessionId, toolName, before, after: out.length }); } catch { /* trace best-effort */ }
        }
    }
    return out;
}

// Per-turn batch shape recorder. Called once per assistant turn (right
// after the model returns toolCalls) with the count. Trace consumers can
// compute multi-tool adoption ratio (calls > 1 / total turns) directly
// from these rows instead of re-parsing every assistant message body.
export function recordToolBatch(sessionId, toolCallCount) {
    const n = Number(toolCallCount);
    if (!sessionId || !Number.isFinite(n) || n <= 0) return;
    try { traceBridgeBatch({ sessionId, toolCallCount: n }); } catch { /* trace best-effort */ }
}
