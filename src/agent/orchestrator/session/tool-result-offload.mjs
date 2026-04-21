import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
import { normalizeOutputPath } from '../tools/builtin.mjs';

const TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS = 8_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;
export const TOOL_RESULT_OFFLOAD_PREFIX = '[tool output offloaded:';

function ensureToolResultsDir(sessionId) {
    const dir = join(getPluginData(), 'tool-results', sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

function buildPreview(text, maxChars = TOOL_RESULT_PREVIEW_CHARS) {
    if (text.length <= maxChars) {
        return { preview: text, truncated: false };
    }
    const head = text.slice(0, maxChars);
    const lastNewline = head.lastIndexOf('\n');
    const cut = lastNewline > Math.floor(maxChars * 0.6) ? lastNewline : maxChars;
    return { preview: text.slice(0, cut), truncated: true };
}

function countLines(text) {
    if (!text) return 0;
    return text.split('\n').length;
}

export function maybeOffloadToolResult(sessionId, toolCallId, toolName, result) {
    if (!sessionId || !toolCallId) return result;
    if (typeof result !== 'string') return result;
    if (result.length <= TOOL_RESULT_OFFLOAD_THRESHOLD_CHARS) return result;
    // Keep error surfaces inline. The model usually needs the exact error
    // immediately to self-correct; offloading would cost an extra read turn.
    const lower = result.trim().toLowerCase();
    if (lower.startsWith('error:') || lower.startsWith('[error')) return result;

    const dir = ensureToolResultsDir(sessionId);
    const filePath = join(dir, `${toolCallId}.txt`);
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
    TOOL_RESULT_PREVIEW_CHARS,
    buildPreview,
    countLines,
};
