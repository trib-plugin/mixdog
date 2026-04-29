/**
 * Tool Result Compression — single entry helper.
 *
 * All loop-level tool results funnel through compressToolResult before they
 * reach maybeOffloadToolResult. This is the one place that:
 *   1. shrinks output via per-tool strategies (shell dedup + family format)
 *   2. records compression savings to bridge-trace (`compress` kind)
 *   3. records per-turn multi-tool batch shape (`batch` kind) so we can
 *      track Lead-side parallel-call adoption over time.
 *
 * Strategies stay conservative: anything that risks losing diagnostic
 * value (read numbered lines, grep `path:lineNo:content`, code-graph
 * structure, MCP / internal results) is passthrough. The big wins live in
 * shell tool output where repeat spam is endemic (npm test, cargo build,
 * docker pull progress, log walls).
 */

import { traceBridgeCompress, traceBridgeBatch } from '../bridge-trace.mjs';

const COMPRESS_MIN_BYTES = 512;
const DEDUP_MIN_LINES = 6;
const DEDUP_TRIGGER = 3; // 3+ same lines in a row → collapse to (×N)

// Lines that must never be folded into a (×N) marker even when adjacent
// lines repeat. Stack traces, panic frames, pytest failure markers all
// lose diagnostic value when collapsed.
const PROTECTED_LINE_RE = /\b(error|fail(?:ed|ure)?|panic|traceback|stacktrace|fatal|aborted|exception)\b/i;

// Terse test-runner progress (`.F.F.F`, `....FF`, `EE.E.`) carries failure
// counts in single characters and contains no `fail` word. If such a line
// repeats the dedup would silently drop failure markers — a false signal
// to the caller. Match strings made entirely of `.`, `F`, `E` that
// contain at least one F or E and never collapse them.
const TEST_PROGRESS_FAIL_RE = /^(?=.*[FE])[.FE]+$/;

const SHELL_TOOLS = new Set(['bash', 'bash_session', 'job_wait']);
const FILE_QUERY_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'tree', 'find_files']);

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
        if (prev !== null
            && line === prev
            && !PROTECTED_LINE_RE.test(line)
            && !TEST_PROGRESS_FAIL_RE.test(line)) {
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

export function detectCommandFamily(command) {
    if (!command) return null;
    const head = String(command).trim().split(/\s+/)[0]?.toLowerCase() || '';
    if (head === 'git') return 'git';
    if (/^(npm|yarn|pnpm)$/.test(head)) return 'js';
    if (head === 'cargo') return 'rust';
    if (/^(pytest|python|python3)$/.test(head)) return 'py';
    if (/^(go|gotest)$/.test(head)) return 'go';
    if (head === 'docker') return 'docker';
    return null;
}

function applyFamilyFormatter(_family, text) {
    // P1 placeholder. Family-specific formatting (git untracked grouping,
    // pytest dot-progress collapse, etc.) lands here once per-family ROI
    // measurement justifies the rule maintenance. Until then dedup is the
    // only active layer — keeps the contract small and predictable.
    return text;
}

function compressShellOutput(command, output) {
    const deduped = dedupRepeatedLines(output);
    const family = detectCommandFamily(command);
    return family ? applyFamilyFormatter(family, deduped) : deduped;
}

export function compressToolResult(toolName, args, result, ctx) {
    if (typeof result !== 'string' || result.length < COMPRESS_MIN_BYTES) return result;
    const before = result.length;
    let out;
    if (SHELL_TOOLS.has(toolName)) {
        out = compressShellOutput(args?.command || '', result);
    } else if (FILE_QUERY_TOOLS.has(toolName)) {
        out = dedupRepeatedLines(result);
    } else {
        return result;
    }
    if (ctx?.sessionId && out.length < before) {
        // Volume gate — only record materially-different rows so 24h trace
        // growth from this layer stays under ~1 MB/day. Rows that saved
        // < 5% or < 512 bytes carry no useful `gain` signal anyway.
        const saved = before - out.length;
        const savingsPct = Math.round((1 - out.length / before) * 100);
        if (savingsPct >= 5 && saved >= 512) {
            try { traceBridgeCompress({ sessionId: ctx.sessionId, toolName, before, after: out.length }); } catch { /* trace best-effort */ }
        }
    }
    return out;
}

// Per-turn batch shape recorder. Called once per assistant turn (right
// after the model returns toolCalls) with the count. Trace consumers can
// compute multi-tool adoption ratio (calls > 1 / total turns) from these
// rows — same metric the debugger pulled manually from raw trace lines.
export function recordToolBatch(sessionId, toolCallCount) {
    const n = Number(toolCallCount);
    if (!sessionId || !Number.isFinite(n) || n <= 0) return;
    try { traceBridgeBatch({ sessionId, toolCallCount: n }); } catch { /* trace best-effort */ }
}
