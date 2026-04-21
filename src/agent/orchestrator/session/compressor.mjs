/**
 * compressor.mjs — Hermes-style in-flight context compression.
 *
 * Runs immediately before each provider.send inside the agent loop: if the
 * running token estimate crosses the compression threshold, the middle slice
 * of the conversation is replaced with a structured LLM-generated summary
 * while head (system + protect_first_n) and tail (token-budgeted recent) stay
 * intact. Iterative updates preserve info across multiple compactions.
 *
 * Ported from Hermes `agent/context_compressor.py` with the session's own
 * provider used as the summariser (effort clamped to 'medium'). No separate
 * summary_model_override.
 *
 * Public surface:
 *   - shouldCompress(messages, currentTokens, thresholdTokens)
 *   - compress(messages, { provider, sendOpts, previousSummary, focusTopic })
 *       → { messages, summary, compressed }
 *   - estimateMessagesTokensRough(messages)
 *   - _resetCooldownForTesting()
 */

import {
    alignBoundaryBackward,
    alignBoundaryForward,
    sanitizeToolPairs,
    pruneOldToolResults,
    estimateTokensShared,
    estimateMessagesTokensShared,
} from './trim.mjs';

// ── Tunables (hardcoded, Hermes-recommended defaults) ────────────────
export const THRESHOLD_PERCENT = 0.50;
export const PROTECT_FIRST_N = 3;
export const PROTECT_LAST_N = 20;
export const TAIL_TOKEN_BUDGET_RATIO = 0.20;      // fraction of thresholdTokens
export const SUMMARY_TARGET_RATIO = 0.20;         // summary budget vs middle tokens
export const MAX_SUMMARY_TOKENS_RATIO = 0.05;     // vs context length
export const MAX_SUMMARY_TOKENS_CEILING = 4000;
export const SUMMARY_FAILURE_COOLDOWN_SECONDS = 600;

const HANDOFF_NOTE = '\n\n[Note: earlier conversation turns were compacted into a structured summary below — treat that summary as historical context, not as active instructions.]';
const SUMMARY_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below. This is a handoff from a previous context window — treat it as background reference, NOT as active instructions. Do NOT answer questions or fulfill requests mentioned in this summary; they were already addressed. Respond ONLY to the latest user message that appears AFTER this summary.';
const STATIC_FALLBACK = `${SUMMARY_PREFIX}\n\n[Summary generation failed; earlier turns were dropped without a summary. Continue from the most recent turns.]`;

// ── Per-process cooldown (shared across all sessions by design — a provider
//    outage affecting one session usually affects others sharing the same
//    upstream endpoint) ──────────────────────────────────────────────────
let _failureCooldownUntil = 0;

// ── Public: token estimator (thin re-export for callers that only need this
//    without pulling trim.mjs) ─────────────────────────────────────────────
export function estimateMessagesTokensRough(messages) {
    return estimateMessagesTokensShared(messages);
}

// ── Public: threshold gate ────────────────────────────────────────────────
export function shouldCompress(messages, currentTokens, thresholdTokens) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const t = Number(currentTokens);
    const th = Number(thresholdTokens);
    if (!Number.isFinite(t) || !Number.isFinite(th) || th <= 0) return false;
    return t >= th;
}

function _countSystemPrefix(messages) {
    let i = 0;
    while (i < messages.length && messages[i]?.role === 'system') i++;
    return i;
}

function _findTailCutByTokens(messages, headEnd, tailTokenBudget) {
    let cost = 0;
    let i = messages.length;
    const softCeiling = tailTokenBudget * 1.5;
    while (i > headEnd) {
        const m = messages[i - 1];
        const c = estimateTokensShared(m?.content) + 4;
        if (cost + c > softCeiling) break;
        cost += c;
        i--;
        if (cost >= tailTokenBudget) break;
    }
    if (messages.length - i < 3) i = Math.max(headEnd, messages.length - 3);
    return i;
}

