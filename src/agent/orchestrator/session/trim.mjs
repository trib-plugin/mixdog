import { isOffloadedToolResultText, compactOffloadedToolResultText } from './tool-result-offload.mjs';

// Rough token estimate: ~4 chars per token
function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 4);
}
function messageEstimateText(m) {
    if (!m || typeof m !== 'object') return '';
    let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
        try { text += `\n${JSON.stringify(m.toolCalls)}`; }
        catch { text += `\n[${m.toolCalls.length} tool calls]`; }
    }
    if (m.role === 'tool' && m.toolCallId) text += `\n${m.toolCallId}`;
    return text;
}
function estimateMessageTokens(m) {
    return estimateTokens(messageEstimateText(m)) + 4;
}
function estimateMessagesTokens(messages) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}
const TOOL_TRUNCATE_THRESHOLD = 500;
const TOOL_TRUNCATE_HEAD_RATIO = 0.6;
// Hermes-style pre-prune: any older tool result larger than this is replaced
// with a stub. Kept tighter than TOOL_TRUNCATE_THRESHOLD so we recover more
// bytes before the byte-budget cut runs.
const PRUNE_OLD_TOOL_MIN_CHARS = 200;
const PRUNE_STUB_TEXT = '[Old tool output cleared to save context space]';
const DEFAULT_PROTECT_TAIL = 20;
const TOOL_MISSING_STUB = '[Result from earlier conversation — see context summary above]';

function compactToolText(text, maxChars = TOOL_TRUNCATE_THRESHOLD) {
    const s = String(text ?? '');
    if (s.length <= maxChars) return s;
    const headBudget = Math.max(1, Math.floor(maxChars * TOOL_TRUNCATE_HEAD_RATIO));
    const tailBudget = Math.max(1, maxChars - headBudget);
    let head = s.slice(0, headBudget);
    const headCut = head.lastIndexOf('\n');
    if (headCut > Math.floor(headBudget * 0.5)) head = head.slice(0, headCut);
    let tail = s.slice(Math.max(0, s.length - tailBudget));
    const tailCut = tail.indexOf('\n');
    if (tailCut !== -1 && tailCut < Math.floor(tailBudget * 0.5)) tail = tail.slice(tailCut + 1);
    const omitted = Math.max(0, s.length - head.length - tail.length);
    return `${head}\n[truncated middle: ${omitted} chars]\n${tail}`;
}

/**
 * Truncate long tool_result messages to save tokens.
 * Returns a shallow copy with truncated content where applicable.
 */
function truncateToolResults(messages) {
    return messages.map(m => {
        if (m.role === 'tool'
            && typeof m.content === 'string'
            && isOffloadedToolResultText(m.content)) {
            const compact = compactOffloadedToolResultText(m.content);
            return compact === m.content ? m : { ...m, content: compact };
        }
        if (m.role === 'tool'
            && typeof m.content === 'string'
            && m.content.length > TOOL_TRUNCATE_THRESHOLD
            && !isOffloadedToolResultText(m.content)) {
            return { ...m, content: compactToolText(m.content) };
        }
        return m;
    });
}
/**
 * Cheap pre-pass (Hermes `_prune_old_tool_results`): replaces content of older
 * tool messages with a short stub so the byte-budget cut has less to trim.
 * Message count is preserved — only `content` shrinks — so tool_call/tool_result
 * pairing stays intact.
 */
export function pruneOldToolResults(messages, protectTailCount) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const tail = Math.max(0, protectTailCount | 0);
    const cutoff = messages.length - tail;
    if (cutoff <= 0) return messages;
    let changed = false;
    const next = messages.map((m, idx) => {
        if (idx >= cutoff) return m;
        if (m.role !== 'tool') return m;
        const content = m.content || '';
        if (content.length <= PRUNE_OLD_TOOL_MIN_CHARS) return m;
        if (content === PRUNE_STUB_TEXT) return m;
        if (isOffloadedToolResultText(content)) {
            const compact = compactOffloadedToolResultText(content);
            return compact === content ? m : { ...m, content: compact };
        }
        changed = true;
        return { ...m, content: PRUNE_STUB_TEXT };
    });
    return changed ? next : messages;
}
/**
 * Walk backward from `idx` past consecutive tool messages to the parent
 * assistant message that emitted the tool_calls. Returns an index that points
 * at (or before) that assistant so a byte-budget cut drops the group as a
 * unit rather than leaving orphan tool results. Returns `idx` unchanged if
 * we didn't land inside a group.
 */
