/**
 * Tool loop guard — warns on repeated identical failures, aborts only at the ceiling.
 *
 * Signature = sha256(toolName + normalizedArgs + errorCategory).
 * Warn-first policy: detectThreshold emits a synthetic soft-warn string
 *   (see buildSoftWarn) that callers PREPEND onto the just-returned tool
 *   result. The hard abort is a last-resort safety ceiling, not an early cutoff.
 * Any success resets the error-loop state.
 * Recovery guidance lives here as a per-call sidecar — intentionally
 * actionable rather than a standing system-prompt hint.
 *
 * Safety-envelope constants (not classifiers — tune via config.bridge.toolLoopGuard):
 *   SAME_TOOL_WARN_DEFAULT  — warn after this many consecutive same-tool calls (any tool)
 *   SAME_TOOL_ABORT         — hard-stop ceiling for consecutive same-tool calls
 *   TOTAL_WARN              — warn when total session tool calls cross this count
 *   TOTAL_ABORT             — hard-stop ceiling for total session tool calls
 */
import { createHash } from 'crypto';
import { loadConfig, getPluginData } from './config.mjs';

// Uniform same-tool warn threshold — applies to every tool without per-tool tuning.
const SAME_TOOL_WARN_DEFAULT = 4;

// Hard abort ceiling for consecutive same-tool calls.
const SAME_TOOL_ABORT = 100;

// Single total-call warn threshold.
const TOTAL_WARN = 50;

// Hard abort ceiling for total tool calls in a session.
const TOTAL_ABORT = 100;

const DEFAULT_CONFIG = Object.freeze({
    detectThreshold: 4,
    abortThreshold: TOTAL_ABORT,
    sameToolWarnDefault: SAME_TOOL_WARN_DEFAULT,
    sameToolAbort: SAME_TOOL_ABORT,
    totalToolWarnThreshold: TOTAL_WARN,
    totalToolAbortThreshold: TOTAL_ABORT,
});

let _runtimeConfig = null;
let _loadedRuntimeConfig = null;
let _loadedRuntimeConfigTs = 0;
let _loadedRuntimeConfigKey = '';
const RUNTIME_CONFIG_CACHE_TTL_MS = 60_000;

function buildRuntimeConfig(overrides = {}) {
    return {
        detectThreshold: Number.isFinite(overrides.detectThreshold) ? overrides.detectThreshold : DEFAULT_CONFIG.detectThreshold,
        abortThreshold: Number.isFinite(overrides.abortThreshold) ? overrides.abortThreshold : DEFAULT_CONFIG.abortThreshold,
        sameToolWarnDefault: Number.isFinite(overrides.sameToolWarnDefault) ? overrides.sameToolWarnDefault : DEFAULT_CONFIG.sameToolWarnDefault,
        sameToolAbort: Number.isFinite(overrides.sameToolAbort) ? overrides.sameToolAbort : DEFAULT_CONFIG.sameToolAbort,
        totalToolWarnThreshold: Number.isFinite(overrides.totalToolWarnThreshold) ? overrides.totalToolWarnThreshold : DEFAULT_CONFIG.totalToolWarnThreshold,
        totalToolAbortThreshold: Number.isFinite(overrides.totalToolAbortThreshold) ? overrides.totalToolAbortThreshold : DEFAULT_CONFIG.totalToolAbortThreshold,
    };
}

function clearLoadedRuntimeConfigCache() {
    _loadedRuntimeConfig = null;
    _loadedRuntimeConfigTs = 0;
    _loadedRuntimeConfigKey = '';
}

function getLoadedRuntimeConfig() {
    const key = getPluginData();
    const now = Date.now();
    if (_loadedRuntimeConfig && _loadedRuntimeConfigKey === key && now - _loadedRuntimeConfigTs < RUNTIME_CONFIG_CACHE_TTL_MS) {
        return _loadedRuntimeConfig;
    }
    let overrides = {};
    try {
        overrides = loadConfig()?.bridge?.toolLoopGuard || {};
    } catch {
        overrides = {};
    }
    _loadedRuntimeConfig = buildRuntimeConfig(overrides);
    _loadedRuntimeConfigTs = now;
    _loadedRuntimeConfigKey = key;
    return _loadedRuntimeConfig;
}

