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
 * Compression is opt-in per tool: only tools with
 * `annotations.compressible: true` in their tool definition are processed.
 */

import { traceBridgeCompress, traceBridgeBatch } from '../bridge-trace.mjs';
import { BUILTIN_TOOLS } from './builtin.mjs';

const ANSI_CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const SEPARATOR_BAR = /^[=\-_*~#]{8,}\s*$/;

function bareToolName(name) {
    if (typeof name !== 'string' || !name) return name;
    const m = name.match(/^mcp__.+?__(.+)$/);
    return m ? m[1] : name;
}

function isCompressible(name) {
    const bare = bareToolName(name);
    const def = BUILTIN_TOOLS.find(t => t.name === bare);
    return def?.annotations?.compressible === true;
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
    const out = [];
    let prev = null;
    let dupRun = 0;
    const flush = () => {
        if (dupRun === 0) return;
        if (dupRun < 2) {
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

// Collapse a run of 3+ identical separator-bar lines to the first line + a marker.
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
            if (run >= 3) {
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
    if (typeof result !== 'string') return result;
    if (!isCompressible(toolName)) return result;
    const before = result.length;
    let out = stripAnsi(result);
    out = normalizeWhitespace(out);
    out = dedupRepeatedLines(out);
    out = collapseSeparators(out);
    if (out.length >= before) return result;
    if (ctx?.sessionId) {
        try { traceBridgeCompress({ sessionId: ctx.sessionId, toolName, before, after: out.length }); } catch { /* trace best-effort */ }
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