export function alignBoundaryBackward(messages, idx) {
    if (!Array.isArray(messages) || idx <= 0 || idx >= messages.length) return idx;
    let i = idx;
    while (i > 0 && messages[i]?.role === 'tool') i--;
    if (i === idx) return idx;
    const anchor = messages[i];
    if (anchor?.role === 'assistant' && Array.isArray(anchor.toolCalls) && anchor.toolCalls.length) {
        return i;
    }
    return idx;
}
/**
 * Post-trim sanitization (Hermes `_sanitize_tool_pairs`):
 *   - Drop `tool` messages whose toolCallId has no surviving assistant tool_call.
 *   - For surviving assistant tool_calls whose results got trimmed, insert a
 *     stub tool message so the provider doesn't reject the request for
 *     unmatched tool_use_id.
 * Messages ordering is preserved; stubs are inserted immediately after the
 * assistant message so the tool pair sits adjacent.
 */
export function sanitizeToolPairs(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const assistantCallIds = new Set();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
            for (const tc of m.toolCalls) {
                if (tc && tc.id) assistantCallIds.add(tc.id);
            }
        }
    }
    const toolById = new Map();
    for (const m of messages) {
        if (m.role === 'tool' && m.toolCallId) toolById.set(m.toolCallId, m);
    }
    const filtered = messages.filter(m => {
        if (m.role !== 'tool') return true;
        if (!m.toolCallId) return true;
        return assistantCallIds.has(m.toolCallId);
    });
    const result = [];
    for (const m of filtered) {
        result.push(m);
        if (m.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
        for (const tc of m.toolCalls) {
            if (!tc?.id) continue;
            const existing = toolById.get(tc.id);
            if (existing && filtered.includes(existing)) continue;
            const preserved = existing?.content;
            result.push({
                role: 'tool',
                content: isOffloadedToolResultText(preserved) ? preserved : TOOL_MISSING_STUB,
                toolCallId: tc.id,
            });
        }
    }
    return result;
}
/**
 * Trim messages to fit within a token budget.
 * Strategy:
 *   0. Pre-prune: shrink old tool messages (>200 chars) to a stub.
 *   1. Always keep system messages (first)
 *   2. Always keep the last user message
 *   3. First pass: truncate long tool_result outputs (>500 chars)
 *   4. Second pass: drop tool_result messages oldest-first
 *   5. Last resort: drop oldest non-system messages
 *   6. Final sanitize: remove orphan tool results, stub missing ones so
 *      tool_call/tool_result pairs stay consistent for the provider.
 */
