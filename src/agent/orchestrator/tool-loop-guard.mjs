/**
 * Tool loop guard — warns on repeated identical failures, aborts only at the ceiling.
 *
 * Signature = sha256(toolName + normalizedArgs + errorCategory).
 * Warn-first policy: detectThreshold emits a synthetic soft-warn string
 *   (see buildSoftWarn) that callers PREPEND onto the just-returned tool
 *   result. Massive legit runs stay alive; the 100-per-axis abort is a
 *   last-resort ceiling, not an early cutoff.
 * Any success, different tool, or different error category resets the state.
 * Recovery guidance lives here as a per-call sidecar — intentionally
 * actionable rather than a standing system-prompt hint.
 */
import { createHash } from 'crypto';
import { loadConfig, getPluginData } from './config.mjs';

const DEFAULT_SAME_TOOL_THRESHOLDS = Object.freeze({
    search: 24,
    recall: 24,
    explore: 24,
    memory_search: 24,
    read: 16,
    grep: 16,
    glob: 16,
    list: 16,
    bash: 20,
    web_search: 3,
});
// Note: web_search appears once with threshold 3 (was duplicated as 24 above
// before; the duplicate has been removed).
// Unified abort ceiling: warn freely, only hard-stop at 100 per axis.
const DEFAULT_SAME_TOOL_ABORT_THRESHOLDS = Object.freeze(
    Object.fromEntries(Object.keys(DEFAULT_SAME_TOOL_THRESHOLDS).map((name) => [name, 100])),
);
const DEFAULT_TOOL_FAMILY_ABORT_THRESHOLDS = Object.freeze({
    structure_probe: 100,
    search_fanout: 100,
});

// Tools where an identical (toolName + args) call directly after an error
// from the same tool is a terminal config-gap signature, not a recoverable
// retry. The strict track aborts on the *second* identical attempt rather
// than waiting for the regular detect/abort thresholds. Applied narrowly
// (web_search default) because most tools have legitimate idempotent
// retries; web_search auth/config errors do not.
const DEFAULT_STRICT_IDENTICAL_ARGS_AFTER_ERROR_TOOLS = Object.freeze(['web_search']);

// Tools whose success signals genuine progress (not probe grinding).
// A successful call to any of these resets the structure_probe and
// search_fanout family counters so probe→edit→probe cycles don't
// accumulate toward abort.
const PRODUCTIVE_TOOLS = Object.freeze(new Set([
    'edit',
    'apply_patch', 'write',
    'bash',
]));

const DEFAULT_CONFIG = Object.freeze({
    detectThreshold: 4,
    abortThreshold: 100,
    sameToolThresholds: DEFAULT_SAME_TOOL_THRESHOLDS,
    sameToolAbortThresholds: DEFAULT_SAME_TOOL_ABORT_THRESHOLDS,
    strictIdenticalArgsAfterErrorTools: DEFAULT_STRICT_IDENTICAL_ARGS_AFTER_ERROR_TOOLS,
    toolFamilyWarnRules: Object.freeze([
        Object.freeze({
            key: 'structure_probe',
            threshold: 12,
            repeatEvery: 16,
            minDistinctTools: 2,
            tools: Object.freeze(['read', 'grep', 'glob', 'list']),
        }),
        Object.freeze({
            key: 'search_fanout',
            threshold: 10,
            repeatEvery: 6,
            minDistinctTools: 2,
            tools: Object.freeze(['search', 'recall', 'explore', 'web_search', 'memory_search']),
        }),
    ]),
    toolFamilyAbortThresholds: DEFAULT_TOOL_FAMILY_ABORT_THRESHOLDS,
    totalToolWarnThresholds: Object.freeze([24, 48, 72, 96]),
    totalToolAbortThresholds: Object.freeze([100]),
});
let _runtimeConfig = null;
let _loadedRuntimeConfig = null;
let _loadedRuntimeConfigTs = 0;
let _loadedRuntimeConfigKey = '';
const RUNTIME_CONFIG_CACHE_TTL_MS = 60_000;