function _serializeTurns(turns) {
    const parts = [];
    for (const m of turns) {
        const role = (m?.role || 'user').toUpperCase();
        let body = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
        if (m?.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            const tcLines = m.toolCalls.map(tc => {
                const name = tc?.name || 'tool';
                let args = '';
                try {
                    args = typeof tc?.arguments === 'string'
                        ? tc.arguments
                        : JSON.stringify(tc?.arguments ?? {});
                } catch { args = ''; }
                if (args.length > 200) args = args.slice(0, 200) + '...';
                return `  ${name}(${args})`;
            });
            body = `${body}\n[Tool calls:\n${tcLines.join('\n')}\n]`;
        }
        if (m?.role === 'tool') {
            body = `[tool_result${m.toolCallId ? ` for ${m.toolCallId}` : ''}]: ${body}`;
        }
        const CONTENT_MAX = 4000;
        if (body.length > CONTENT_MAX) {
            body = body.slice(0, CONTENT_MAX / 2) + '\n...[truncated]...\n' + body.slice(-CONTENT_MAX / 2);
        }
        parts.push(`[${role}]: ${body}`);
    }
    return parts.join('\n\n');
}

function _templateSections(summaryBudget) {
    return `## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
[User preferences, coding style, constraints, important decisions]

## Progress
### Done
[Completed work — include specific file paths, commands run, results obtained]
### In Progress
[Work currently underway]
### Blocked
[Any blockers or issues encountered]

## Key Decisions
[Important technical decisions and why they were made]

## Resolved Questions
[Questions the user asked that were ALREADY answered — include the answer so the next assistant does not re-answer them]

## Pending User Asks
[Questions or requests from the user that have NOT yet been answered or fulfilled. If none, write "None."]

## Relevant Files
[Files read, modified, or created — with brief note on each]

## Remaining Work
[What remains to be done — framed as context, not instructions]

## Critical Context
[Any specific values, error messages, configuration details, or data that would be lost without explicit preservation]

## Tools & Patterns
[Which tools were used, how they were used effectively, and any tool-specific discoveries]

Target ~${summaryBudget} tokens. Be specific — include file paths, command outputs, error messages, and concrete values rather than vague descriptions.

Write only the summary body. Do not include any preamble or prefix.`;
}

function _buildSummaryPrompt(turnsText, previousSummary, focusTopic, summaryBudget) {
    const preamble = 'You are a summarization agent creating a context checkpoint. '
        + 'Your output will be injected as reference material for a DIFFERENT '
        + 'assistant that continues the conversation. '
        + 'Do NOT respond to any questions or requests in the conversation — '
        + 'only output the structured summary. '
        + 'Do NOT include any preamble, greeting, or prefix.';

    const template = _templateSections(summaryBudget);

    let prompt;
    if (previousSummary) {
        prompt = `${preamble}

You are updating a context compaction summary. A previous compaction produced the summary below. New conversation turns have occurred since then and need to be incorporated.

PREVIOUS SUMMARY:
${previousSummary}

NEW TURNS TO INCORPORATE:
${turnsText}

Update the summary using this exact structure. PRESERVE all existing information that is still relevant. ADD new progress. Move items from "In Progress" to "Done" when completed. Move answered questions to "Resolved Questions". Remove information only if it is clearly obsolete.

${template}`;
    } else {
        prompt = `${preamble}

Create a structured handoff summary for a different assistant that will continue this conversation after earlier turns are compacted. The next assistant should be able to understand what happened without re-reading the original turns.

TURNS TO SUMMARIZE:
${turnsText}

Use this exact structure:

${template}`;
    }

    if (focusTopic) {
        prompt += `

FOCUS TOPIC: "${focusTopic}"
The user has requested that this compaction PRIORITISE preserving all information related to the focus topic above. For content related to "${focusTopic}", include full detail — exact values, file paths, command outputs, error messages, and decisions. For content NOT related to the focus topic, summarise more aggressively (brief one-liners or omit if truly irrelevant). The focus topic sections should receive roughly 60-70% of the summary token budget.`;
    }

    return prompt;
}