export function trimMessages(messages, budgetTokens, opts) {
    const protectTailCount = opts && Number.isFinite(opts.protectTail)
        ? Math.max(0, opts.protectTail | 0)
        : DEFAULT_PROTECT_TAIL;
    // Skip prune when already under budget. pruneOldToolResults rewrites older
    // tool message content to PRUNE_STUB_TEXT as the protectTail boundary
    // slides forward each iteration, mutating prefix bytes and invalidating
    // any cache_control BP placed on or after that position. Only run prune
    // when the budget actually demands it.
    const sanitizedAsIs = sanitizeToolPairs(messages);
    if (estimateMessagesTokens(sanitizedAsIs) <= budgetTokens)
        return sanitizedAsIs;
    // --- Pass 0: cheap pre-prune (Hermes-style, no LLM). ---
    const prePruned = pruneOldToolResults(sanitizedAsIs, protectTailCount);
    if (estimateMessagesTokens(prePruned) <= budgetTokens)
        return sanitizeToolPairs(prePruned);
    // --- Pass 1: truncate long tool results ---
    let trimmed = truncateToolResults(prePruned);
    if (estimateMessagesTokens(trimmed) <= budgetTokens)
        return sanitizeToolPairs(trimmed);
    // Separate system messages from the rest
    const system = trimmed.filter(m => m.role === 'system');
    const rest = trimmed.filter(m => m.role !== 'system');
    if (rest.length === 0)
        return system;
    const lastMsg = rest[rest.length - 1];
    let middle = rest.slice(0, -1);
    const baseCost = estimateMessagesTokens(system) + estimateMessagesTokens([lastMsg]);
    if (baseCost >= budgetTokens) {
        return sanitizeToolPairs([...system, lastMsg]);
    }
    // --- Pass 2: drop tool-result messages oldest-first (with paired assistant) ---
    let total = estimateMessagesTokens(middle);
    while (total + baseCost > budgetTokens) {
        const toolIdx = middle.findIndex(m => m.role === 'tool');
        if (toolIdx === -1)
            break;
        const toolCallId = middle[toolIdx].toolCallId;
        total -= estimateMessageTokens(middle[toolIdx]);
        middle.splice(toolIdx, 1);
        // Also drop the paired assistant message that issued this tool call
        if (toolCallId) {
            const assistantIdx = middle.findIndex(m =>
                m.role === 'assistant' && Array.isArray(m.toolCalls) &&
                m.toolCalls.some(tc => tc.id === toolCallId)
            );
            if (assistantIdx !== -1) {
                // Only drop the assistant msg if ALL its tool calls have been dropped
                const assistantMsg = middle[assistantIdx];
                const remainingCalls = assistantMsg.toolCalls.filter(tc =>
                    middle.some(m => m.role === 'tool' && m.toolCallId === tc.id)
                );
                if (remainingCalls.length === 0) {
                    total -= estimateMessageTokens(assistantMsg);
                    middle.splice(assistantIdx, 1);
                }
            }
        }
    }
    if (total + baseCost <= budgetTokens) {
        return sanitizeToolPairs([...system, ...middle, lastMsg]);
    }
    // --- Pass 3: drop oldest non-system messages (preserving tool-call pairs) ---
    let remaining = budgetTokens - baseCost;
    const kept = [];
    // Align the starting index so we don't cut into the middle of a tool group
    // (leaves orphan tool results pointing at an assistant we just dropped).
    const startIdx = alignBoundaryBackward(middle, middle.length - 1);
    for (let i = startIdx; i >= 0; i--) {
        const m = middle[i];
        const cost = estimateMessageTokens(m);
        if (remaining - cost < 0)
            break;
        // If this is a tool result, ensure its paired assistant is also in kept
        if (m.role === 'tool' && m.toolCallId) {
            const pairedIdx = middle.findIndex((a, idx) =>
                idx < i && a.role === 'assistant' && Array.isArray(a.toolCalls) &&
                a.toolCalls.some(tc => tc.id === m.toolCallId)
            );
            if (pairedIdx !== -1 && !kept.includes(middle[pairedIdx])) {
                const pairedCost = estimateMessageTokens(middle[pairedIdx]);
                if (remaining - cost - pairedCost < 0)
                    break;
                remaining -= pairedCost;
                kept.unshift(middle[pairedIdx]);
            }
        }
        // If this is an assistant with toolCalls, ensure all tool results are also in kept
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
            const toolResultCosts = m.toolCalls.reduce((sum, tc) => {
                const toolMsg = middle.find(t =>
                    t.role === 'tool' && t.toolCallId === tc.id &&
                    !kept.includes(t)
                );
                return sum + (toolMsg ? estimateMessageTokens(toolMsg) : 0);
            }, 0);
            if (remaining - cost - toolResultCosts < 0)
                break;
            // Add the tool results that haven't been added yet
            for (const tc of m.toolCalls) {
                const toolMsg = middle.find(t =>
                    t.role === 'tool' && t.toolCallId === tc.id &&
                    !kept.includes(t)
                );
                if (toolMsg) {
                    remaining -= estimateMessageTokens(toolMsg);
                    kept.push(toolMsg);
                }
            }
        }
        remaining -= cost;
        kept.unshift(m);
    }
    // Sort kept by original order to preserve conversation flow
    const middleOrder = new Map(middle.map((m, idx) => [m, idx]));
    kept.sort((a, b) => (middleOrder.get(a) ?? 0) - (middleOrder.get(b) ?? 0));
    return sanitizeToolPairs([...system, ...kept, lastMsg]);
}
