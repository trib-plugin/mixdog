import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
import { normalizeOutputPath } from '../tools/builtin.mjs';

const TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS = 16_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;
const TOOL_RESULT_SHELL_THRESHOLD_CHARS = 30_000;
const TOOL_RESULT_SEARCH_THRESHOLD_CHARS = 100_000;
export const TOOL_RESULT_OFFLOAD_PREFIX = '[tool output offloaded:';

// Claude Code declares per-tool persistence limits: Read opts out entirely
// because it self-bounds, Glob/Grep stay inline up to 100k, while Bash uses
// 30k. Codex OSS similarly truncates bounded output in place rather than
// forcing the model to spend a follow-up turn reading a sidecar. Keep that
// shape here so context-rich IO tools do not turn into "read saved output"
// loops just because a useful result crossed the old 8k global threshold.
const INLINE_THRESHOLD_BY_TOOL = new Map([
    ['read', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['head', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['tail', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['diff', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['grep', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['glob', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['list', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['tree', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['find_files', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['code_graph', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['find_symbol', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['find_imports', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['find_dependents', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['find_references', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['find_callers', TOOL_RESULT_SEARCH_THRESHOLD_CHARS],
    ['bash', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
    ['bash_session', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
    ['job_wait', TOOL_RESULT_SHELL_THRESHOLD_CHARS],
]);

function getOffloadThreshold(toolName) {
    const key = String(toolName || '').toLowerCase();
    return INLINE_THRESHOLD_BY_TOOL.get(key) ?? TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS;
}

function ensureToolResultsDir(sessionId) {
    const dir = join(getPluginData(), 'tool-results', sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

// Map tool-call IDs to safe generated filenames. toolCallId arrives from
// the provider and may contain path-unsafe characters (slashes, dots, etc.).
// Use a monotonic counter keyed by sessionId so the sidecar path is
// deterministic-ish within a session but never tainted by provider input.
const _offloadCounters = new Map();

function buildPreview(text, maxChars = TOOL_RESULT_PREVIEW_CHARS) {
    if (text.length <= maxChars) {
        return { preview: text, truncated: false };
    }
    const headBudget = Math.floor(maxChars * 0.6);
    const tailBudget = maxChars - headBudget;
    let head = text.slice(0, headBudget);
    const headCut = head.lastIndexOf('\n');
    if (headCut > Math.floor(headBudget * 0.6)) head = head.slice(0, headCut);
    let tail = text.slice(Math.max(0, text.length - tailBudget));
    const tailCut = tail.indexOf('\n');
    if (tailCut !== -1 && tailCut < Math.floor(tailBudget * 0.4)) tail = tail.slice(tailCut + 1);
    const omittedKb = Math.max(1, Math.round((text.length - head.length - tail.length) / 1024));
    return {
        preview: `${head}\n\n... [preview middle omitted — ${omittedKb} KB] ...\n\n${tail}`,
        truncated: true,
    };
}

function countLines(text) {
    if (!text) return 0;
    return text.split('\n').length;
}

export function maybeOffloadToolResult(sessionId, toolCallId, toolName, result) {
    if (!sessionId || !toolCallId) return result;
    if (typeof result !== 'string') return result;
    if (result.length <= getOffloadThreshold(toolName)) return result;
    // Keep error surfaces inline. The model usually needs the exact error
    // immediately to self-correct; offloading would cost an extra read turn.
    const lower = result.trim().toLowerCase();
    if (lower.startsWith('error:') || lower.startsWith('error [') || lower.startsWith('[error')) return result;

    // Generate a safe filename — never trust toolCallId as a path component.
    const count = (_offloadCounters.get(sessionId) ?? 0) + 1;
    _offloadCounters.set(sessionId, count);
    const safeId = `r${count}`;

    const dir = ensureToolResultsDir(sessionId);
    const filePath = join(dir, `${safeId}.txt`);
    writeFileSync(filePath, result, 'utf-8');

    const { preview, truncated } = buildPreview(result);
    const sizeKb = Math.max(1, Math.round(result.length / 1024));
    const lines = countLines(result);
    const displayPath = normalizeOutputPath(filePath);
    const header = `${TOOL_RESULT_OFFLOAD_PREFIX} ${toolName} → ${displayPath} (${sizeKb} KB, ${lines} lines)]`;
    const suffix = truncated ? '\n... [preview truncated — use read on the saved path for full output]' : '';
    return `${header}\n\n${preview}${suffix}`;
}

export function isOffloadedToolResultText(text) {
    return typeof text === 'string' && text.startsWith(TOOL_RESULT_OFFLOAD_PREFIX);
}

export function compactOffloadedToolResultText(text) {
    if (!isOffloadedToolResultText(text)) return text;
    const firstLine = String(text).split('\n')[0] || text;
    return `${firstLine}\n[preview omitted — use read on the saved path if needed]`;
}

export const _internals = {
    TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS,
    TOOL_RESULT_SHELL_THRESHOLD_CHARS,
    TOOL_RESULT_SEARCH_THRESHOLD_CHARS,
    getOffloadThreshold,
    TOOL_RESULT_PREVIEW_CHARS,
    buildPreview,
    countLines,
};