function buildRuntimeConfig(overrides = {}) {
    const sameToolThresholds = {
        ...DEFAULT_CONFIG.sameToolThresholds,
        ...(overrides.sameToolThresholds || {}),
    };
    const sameToolAbortThresholds = {};
    const overrideSameToolAbort = overrides.sameToolAbortThresholds || {};
    for (const name of Object.keys(sameToolThresholds)) {
        const overrideThreshold = overrideSameToolAbort[name];
        if (Number.isFinite(overrideThreshold)) {
            sameToolAbortThresholds[name] = overrideThreshold;
        } else {
            // Use the unified per-axis ceiling (100) rather than warn*2;
            // warn thresholds are intentionally low for early advisory and
            // doubling them would abort far below the documented ceiling.
            sameToolAbortThresholds[name] = DEFAULT_SAME_TOOL_ABORT_THRESHOLDS[name] ?? 100;
        }
    }
    return {
        detectThreshold: Number.isFinite(overrides.detectThreshold) ? overrides.detectThreshold : DEFAULT_CONFIG.detectThreshold,
        abortThreshold: Number.isFinite(overrides.abortThreshold) ? overrides.abortThreshold : DEFAULT_CONFIG.abortThreshold,
        sameToolThresholds: new Map(Object.entries(sameToolThresholds)),
        sameToolAbortThresholds: new Map(Object.entries(sameToolAbortThresholds)),
        toolFamilyWarnRules: (Array.isArray(overrides.toolFamilyWarnRules) ? overrides.toolFamilyWarnRules : DEFAULT_CONFIG.toolFamilyWarnRules)
            .map((rule) => ({
                key: rule.key,
                threshold: rule.threshold,
                repeatEvery: rule.repeatEvery,
                minDistinctTools: rule.minDistinctTools,
                tools: new Set(rule.tools),
            })),
        toolFamilyAbortThresholds: new Map(Object.entries({
            ...DEFAULT_CONFIG.toolFamilyAbortThresholds,
            ...(overrides.toolFamilyAbortThresholds || {}),
        })),
        totalToolWarnThresholds: Array.isArray(overrides.totalToolWarnThresholds)
            ? [...overrides.totalToolWarnThresholds]
            : [...DEFAULT_CONFIG.totalToolWarnThresholds],
        totalToolAbortThresholds: Array.isArray(overrides.totalToolAbortThresholds)
            ? [...overrides.totalToolAbortThresholds]
            : [...DEFAULT_CONFIG.totalToolAbortThresholds],
        strictIdenticalArgsAfterErrorTools: new Set(
            (Array.isArray(overrides.strictIdenticalArgsAfterErrorTools)
                ? overrides.strictIdenticalArgsAfterErrorTools
                : DEFAULT_CONFIG.strictIdenticalArgsAfterErrorTools).map((t) => String(t).toLowerCase()),
        ),
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

function sameToolThreshold(toolName) {
    return getActiveRuntimeConfig().sameToolThresholds.get(String(toolName || '').toLowerCase()) ?? null;
}

function sameToolThresholdFromConfig(config, toolName) {
    return config.sameToolThresholds.get(String(toolName || '').toLowerCase()) ?? null;
}

function sameToolAbortThresholdFromConfig(config, toolName) {
    return config.sameToolAbortThresholds.get(String(toolName || '').toLowerCase()) ?? null;
}

const ERROR_RULES = [
    { cat: 'edit-match-fail', test: (t) => t.includes('old_string') && (t.includes('did not match') || t.includes('not found') || t.includes('match')) },
    { cat: 'fs-not-found', test: (t) => t.includes('enoent') || t.includes('no such file') },
    { cat: 'fs-exists', test: (t) => t.includes('eexist') || t.includes('file exists') },
    { cat: 'rate-limit', test: (t) => t.includes('429') || (t.includes('rate') && t.includes('limit')) },
    { cat: 'permission', test: (t) => t.includes('eacces') || t.includes('permission denied') || t.includes('access denied') },
    { cat: 'timeout', test: (t) => t.includes('etimedout') || t.includes('timed out') || t.includes('timeout') },
    { cat: 'conn-refused', test: (t) => t.includes('econnrefused') || t.includes('connection refused') },
    { cat: 'auth', test: (t) => t.includes('unauthorized') || t.includes('401') || t.includes('invalid api key') },
];

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
    for (const rule of ERROR_RULES) {
        if (rule.test(lower)) return rule.cat;
    }
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
        `Repeated identical calls will abort this session at the per-axis ceiling (100).`,
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
    lines.push(
        `(Advisory only — the call is not blocked.)`,
    );
    return lines.join('\n');
}

export function buildToolFamilyWarn(info) {
    const family = String(info?.familyKey || '');
    const count = Number(info?.count || 0);
    const tools = Array.isArray(info?.tools) ? info.tools : [];
    const abortThreshold = Number.isFinite(info?.abortThreshold) ? info.abortThreshold : null;
    const toolList = tools.length ? tools.map((t) => `\`${t}\``).join(', ') : '`tool`';
    const lines = [
        `⚠ Mixed-tool soft-warn: this session has made ${count} consecutive low-level ${family.replace(/_/g, ' ')} calls across ${toolList}.`,
        `Tools remain available, but before issuing another similar low-level call, switch strategy or narrow sharply:`,
    ];
    if (family === 'structure_probe') {
        lines.push(`- Prefer \`code_graph\` or \`explore\` for the next lookup unless you have a specific new path/range.`);
        lines.push(`- If the needed file/value is already visible, move to \`edit\`/\`apply_patch\` or answer from that evidence instead of another broad \`grep\`/\`read\` pass.`);
    } else if (family === 'edit_roundtrip') {
        lines.push(`- Prefer \`apply_patch\` for the next step instead of another \`edit\` round-trip.`);
        lines.push(`- If the exact change is already clear, emit one multi-file patch and move on.`);
    } else if (family === 'search_fanout') {
        lines.push(`- Batch the next search questions into one call, or synthesize from the evidence you already gathered.`);
        lines.push(`- If the answer is already repo-local, switch from external / memory search back to local tools.`);
    } else {
        lines.push(`- A higher-level tool or a narrower next call will likely yield more than another broad probe.`);
    }
    if (abortThreshold) {
        lines.push(`- Hard stop: at ${abortThreshold} consecutive ${family.replace(/_/g, ' ')} calls this session will abort.`);
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
        // Same-tool repetition tracking — independent of error-loop sig.
        // Counts EVERY call (success or fail) of a whitelisted tool.
        // Resets when a different tool runs.
        sameToolName: null,
        sameToolCount: 0,
        sameToolWarnedFor: new Set(),
        // Strict identical-args-after-error track. Maps toolKey →
        // { argsSha, errorCategory } from the previous call. If the next call
        // for the same tool sends the same argsSha after that prior error,
        // we abort on the second attempt instead of waiting for the normal
        // 4-of-a-kind detect threshold. Used for tools where the failure mode
        // is config-gap, not a recoverable retry (e.g. web_search auth).
        lastCallByTool: new Map(),
        familyRuns: new Map(),
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
 * @returns {{action: 'continue'|'detected'|'abort', info?: object}}
 */
export function checkToolCall(guard, event) {
    const { toolName, args, result, iteration } = event;
    const toolKey = String(toolName || '').toLowerCase();
    const cfg = guard?.config || getActiveRuntimeConfig();
    guard.totalToolCalls += 1;

    // ── Strict identical-args-after-error abort.
    // Whitelisted tools (default: web_search) abort on the SECOND identical
    // (toolName + args) call when the immediately prior call for that tool
    // returned an error. Caller-side config gaps (e.g. invalid GitHub token)
    // surface marker-prefixed errors and would otherwise burn through 6 retries
    // before the same-tool ceiling kicks in.
    if (!guard.lastCallByTool) guard.lastCallByTool = new Map();
    const strictTools = cfg.strictIdenticalArgsAfterErrorTools instanceof Set
        ? cfg.strictIdenticalArgsAfterErrorTools
        : new Set(Array.isArray(cfg.strictIdenticalArgsAfterErrorTools) ? cfg.strictIdenticalArgsAfterErrorTools.map((t) => String(t).toLowerCase()) : []);
    const strictTrackEnabled = strictTools.has(toolKey);
    let strictPriorError = null;
    let strictCurrentArgsSha = null;
    if (strictTrackEnabled) {
        strictCurrentArgsSha = createHash('sha256').update(normalizeArgs(args)).digest('hex').slice(0, 16);
        const prev = guard.lastCallByTool.get(toolKey);
        if (prev && prev.errored && prev.argsSha === strictCurrentArgsSha) {
            strictPriorError = prev;
        }
    }
    if (strictPriorError) {
        const argsSample = (() => {
            try { return JSON.stringify(args).slice(0, 300); } catch { return String(args).slice(0, 300); }
        })();
        const errorSample = String(result).slice(0, 300);
        return {
            action: 'abort',
            info: {
                signature: `identical-args-after-error:${toolKey}:${strictCurrentArgsSha}`,
                toolName,
                errorCategory: 'identical-args-after-error',
                attemptCount: 2,
                argsSample,
                errorSample,
                iteration,
                priorErrorCategory: strictPriorError.errorCategory,
            },
        };
    }

    // ── Same-tool repetition track (independent of error-loop signature).
    // Thresholded whitelist only; non-whitelisted tools also reset the run so an
    // intermixed call sequence breaks the streak.
    let sameToolWarn = null;
    const sameToolWarnThreshold = sameToolThresholdFromConfig(cfg, toolKey);
    const sameToolAbortThreshold = sameToolAbortThresholdFromConfig(cfg, toolKey);
    if (sameToolWarnThreshold !== null) {
        if (guard.sameToolName === toolKey) {
            guard.sameToolCount += 1;
        } else {
            guard.sameToolName = toolKey;
            guard.sameToolCount = 1;
        }
        if (sameToolAbortThreshold !== null && guard.sameToolCount >= sameToolAbortThreshold) {
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
        if (guard.sameToolCount >= sameToolWarnThreshold
            && !guard.sameToolWarnedFor.has(toolKey)) {
            guard.sameToolWarnedFor.add(toolKey);
            sameToolWarn = {
                toolName,
                count: guard.sameToolCount,
                threshold: sameToolWarnThreshold,
                abortThreshold: sameToolAbortThreshold,
                text: buildSameToolWarn({ toolName, count: guard.sameToolCount, abortThreshold: sameToolAbortThreshold }),
            };
        }
    } else {
        guard.sameToolName = null;
        guard.sameToolCount = 0;
    }

    let familyWarn = null;
    for (const rule of cfg.toolFamilyWarnRules) {
        const prev = guard.familyRuns.get(rule.key) || {
            count: 0,
            distinctTools: new Set(),
            warned: false,
            warnedAt: 0,
        };
        const familyAbortThreshold = cfg.toolFamilyAbortThresholds.get(rule.key) ?? null;
        if (rule.tools.has(toolKey)) {
            prev.count += 1;
            prev.distinctTools.add(toolKey);
            if (familyAbortThreshold !== null
                && prev.count >= familyAbortThreshold
                && prev.distinctTools.size >= rule.minDistinctTools) {
                const argsSample = (() => {
                    try { return JSON.stringify(args).slice(0, 300); } catch { return String(args).slice(0, 300); }
                })();
                const errorSample = String(result).slice(0, 300);
                return {
                    action: 'abort',
                    info: {
                        signature: `family:${rule.key}`,
                        toolName,
                        errorCategory: `tool-family@${familyAbortThreshold}:${rule.key}`,
                        attemptCount: prev.count,
                        argsSample,
                        errorSample,
                        iteration,
                        familyKey: rule.key,
                        threshold: familyAbortThreshold,
                        tools: [...prev.distinctTools].sort(),
                    },
                };
            }
            const repeatEvery = Number.isFinite(Number(rule.repeatEvery)) ? Number(rule.repeatEvery) : rule.threshold;
            if (prev.count >= rule.threshold
                && (!prev.warned || prev.count - (prev.warnedAt || 0) >= repeatEvery)
                && prev.distinctTools.size >= rule.minDistinctTools) {
                prev.warned = true;
                prev.warnedAt = prev.count;
                familyWarn = {
                    familyKey: rule.key,
                    count: prev.count,
                    threshold: rule.threshold,
                    tools: [...prev.distinctTools].sort(),
                    text: buildToolFamilyWarn({
                        familyKey: rule.key,
                        count: prev.count,
                        tools: [...prev.distinctTools].sort(),
                        abortThreshold: familyAbortThreshold,
                    }),
                };
            }
        } else {
            prev.count = 0;
            prev.distinctTools = new Set();
            prev.warned = false;
            prev.warnedAt = 0;
        }
        guard.familyRuns.set(rule.key, prev);
    }

    let budgetWarn = null;
    let budgetAbortThreshold = null;
    for (const threshold of cfg.totalToolWarnThresholds) {
        if (guard.totalToolCalls >= threshold && !guard.totalToolWarnedThresholds.has(threshold)) {
            guard.totalToolWarnedThresholds.add(threshold);
            budgetWarn = {
                count: guard.totalToolCalls,
                threshold,
                abortThreshold: null,
                text: buildToolBudgetWarn({ count: guard.totalToolCalls, threshold, abortThreshold: cfg.totalToolAbortThresholds[0] ?? null }),
            };
            break;
        }
    }
    for (const threshold of cfg.totalToolAbortThresholds) {
        if (guard.totalToolCalls >= threshold) {
            budgetAbortThreshold = threshold;
            break;
        }
    }

    if (budgetAbortThreshold !== null) {
        const argsSample = (() => {
            try { return JSON.stringify(args).slice(0, 300); } catch { return String(args).slice(0, 300); }
        })();
        const errorSample = String(result).slice(0, 300);
        return {
            action: 'abort',
            info: {
                signature: `tool-budget:${budgetAbortThreshold}`,
                toolName,
                errorCategory: `tool-budget@${budgetAbortThreshold}`,
                attemptCount: guard.totalToolCalls,
                argsSample,
                errorSample,
                iteration,
                threshold: budgetAbortThreshold,
            },
        };
    }

    if (strictTrackEnabled) {
        const errored = isErrorResult(result);
        guard.lastCallByTool.set(toolKey, {
            argsSha: strictCurrentArgsSha,
            errored,
            errorCategory: errored ? classifyError(result) : null,
        });
    }

    if (!isErrorResult(result)) {
        // Productive-tool reset: a successful edit/bash between probes means
        // the model is making progress, not grinding. Reset structure_probe
        // and search_fanout family counters so legitimate probe→edit→probe
        // cycles don't accumulate toward abort.
        if (PRODUCTIVE_TOOLS.has(toolKey)) {
            for (const rule of cfg.toolFamilyWarnRules) {
                const prev = guard.familyRuns.get(rule.key);
                if (prev) {
                    prev.count = 0;
                    prev.distinctTools = new Set();
                    prev.warned = false;
                }
            }
        }

        // Success resets the error-loop guard (same-tool track stays — it
        // counts both success and failure on whitelisted tools).
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
        if (familyWarn) {
            return {
                action: 'family_warn',
                warnText: familyWarn.text,
                info: { familyKey: familyWarn.familyKey, count: familyWarn.count, threshold: familyWarn.threshold, tools: familyWarn.tools },
            };
        }
        if (budgetWarn) {
            return {
                action: 'budget_warn',
                warnText: budgetWarn.text,
                info: { count: budgetWarn.count, threshold: budgetWarn.threshold, abortThreshold: cfg.totalToolAbortThresholds[0] ?? null },
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
        // Emit the soft-warn sidecar once per run-up. If the signature
        // somehow ticks past the detect threshold more than once for the
        // same run (shouldn't repeat with the per-axis ceiling at 100,
        // but defensive) we don't re-spam the warning.
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
    if (familyWarn) {
        return {
            action: 'family_warn',
            warnText: familyWarn.text,
            info: { familyKey: familyWarn.familyKey, count: familyWarn.count, threshold: familyWarn.threshold, tools: familyWarn.tools },
        };
    }
    if (budgetWarn) {
        return {
            action: 'budget_warn',
            warnText: budgetWarn.text,
            info: { count: budgetWarn.count, threshold: budgetWarn.threshold, abortThreshold: cfg.totalToolAbortThresholds[0] ?? null },
        };
    }
    return { action: 'continue' };
}

/**
 * Strip leading soft-warn marker lines from a body that is about to leave
 * the agent boundary (channel push / external report). Soft-warn markers
 * are intentionally prepended to TOOL RESULTS so the model sees them and
 * self-corrects (see buildSoftWarn / buildRunUpSoftWarn / etc above), but
 * sub-agents tend to echo the marker line as the first line of their own
 * reply. That is fine for self-correction but ugly for the user, so the
 * outbound side strips them right before send.
 *
 * Removes any number of leading lines that match the four canonical
 * marker prefixes, plus a single trailing blank line per stripped marker.
 * Anywhere else in the body is left alone — only the leading run.
 *
 * NEVER call this on the tool-result body that is fed back to the model;
 * that would defeat the self-correction signal.
 */
// Soft-warn blocks are multi-line: the marker line is followed by bullet
// guidance and (for the canonical envelopes) an `(Advisory only — ...)`
// trailer, then a blank-line separator before the actual tool body. The
// previous regex only consumed the marker line, leaving the bullets and
// trailer attached to the body and leaking guidance back into outbound
// merges. Match the full block — marker line plus continuation lines —
// up to the first blank line (or end of string).
const SOFT_WARN_LEADING_RE = /^\s*⚠\s+(?:Tool-loop|Repeated-tool|Mixed-tool|Tool-budget)\s+soft-warn[\s\S]*?(?:\n\s*\n|$)/;
export function stripLeadingSoftWarns(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    // Repeat: multiple markers may stack (one tool call can trigger more
    // than one warn family at once, and a sub-agent may echo all of them
    // back-to-back). Strip until no leading marker remains.
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