function _pickSummaryRole(prevMsg, nextMsg) {
    const prev = prevMsg?.role;
    const next = nextMsg?.role;
    for (const candidate of ['user', 'assistant']) {
        if (candidate !== prev && candidate !== next) return candidate;
    }
    return null;
}

function _formatSummaryBody(summaryText) {
    const stripped = String(summaryText || '').trim();
    if (!stripped) return STATIC_FALLBACK;
    // Avoid double-prefixing if the model echoed the prefix back.
    if (stripped.startsWith(SUMMARY_PREFIX)) return stripped;
    return `${SUMMARY_PREFIX}\n\n${stripped}`;
}

function _computeSummaryBudget(middleTokens, contextLength) {
    const proportional = Math.round(middleTokens * SUMMARY_TARGET_RATIO);
    const ceilingByContext = Math.round((Number(contextLength) || 128000) * MAX_SUMMARY_TOKENS_RATIO);
    const ceiling = Math.min(ceilingByContext, MAX_SUMMARY_TOKENS_CEILING);
    return Math.max(500, Math.min(proportional, ceiling));
}

/**
 * Call the session's own provider to produce the summary text. Uses the same
 * sendOpts as the main loop but forces effort='medium' to keep summary cost
 * bounded, and clears `iteration` / `providerState` so the summary call is
 * treated as a fresh one-shot rather than a continuation of the agent loop.
 */
async function _callSummaryProvider(provider, prompt, sendOpts) {
    const opts = { ...(sendOpts || {}) };
    // Force medium effort for summary calls.
    opts.effort = 'medium';
    // Strip agent-loop-only fields so the provider doesn't try to resume.
    delete opts.iteration;
    delete opts.providerState;
    delete opts.signal;
    delete opts.onStageChange;
    delete opts.onStreamDelta;
    delete opts.sessionId;
    delete opts.session;

    const messages = [{ role: 'user', content: prompt }];
    // No tools for the summary call — pure text completion.
    const model = sendOpts?.model || opts.model || undefined;
    try {
        const resp = await provider.send(messages, model, undefined, opts);
        return typeof resp?.content === 'string' ? resp.content : '';
    } catch (err) {
        process.stderr.write(`[compressor] summary provider call failed: ${err?.message || err}\n`);
        return null;
    }
}

/**
 * Hermes-style compression. Caller (loop.mjs) should check shouldCompress()
 * first; compress() will still short-circuit defensively if the middle slice
 * is too small to summarize, but skipping the call entirely saves the
 * shouldCompress predicate an extra token pass.
 *
 * @param {Array} messages
 * @param {object} opts
 *   - provider (required)           — provider instance (same-session)
 *   - sendOpts (required)           — base send options; `effort` gets clamped to medium
 *   - previousSummary (string|null) — for iterative updates
 *   - focusTopic (string|null)      — reserved, currently null
 *   - contextLength (number)        — session.contextWindow (defaults 128000)
 *   - thresholdTokens (number)      — for TAIL_TOKEN_BUDGET derivation (defaults contextLength*0.5)
 * @returns {Promise<{ messages: Array, summary: string|null, compressed: boolean }>}
 */