function getActiveRuntimeConfig() {
    return _runtimeConfig || getLoadedRuntimeConfig();
}

export class ToolLoopAbortError extends Error {
    constructor(info) {
        const msg = `tool loop aborted after ${info.attemptCount}x ${info.toolName}:${info.errorCategory}`;
        super(msg);
        this.name = 'ToolLoopAbortError';
        this.info = info;
    }
}

function normalizeArgs(args) {
    if (args === null || args === undefined) return '';
    if (typeof args !== 'object') return String(args);
    try {
        const keys = Object.keys(args).sort();
        const normalized = {};
        for (const k of keys) {
            const v = args[k];
            if (typeof v === 'string') {
                // Collapse whitespace variance that doesn't affect semantics but changes hash.
                normalized[k] = v.replace(/\s+/g, ' ').trim().slice(0, 500);
            } else {
                normalized[k] = v;
            }
        }
        return JSON.stringify(normalized);
    } catch {
        return String(args);
    }
}

function classifyError(errorText) {
    if (!errorText) return 'unknown';
    const lower = String(errorText).toLowerCase();
    // Unambiguous OS-level codes and well-known HTTP markers only.
    // Domain-specific provider heuristics (429, "rate limit", "timeout") removed —
    // callers receiving typed runtime errors should pass the category directly.
    if (lower.includes('old_string') && (lower.includes('did not match') || lower.includes('not found') || lower.includes('match'))) return 'edit-match-fail';
    if (lower.includes('enoent') || lower.includes('no such file')) return 'fs-not-found';
    if (lower.includes('eexist') || lower.includes('file exists')) return 'fs-exists';
    if (lower.includes('eacces') || lower.includes('permission denied') || lower.includes('access denied')) return 'permission';
    if (lower.includes('econnrefused') || lower.includes('connection refused')) return 'conn-refused';
    if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('invalid api key')) return 'auth';
    if (lower.startsWith('error:')) {
        const firstLine = lower.split('\n')[0].slice(0, 80);
        const hash = createHash('sha256').update(firstLine).digest('hex').slice(0, 8);
        return `generic:${hash}`;
    }
    return 'unknown';
}

function isErrorResult(result) {
    if (typeof result !== 'string') return false;
    const lower = result.toLowerCase().trim();
    return lower.startsWith('error:') || lower.startsWith('[error');
}

function signatureOf(toolName, args, errorCategory) {
    const normArgs = normalizeArgs(args);
    return createHash('sha256')
        .update(`${toolName}:${normArgs}:${errorCategory}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * Build the soft-warn sidecar text for a 'detected' event. Callers should
 * prepend this onto the corresponding tool result so the model sees it
 * while processing that result (not as a standalone message).
 *
 * @param {{toolName: string, signature: string, errorCategory: string}} info
 * @returns {string}
 */
export function buildSoftWarn(info) {
    const sigShort = String(info.signature || '').slice(0, 8) || 'unknown';
    const toolName = info.toolName || 'tool';
    return [
        `⚠ Tool-loop soft-warn: the same \`${toolName}\` call (signature \`${sigShort}\`) has returned the same result/error 4 times in a row. Before calling this again, reconsider whether you need a different approach:`,
        `- Different arguments (broader/narrower pattern, different path, different glob)`,
        `- A different tool (explore instead of grep, read instead of glob, etc.)`,
        `- Accept the current result and move on`,
        `Repeated identical calls will abort this session at the ceiling (${TOTAL_ABORT}).`,
    ].join('\n');
}

/**
 * Build the soft-warn sidecar text for a same-tool run-up. Caller prepends
 * this onto the corresponding tool result so the model reads it inline.
 */
