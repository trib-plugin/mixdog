import { isOffloadedToolResultText } from './tool-result-offload.mjs';

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
const TOOL_MISSING_STUB = '[Result from earlier conversation — see context summary above]';
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
 * Final-mile pairing for Anthropic API content arrays. Operates on the
 * already-converted format (role: assistant|user|system, content: block[])
 * — the mixdog-internal sanitizeToolPairs only sees toolCalls/toolCallId
 * fields and misses cases where tool_use blocks were pushed directly into
 * content (streaming chunk inserts, salvage paths, etc.). Without this
 * pass, an unmatched tool_use can reach the provider and trigger
 * `messages.N: tool_use ids were found without tool_result blocks
 * immediately after`.
 */
export function sanitizeAnthropicContentPairs(messages) {
    if (!Array.isArray(messages)) return messages;
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        // Drop tool_use blocks without an id from assistant messages — these
        // come from partial streaming chunks that never finalised, and the
        // provider rejects them as `tool_use ids were found without
        // tool_result blocks` even though no id was actually emitted.
        if (m?.role === 'assistant' && Array.isArray(m.content)) {
            const cleaned = m.content.filter(
                (b) => !(b?.type === 'tool_use' && !b.id),
            );
            if (cleaned.length !== m.content.length) {
                m.content = cleaned;
            }
        }
        out.push(m);
        if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
        const toolUseIds = m.content
            .filter((b) => b?.type === 'tool_use' && b.id)
            .map((b) => b.id);
        if (toolUseIds.length === 0) continue;
        const next = messages[i + 1];
        const nextResultIds = (next?.role === 'user' && Array.isArray(next.content))
            ? new Set(
                next.content
                    .filter((b) => b?.type === 'tool_result' && b.tool_use_id)
                    .map((b) => b.tool_use_id),
            )
            : new Set();
        const missing = toolUseIds.filter((id) => !nextResultIds.has(id));
        if (missing.length === 0) continue;
        const stubs = missing.map((id) => ({
            type: 'tool_result',
            tool_use_id: id,
            content: '[tool_result missing — recovered by sanitizeAnthropicContentPairs]',
            is_error: true,
        }));
        if (next?.role === 'user' && Array.isArray(next.content)) {
            // Anthropic requires tool_result blocks to lead the user message
            // when responding to a prior tool_use. Reorder existing content
            // so all tool_result blocks come first, followed by text/other.
            const existingResults = next.content.filter((b) => b?.type === 'tool_result');
            const nonResults = next.content.filter((b) => b?.type !== 'tool_result');
            next.content = [...stubs, ...existingResults, ...nonResults];
        } else {
            out.push({ role: 'user', content: stubs });
        }
    }
    return out;
}

/**
 * Trim messages to fit within a token budget.
 *
 * Single linear path — no fallback chain:
 *   1. Sanitize tool pairs on entry.
 *   2. Return as-is if already within budget.
 *   3. Drop tool result messages oldest-first; also drop paired assistant
 *      once all its tool calls are gone.
 *   4. If still over budget, drop oldest non-system messages respecting
 *      tool-call group boundaries.
 *   5. Final sanitize + safety loop absorbs stub-insertion overshoot.
 *
 * budgetTokens MUST be derived from the model's context window by the
 * caller (session.contextWindow * safetyFactor). Passing 0 or a negative
 * value is a caller error and throws immediately.
 */
export function trimMessages(messages, budgetTokens) {
    if (!(budgetTokens > 0)) throw new Error();

    const sanitized = sanitizeToolPairs(messages);
    if (estimateMessagesTokens(sanitized) <= budgetTokens) return sanitized;

    const system = sanitized.filter(m => m.role === 'system');
    const rest = sanitized.filter(m => m.role !== 'system');
    if (rest.length === 0) return system;

    const lastMsg = rest[rest.length - 1];
    let middle = rest.slice(0, -1);
    const baseCost = estimateMessagesTokens(system) + estimateMessagesTokens([lastMsg]);

    if (baseCost >= budgetTokens) throw new Error(`trimMessages: cannot fit even system+last message within budget=${budgetTokens} (base=${baseCost})`);

    // Pass 1: drop tool results oldest-first; drop paired assistant when all its calls are gone.
    let total = estimateMessagesTokens(middle);
    while (total + baseCost > budgetTokens) {
        const toolIdx = middle.findIndex(m => m.role === 'tool');
        if (toolIdx === -1) break;
        const toolCallId = middle[toolIdx].toolCallId;
        total -= estimateMessageTokens(middle[toolIdx]);
        middle.splice(toolIdx, 1);
        if (toolCallId) {
            const assistantIdx = middle.findIndex(m =>
                m.role === 'assistant' && Array.isArray(m.toolCalls) &&
                m.toolCalls.some(tc => tc.id === toolCallId)
            );
            if (assistantIdx !== -1) {
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
        const s = sanitizeToolPairs([...system, ...middle, lastMsg]);
        if (estimateMessagesTokens(s) <= budgetTokens) return s;
        // sanitizeToolPairs stub inserts pushed back over budget — fall through to Pass 2.
        middle = s.filter((m, i, a) => m.role !== 'system' && i < a.length - 1);
    }

    // Pass 2: drop oldest non-system messages, respecting tool-call group boundaries.
    let remaining = budgetTokens - baseCost;
    const kept = [];
    const startIdx = alignBoundaryBackward(middle, middle.length - 1);
    for (let i = startIdx; i >= 0; i--) {
        const m = middle[i];
        const cost = estimateMessageTokens(m);
        if (remaining - cost < 0) break;
        if (m.role === 'tool' && m.toolCallId) {
            const pairedIdx = middle.findIndex((a, idx) =>
                idx < i && a.role === 'assistant' && Array.isArray(a.toolCalls) &&
                a.toolCalls.some(tc => tc.id === m.toolCallId)
            );
            if (pairedIdx !== -1 && !kept.includes(middle[pairedIdx])) {
                const pairedCost = estimateMessageTokens(middle[pairedIdx]);
                if (remaining - cost - pairedCost < 0) break;
                remaining -= pairedCost;
                kept.unshift(middle[pairedIdx]);
            }
        }
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
            const toolResultCosts = m.toolCalls.reduce((sum, tc) => {
                const toolMsg = middle.find(t =>
                    t.role === 'tool' && t.toolCallId === tc.id && !kept.includes(t)
                );
                return sum + (toolMsg ? estimateMessageTokens(toolMsg) : 0);
            }, 0);
            if (remaining - cost - toolResultCosts < 0) break;
            for (const tc of m.toolCalls) {
                const toolMsg = middle.find(t =>
                    t.role === 'tool' && t.toolCallId === tc.id && !kept.includes(t)
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

    const middleOrder = new Map(middle.map((m, idx) => [m, idx]));
    kept.sort((a, b) => (middleOrder.get(a) ?? 0) - (middleOrder.get(b) ?? 0));

    let result = sanitizeToolPairs([...system, ...kept, lastMsg]);
    let safety = 16;
    while (
        safety-- > 0
        && result.length > system.length + 1
        && estimateMessagesTokens(result) > budgetTokens
    ) {
        result.splice(system.length, 1);
        result = sanitizeToolPairs(result);
    }
    const finalTokens = estimateMessagesTokens(result);
    if (finalTokens > budgetTokens) throw new Error(`trimMessages: exhausted drop strategy, result=${finalTokens} > budget=${budgetTokens}`);
    return result;
}