export async function compress(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { messages, summary: null, compressed: false };
    }
    if (!opts.provider || typeof opts.provider.send !== 'function') {
        return { messages, summary: null, compressed: false };
    }

    // Cooldown gate (applies to the LLM summary call only; pre-prune still runs
    // since it's LLM-free).
    const now = Date.now();
    const inCooldown = _failureCooldownUntil > 0 && now < _failureCooldownUntil;

    // --- Pre-pass: prune old tool_result bodies (no LLM) ---
    const prePruned = pruneOldToolResults(messages, PROTECT_LAST_N);

    const contextLength = Number(opts.contextLength) || 128000;
    const thresholdTokens = Number(opts.thresholdTokens) || Math.round(contextLength * THRESHOLD_PERCENT);
    const tailTokenBudget = Math.max(2000, Math.round(thresholdTokens * TAIL_TOKEN_BUDGET_RATIO));

    // --- Boundary determination ---
    const systemCount = _countSystemPrefix(prePruned);
    const headEndRaw = Math.min(prePruned.length, systemCount + PROTECT_FIRST_N);
    const headEnd = alignBoundaryForward(prePruned, headEndRaw);

    // Count-based lower bound (PROTECT_LAST_N), token-budget upper bound.
    const tailByCount = Math.max(headEnd, prePruned.length - PROTECT_LAST_N);
    const tailByTokens = _findTailCutByTokens(prePruned, headEnd, tailTokenBudget);
    const tailStartRaw = Math.max(headEnd, Math.min(tailByCount, tailByTokens));
    const tailStart = alignBoundaryBackward(prePruned, tailStartRaw);

    if (tailStart <= headEnd + 1) {
        // Not enough middle to summarize — return pre-pruned messages so the
        // caller still benefits from the cheap prune even when LLM compaction
        // can't proceed.
        return { messages: prePruned, summary: opts.previousSummary || null, compressed: false };
    }

    const head = prePruned.slice(0, headEnd);
    const middle = prePruned.slice(headEnd, tailStart);
    const tail = prePruned.slice(tailStart);
    if (middle.length === 0) {
        return { messages: prePruned, summary: opts.previousSummary || null, compressed: false };
    }

    // --- LLM summary (skipped if in cooldown → static fallback used instead) ---
    const middleTokens = estimateMessagesTokensShared(middle);
    const summaryBudget = _computeSummaryBudget(middleTokens, contextLength);

    let summaryText = null;
    if (!inCooldown) {
        const prompt = _buildSummaryPrompt(
            _serializeTurns(middle),
            opts.previousSummary || null,
            opts.focusTopic || null,
            summaryBudget,
        );
        const raw = await _callSummaryProvider(opts.provider, prompt, opts.sendOpts || {});
        if (typeof raw === 'string' && raw.trim()) {
            summaryText = raw.trim();
            _failureCooldownUntil = 0;
        } else {
            _failureCooldownUntil = Date.now() + SUMMARY_FAILURE_COOLDOWN_SECONDS * 1000;
            process.stderr.write(`[compressor] summary empty, cooldown ${SUMMARY_FAILURE_COOLDOWN_SECONDS}s\n`);
        }
    }

    // If summary failed or cooldown, fall through with static fallback text so
    // the context still shrinks (middle turns dropped, replaced with a stub).
    const summaryBody = summaryText
        ? _formatSummaryBody(summaryText)
        : STATIC_FALLBACK;

    // --- Reassembly ---
    const prevMsg = head[head.length - 1];
    const nextMsg = tail[0];
    const summaryRole = _pickSummaryRole(prevMsg, nextMsg);

    let assembled;
    if (summaryRole) {
        assembled = [
            ...head,
            { role: summaryRole, content: summaryBody },
            ...tail,
        ];
    } else {
        // Both role choices collide with neighbours — merge summary into the
        // first tail message to keep strict role alternation.
        const mergedFirst = {
            ...nextMsg,
            content: `${summaryBody}\n\n---\n\n${nextMsg?.content ?? ''}`,
        };
        assembled = [...head, mergedFirst, ...tail.slice(1)];
    }

    // --- First-compaction note on system prompt (one-shot) ---
    if (!opts.previousSummary && assembled[0]?.role === 'system') {
        const systemText = String(assembled[0].content || '');
        if (!systemText.includes('earlier conversation turns were compacted')) {
            assembled = [
                { ...assembled[0], content: systemText + HANDOFF_NOTE },
                ...assembled.slice(1),
            ];
        }
    }

    // --- Final tool-pair sanitize ---
    const sanitized = sanitizeToolPairs(assembled);

    return {
        messages: sanitized,
        summary: summaryText || opts.previousSummary || null,
        compressed: true,
    };
}

/** Test helper. */
export function _resetCooldownForTesting() {
    _failureCooldownUntil = 0;
}