export function buildSameToolWarn(info) {
    const toolName = info.toolName || 'tool';
    const toolKey = String(toolName).toLowerCase();
    const abortThreshold = Number.isFinite(info.abortThreshold) ? info.abortThreshold : null;
    const lines = [
        `⚠ Repeated-tool soft-warn: \`${toolName}\` has been called ${info.count} times in this session.`,
        `Before calling \`${toolName}\` again, consider:`,
    ];
    if (toolKey === 'read') {
        lines.push(`- Batch file paths into one read call (array \`path\`) instead of serial reads.`);
        lines.push(`- If you are still locating the code, use \`grep\` / \`glob\` first; if you already know the hit, use \`offset\` / \`limit\` instead of re-reading whole files.`);
    } else if (toolKey === 'grep') {
        lines.push(`- OR-join multiple patterns / globs in one \`grep\` call instead of serial probes.`);
        lines.push(`- If the exact file is known, switch to \`read\`; if this is a structural/symbol lookup, prefer \`code_graph\`.`);
    } else if (toolKey === 'glob') {
        lines.push(`- Batch patterns in one \`glob\` call, then switch to \`read\` / \`grep\` once you have hits.`);
        lines.push(`- A broader or repeated \`glob\` rarely helps after 2 rounds unless the root path changed.`);
    } else if (toolKey === 'bash') {
        lines.push(`- Combine dependent commands with \`&&\` / \`;\` instead of multiple one-line bash turns.`);
        lines.push(`- If you need shell state across turns (cwd, env, venv), pass \`persistent:true\` to \`bash\` instead of replaying setup commands.`);
    } else if (toolKey === 'bash_session') {
        lines.push(`- Reuse one \`session_id\` and run the next meaningful command, not another setup/probe variant of the same step.`);
        lines.push(`- If the shell already told you enough, synthesize the result before issuing another command.`);
    } else if (toolKey === 'search' || toolKey === 'recall' || toolKey === 'explore' || toolKey === 'web_search' || toolKey === 'memory_search') {
        lines.push(`- Batch related queries in one call and narrow by root/site/type before widening again.`);
        lines.push(`- If the first 1-2 rounds grounded the answer, synthesize now instead of probing a third angle.`);
    } else {
        lines.push(`- You likely have enough information already — synthesize and proceed.`);
        lines.push(`- A different tool may yield more (e.g. read for known files, grep for in-file content, code_graph for structure).`);
    }
    lines.push(`- If you DO call again, narrow the next query meaningfully (different angle, narrower scope, different cwd).`);
    if (abortThreshold) {
        lines.push(`- Hard stop: at ${abortThreshold} repeated \`${toolName}\` calls this session will abort.`);
    }
    lines.push(`(Advisory only — the call is not blocked.)`);
    return lines.join('\n');
}

export function buildToolBudgetWarn(info) {
    const count = Number(info?.count || 0);
    const abortThreshold = Number.isFinite(info?.abortThreshold) ? info.abortThreshold : null;
    const lines = [
        `⚠ Tool-budget soft-warn: this session has already made ${count} tool calls.`,
        `Tools remain available, but before calling another tool (low-level file or high-level retrieval), pause and consider:`,
        `- Do you already have enough evidence to synthesize an answer or patch?`,
        `- If not, can you switch up a level: \`code_graph\` for structure, \`apply_patch\` for clear edits, \`bash\` with \`persistent:true\` for stateful shell work?`,
        `- For \`recall\` / \`search\` / \`explore\` / \`web_search\` / \`memory_search\`: if you've already gotten an answer, synthesize from it; do not re-call the same family with paraphrased queries.`,
        `- If you still need another call, make it meaningfully narrower than the previous one.`,
        ...(abortThreshold ? [`- Hard stop: at ${abortThreshold} total tool calls this session will abort.`] : []),
        `(Advisory only — the call is not blocked.)`,
    ];
    return lines.join('\n');
}

/**
 * Create a fresh guard state, one per agent loop / session.
 */
