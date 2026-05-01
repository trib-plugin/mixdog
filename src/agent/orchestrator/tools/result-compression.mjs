/**
 * Tool Result Compression — chained safe passes.
 *
 * Pass order (each strictly reduce-only or self-guarded):
 *   1. stripAnsi          — remove CSI / OSC escape sequences
 *   2. normalizeWhitespace — strip trailing horizontal whitespace,
 *                            collapse 3+ blank lines to 2
 *   3. dedupRepeatedLines — 3+ adjacent byte-equal lines → marker
 *   4. collapseSeparators — 3+ identical bar-character lines → first + marker
 *
 * Final expand guard: if the chained output is not strictly shorter
 * than the input, return the input unchanged. Each pass is text→text
 * and deterministic; composition cannot introduce semantic loss beyond
 * what each individual pass already permits.
 *
 * Tool allowlist: only operational-text outputs are compressed. File-
 * content tools (read / write / edit / apply_patch) skip compression
 * because trailing whitespace, multi-blank runs, and bar-character
 * lines can be semantically meaningful in source files (Python
 * triple-quoted strings, Markdown hard line breaks, ASCII-art doc
 * comments, etc.).
 *
 * Trace: only material savings (≥ 5% AND ≥ 512B) recorded for `gain`
 * analytics.
 */

import { traceBridgeCompress, traceBridgeBatch } from '../bridge-trace.mjs';

const COMPRESS_MIN_BYTES = 512;
const DEDUP_MIN_LINES = 6;
const DEDUP_TRIGGER = 3;
const SEPARATOR_TRIGGER = 3;
const SEPARATOR_MIN_LEN = 8;
const TRACE_MIN_SAVINGS_PCT = 5;
const TRACE_MIN_SAVINGS_BYTES = 512;

// Operational text outputs where lossless compression is unambiguously
// safe. File-content tools (read / write / edit / apply_patch) are NOT
// in this set — trailing whitespace and multi-blank runs in source
// files can be semantically meaningful.
//
// The narrower SOURCE_BEARING set names tools that emit code or other
// file content alongside locator text (path:line + matched line). For
// those, compression keeps ANSI strip + dedup + separator collapse but
// skips trailing-whitespace normalization (significant trailing
// whitespace can be the matched evidence). bash is omitted entirely
// since it streams arbitrary user output where dup-line / whitespace
// runs may be the payload.
const COMPRESS_TOOL_ALLOWLIST = new Set([
    'shell',
    'glob', 'list',
    'grep',
    'find_symbol', 'find_callers', 'find_references', 'find_imports', 'find_dependents', 'code_graph',
]);

const SOURCE_BEARING_TOOLS = new Set([
    'grep',
    'find_symbol', 'find_callers', 'find_references', 'find_imports', 'find_dependents', 'code_graph',
]);

const ANSI_CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// OSC (Operating System Command): ESC ] ... terminator (BEL or ESC \).
// Match non-greedily across any payload bytes (including embedded ESC)
// and consume the full terminator instead of stopping at the first
// nested escape, which would leave a partial tail in the output.
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const SEPARATOR_BAR = new RegExp(`^[=\\-_*~#]{${SEPARATOR_MIN_LEN},}\\s*$`);

// Normalize MCP-prefixed names (mcp__<server>__<tool>) to their bare
// form so the allowlist check matches consistently regardless of the
// caller's invocation style.
function bareToolName(name) {
    if (typeof name !== 'string' || !name) return name;
    const m = name.match(/^mcp__.+?__(.+)$/);
    return m ? m[1] : name;
}

export function stripAnsi(text) {
    if (typeof text !== 'string') return text;
    return text.replace(ANSI_CSI, '').replace(ANSI_OSC, '');
}

export function normalizeWhitespace(text) {
    if (typeof text !== 'string') return text;
    return text
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n');
}

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

// Collapse a run of 3+ identical separator-bar lines (≥ 8 chars of one
// repeating bar character: = - _ * ~ #) to the first line + a marker.
// Short runs are left intact so decorative banners keep their shape.
export function collapseSeparators(text) {
    if (typeof text !== 'string') return text;
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        if (SEPARATOR_BAR.test(lines[i])) {
            let j = i + 1;
            while (j < lines.length && lines[j] === lines[i]) j++;
            const run = j - i;
            if (run >= SEPARATOR_TRIGGER) {
                out.push(lines[i]);
                out.push(`  (×${run - 1} more identical separator lines collapsed)`);
            } else {
                for (let k = i; k < j; k++) out.push(lines[k]);
            }
            i = j;
        } else {
            out.push(lines[i]);
            i++;
        }
    }
    return out.join('\n');
}

export function compressToolResult(toolName, args, result, ctx) {
    if (typeof result !== 'string' || result.length < COMPRESS_MIN_BYTES) return result;
    const bare = bareToolName(toolName);
    if (!COMPRESS_TOOL_ALLOWLIST.has(bare)) return result;
    const before = result.length;
    // Pass chain: ANSI strip and whitespace normalization are strictly
    // reduce-only; dedup and separator collapse insert marker lines but
    // their net contribution is caught by the final expand guard if it
    // would lengthen the output. Source-bearing tools (grep / find_*)
    // skip whitespace normalization since trailing whitespace and blank
    // runs in matched code lines may be the evidence the caller is
    // looking for.
    let out = stripAnsi(result);
    if (!SOURCE_BEARING_TOOLS.has(bare)) out = normalizeWhitespace(out);
    out = dedupRepeatedLines(out);
    out = collapseSeparators(out);
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
// after the model returns toolCalls) with the count. Trace consumers
// can compute multi-tool adoption ratio (calls > 1 / total turns)
// directly from these rows instead of re-parsing every assistant
// message body.
export function recordToolBatch(sessionId, toolCallCount) {
    const n = Number(toolCallCount);
    if (!sessionId || !Number.isFinite(n) || n <= 0) return;
    try { traceBridgeBatch({ sessionId, toolCallCount: n }); } catch { /* trace best-effort */ }
}