export function createGuard() {
    return {
        config: getActiveRuntimeConfig(),
        currentSig: null,
        count: 0,
        lastInfo: null,
        warnedSig: null, // last signature we emitted a soft-warn for
        // Same-tool repetition tracking — counts every call (success or fail).
        // Resets when a different tool runs.
        sameToolName: null,
        sameToolCount: 0,
        sameToolWarnedFor: new Set(),
        totalToolCalls: 0,
        totalToolWarnedThresholds: new Set(),
    };
}

export function setGuardConfigForTesting(overrides = {}) {
    _runtimeConfig = buildRuntimeConfig(overrides);
}

export function resetGuardConfigForTesting() {
    _runtimeConfig = null;
    clearLoadedRuntimeConfigCache();
}

/**
 * Feed a tool call result to the guard and decide the next action.
 *
 * @param {object} guard - state from createGuard()
 * @param {{toolName: string, args: any, result: any, iteration: number}} event
 * @returns {{action: 'continue'|'detected'|'same_tool_warn'|'budget_warn'|'abort', info?: object, warnText?: string}}
 */
export function checkToolCall(guard, event) {
    const { toolName, args, result, iteration } = event;
    const toolKey = String(toolName || '').toLowerCase();
    const cfg = guard?.config || getActiveRuntimeConfig();
    guard.totalToolCalls += 1;

    // ── Same-tool repetition (applies uniformly to all tools).
    let sameToolWarn = null;
    const sameToolWarnThreshold = cfg.sameToolWarnDefault;
    const sameToolAbortThreshold = cfg.sameToolAbort;
    if (guard.sameToolName === toolKey) {
        guard.sameToolCount += 1;
    } else {
        guard.sameToolName = toolKey;
        guard.sameToolCount = 1;
    }
    if (guard.sameToolCount >= sameToolAbortThreshold) {
        const argsSample = (() => {
            try { return JSON.stringify(args).slice(0, 300); } catch { return String(args).slice(0, 300); }
        })();
        const errorSample = String(result).slice(0, 300);
        return {
            action: 'abort',
            info: {
                signature: `same-tool:${toolKey}`,
                toolName,
                errorCategory: `same-tool-repeat@${sameToolAbortThreshold}`,
                attemptCount: guard.sameToolCount,
                argsSample,
                errorSample,
                iteration,
                threshold: sameToolAbortThreshold,
            },
        };
    }
    if (guard.sameToolCount >= sameToolWarnThreshold && !guard.sameToolWarnedFor.has(toolKey)) {
        guard.sameToolWarnedFor.add(toolKey);
        sameToolWarn = {
            toolName,
            count: guard.sameToolCount,
            threshold: sameToolWarnThreshold,
            abortThreshold: sameToolAbortThreshold,
            text: buildSameToolWarn({ toolName, count: guard.sameToolCount, abortThreshold: sameToolAbortThreshold }),
        };
    }

    // ── Total tool budget.
    let budgetWarn = null;
    const totalWarnThreshold = cfg.totalToolWarnThreshold;
    const totalAbortThreshold = cfg.totalToolAbortThreshold;
    if (guard.totalToolCalls >= totalAbortThreshold) {
        const argsSample = (() => {
            try { return JSON.stringify(args).slice(0, 300); } catch { return String(args).slice(0, 300); }
        })();
        const errorSample = String(result).slice(0, 300);
        return {
            action: 'abort',
            info: {
                signature: `tool-budget:${totalAbortThreshold}`,
                toolName,
                errorCategory: `tool-budget@${totalAbortThreshold}`,
                attemptCount: guard.totalToolCalls,
                argsSample,
                errorSample,
                iteration,
                threshold: totalAbortThreshold,
            },
        };
    }
    if (guard.totalToolCalls >= totalWarnThreshold && !guard.totalToolWarnedThresholds.has(totalWarnThreshold)) {
        guard.totalToolWarnedThresholds.add(totalWarnThreshold);
        budgetWarn = {
            count: guard.totalToolCalls,
            threshold: totalWarnThreshold,
            abortThreshold: totalAbortThreshold,
            text: buildToolBudgetWarn({ count: guard.totalToolCalls, threshold: totalWarnThreshold, abortThreshold: totalAbortThreshold }),
        };
    }

    if (!isErrorResult(result)) {
        // Success resets the error-loop guard (same-tool track stays — it
        // counts both success and failure).
        guard.currentSig = null;
        guard.count = 0;
        guard.lastInfo = null;
        guard.warnedSig = null;
        if (sameToolWarn) {
            return {
                action: 'same_tool_warn',
                warnText: sameToolWarn.text,
                info: { toolName: sameToolWarn.toolName, count: sameToolWarn.count, threshold: sameToolWarn.threshold, abortThreshold: sameToolWarn.abortThreshold },
            };
        }
        if (budgetWarn) {
            return {
                action: 'budget_warn',
                warnText: budgetWarn.text,
                info: { count: budgetWarn.count, threshold: budgetWarn.threshold, abortThreshold: totalAbortThreshold },
            };
        }
        return { action: 'continue' };
    }

    const errorCategory = classifyError(result);
    const signature = signatureOf(toolName, args, errorCategory);

    if (signature === guard.currentSig) {
        guard.count += 1;
    } else {
        guard.currentSig = signature;
        guard.count = 1;
        // Any signature change clears the 'already warned' marker so a
        // fresh run-up can re-emit a warn on its own 4th call.
        guard.warnedSig = null;
    }

    const argsSample = (() => {
        try { return JSON.stringify(args).slice(0, 300); } catch { return String(args).slice(0, 300); }
    })();
    const errorSample = String(result).slice(0, 300);

    const info = {
        signature,
        toolName,
        errorCategory,
        attemptCount: guard.count,
        argsSample,
        errorSample,
        iteration,
    };
    guard.lastInfo = info;

    if (guard.count >= cfg.abortThreshold) {
        return { action: 'abort', info };
    }
    if (guard.count >= cfg.detectThreshold) {
        // Emit the soft-warn sidecar once per run-up.
        const warnText = guard.warnedSig === signature ? null : buildSoftWarn(info);
        guard.warnedSig = signature;
        return { action: 'detected', info, warnText };
    }
    if (sameToolWarn) {
        return {
            action: 'same_tool_warn',
            warnText: sameToolWarn.text,
            info: { toolName: sameToolWarn.toolName, count: sameToolWarn.count, threshold: sameToolWarn.threshold, abortThreshold: sameToolWarn.abortThreshold },
        };
    }
    if (budgetWarn) {
        return {
            action: 'budget_warn',
            warnText: budgetWarn.text,
            info: { count: budgetWarn.count, threshold: budgetWarn.threshold, abortThreshold: totalAbortThreshold },
        };
    }
    return { action: 'continue' };
}

/**
 * Strip leading soft-warn marker lines from a body that is about to leave
 * the agent boundary (channel push / external report). Soft-warn markers
 * are intentionally prepended to TOOL RESULTS so the model sees them and
 * self-corrects, but sub-agents tend to echo the marker line as the first
 * line of their own reply. Strip before send; never call on tool-result
 * bodies fed back to the model.
 *
 * Removes any number of leading soft-warn blocks (marker line + continuation
 * up to first blank line) in sequence.
 */
const SOFT_WARN_LEADING_RE = /^\s*⚠\s+(?:Tool-loop|Repeated-tool|Tool-budget)\s+soft-warn[\s\S]*?(?:\n\s*\n|$)/;
export function stripLeadingSoftWarns(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    while (SOFT_WARN_LEADING_RE.test(out)) {
        out = out.replace(SOFT_WARN_LEADING_RE, '');
    }
    return out;
}

// Exposed for tests — internal helpers.
export const DEFAULT_TOOL_LOOP_GUARD_CONFIG = DEFAULT_CONFIG;
export const _internals = {
    normalizeArgs,
    classifyError,
    isErrorResult,
    signatureOf,
    getActiveRuntimeConfig,
    clearLoadedRuntimeConfigCache,
};
