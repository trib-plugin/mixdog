import { executeMcpTool, isMcpTool, mcpToolHasField } from '../mcp/client.mjs';
import { executeBuiltinTool, isBuiltinTool } from '../tools/builtin.mjs';
import { executeBashSessionTool } from '../tools/bash-session.mjs';
import { executePatchTool } from '../tools/patch.mjs';
import { executeCodeGraphTool, isCodeGraphTool } from '../tools/code-graph.mjs';
import { executeInternalTool, isInternalTool } from '../internal-tools.mjs';
import { collectSkillsCached, loadSkillContent } from '../context/collect.mjs';
import { traceBridgeLoop, traceBridgeTool, traceBridgeTrim, traceToolLoopAborted, traceToolLoopDetected, traceToolLoopWarn, estimateProviderPayloadBytes, messagePrefixHash } from '../bridge-trace.mjs';
import { markSessionToolCall, updateSessionStage, SessionClosedError, getSessionAbortSignal } from './manager.mjs';
import { trimMessages } from './trim.mjs';
import { createGuard, checkToolCall, ToolLoopAbortError } from '../tool-loop-guard.mjs';
import { maybeOffloadToolResult } from './tool-result-offload.mjs';
import { compressToolResult, recordToolBatch } from '../tools/result-compression.mjs';
import { isHiddenRole } from '../internal-roles.mjs';
import { loadConfig } from '../config.mjs';
import { createRequire } from 'module';
import { readFileSync as _readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve as resolvePath } from 'path';
// Load the CJS permission evaluator. The hooks/ directory lives two levels
// above src/agent/orchestrator/session/, so we walk up from __dirname.
const _require = createRequire(import.meta.url);
const _hooksLib = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../hooks/lib/permission-evaluator.cjs');
const { evaluatePermission: _evaluatePermission } = _require(_hooksLib);
const MCP_TOOL_PREFIX = 'mcp__plugin_mixdog_mixdog__';
const SAFETY_TRIM_PERCENT = 0.90;
const SOFT_ITERATION_WARN_THRESHOLDS = Object.freeze([24, 48, 96]);
const EMERGENCY_ITERATION_FUSE = 100;
// Per-role iteration caps are declared in defaults/hidden-roles.json under
// `iterationCap: { soft, hard }`. The default fallback applies when a role
// has no entry there, or for user-defined roles from user-workflow.json.
// agent-config.json `bridge.iterationCaps` still overrides at call time.
// opts.iterationEmergencyFuse wins for benchmarks / batch jobs.
const _HIDDEN_ROLES_JSON = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../defaults/hidden-roles.json');
let _hiddenRolesCache = null;
function _getHiddenRoles() {
    if (_hiddenRolesCache) return _hiddenRolesCache;
    try {
        _hiddenRolesCache = JSON.parse(_readFileSync(_HIDDEN_ROLES_JSON, 'utf8'));
    } catch { _hiddenRolesCache = { roles: [] }; }
    return _hiddenRolesCache;
}
// Transcript pairing guard. Anthropic 400-rejects when an assistant message
// ends with tool_use blocks and the next message isn't tool results for
// those exact ids. abort/timeout/error race in the loop body can leave a
// dangling assistant tool_use at the tail (e.g. the structure_probe loop
// running 12 deep then aborting between push-assistant and push-tool).
// Strip any trailing assistant tool_use that has no matching tool result
// so provider.send sees a valid transcript instead of leaking the 400 to
// the user. Repair runs every iteration but is a no-op on healthy paths.
function _ensureTranscriptPairing(msgs, sessionId) {
    // Walk backwards to find the last assistant message that emitted
    // tool_use, then validate that every id has a matching tool result
    // inside the CONTIGUOUS tool-message block immediately following it.
    // Earlier guard splice'd the entire tail — which silently deleted any
    // user prompt appended after the dangling assistant by manager.mjs:
    // when the guard fired with shape
    //     [..., assistant{a,b}, tool{a}, user{new prompt}]
    // the splice removed user{new prompt} along with the orphan suffix.
    // Fix: remove only assistant + the contiguous tool block; preserve
    // anything past it (user / system / next assistant) untouched.
    let popped = 0;
    while (msgs.length > 0) {
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m?.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
                lastAssistantIdx = i;
                break;
            }
        }
        if (lastAssistantIdx === -1) break;
        // Collect the contiguous tool messages directly after this assistant.
        // Anything past that block is unrelated (next user prompt, system
        // marker, etc.) and must survive the repair.
        let toolBlockEnd = lastAssistantIdx + 1;
        while (toolBlockEnd < msgs.length && msgs[toolBlockEnd]?.role === 'tool') {
            toolBlockEnd += 1;
        }
        const toolBlock = msgs.slice(lastAssistantIdx + 1, toolBlockEnd);
        const ids = msgs[lastAssistantIdx].toolCalls.map(c => c.id);
        const matched = ids.every(id => toolBlock.some(m => m.toolCallId === id));
        if (matched) break;
        const removed = toolBlockEnd - lastAssistantIdx;
        msgs.splice(lastAssistantIdx, removed);
        popped += removed;
    }
    // Second sweep — catch dangling tool results that survived the
    // contiguous-block splice. Anthropic strict spec requires every
    // tool result to sit in a contiguous block right after the
    // assistant whose toolCalls produced it; a `[..., assistant{a,b},
    // tool{a}, user, tool{b}]` shape leaves tool{b} orphaned even
    // after assistant + tool{a} are repaired by the loop above.
    // Walk back from each tool message to the nearest non-tool
    // ancestor; if it is not an assistant whose toolCalls include
    // this id, drop the orphan.
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== 'tool') continue;
        if (!m.toolCallId) {
            msgs.splice(i, 1);
            popped += 1;
            continue;
        }
        let prevIdx = i - 1;
        while (prevIdx >= 0 && msgs[prevIdx]?.role === 'tool') prevIdx--;
        const anchor = prevIdx >= 0 ? msgs[prevIdx] : null;
        const anchorOk = anchor?.role === 'assistant'
            && Array.isArray(anchor.toolCalls)
            && anchor.toolCalls.some(c => c.id === m.toolCallId);
        if (!anchorOk) {
            msgs.splice(i, 1);
            popped += 1;
        }
    }
    if (popped > 0 && sessionId) {
        try { process.stderr.write(`[transcript-repair] sess=${sessionId} popped=${popped} dangling assistant tool_use\n`); } catch {}
    }
}

function resolveRoleIterationCaps(role) {
    let override = null;
    try {
        const cfg = loadConfig();
        override = cfg?.bridge?.iterationCaps || null;
    } catch { /* config read failure → fall back to defaults */ }
    const hiddenRoles = _getHiddenRoles();
    const roleEntry = Array.isArray(hiddenRoles?.roles) ? hiddenRoles.roles.find(r => r.name === role) : null;
    const builtin = roleEntry?.iterationCap || null;
    const fallback = { soft: 30, hard: 100 };
    const fromOverride = (override && typeof override === 'object' && override[role]) || null;
    const fromOverrideDefault = (override && typeof override === 'object' && override.default) || null;
    const pick = (key) => {
        if (fromOverride && Number.isFinite(Number(fromOverride[key]))) return Number(fromOverride[key]);
        if (builtin && Number.isFinite(Number(builtin[key]))) return Number(builtin[key]);
        if (fromOverrideDefault && Number.isFinite(Number(fromOverrideDefault[key]))) return Number(fromOverrideDefault[key]);
        return Number(fallback[key]);
    };
    const soft = Math.max(1, pick('soft'));
    const hard = Math.max(soft + 1, pick('hard'));
    return { soft, hard };
}
// Write-class tools that a permission=read session must not execute. The
// schema still advertises them to keep one unified shard; this runtime set
// is the fail-safe reject at call time.
const READ_BLOCKED_TOOLS = new Set([
    'bash', 'bash_session',
    'write',
    'edit',
    'apply_patch',
]);
const MCP_ONLY_ALLOWED_KINDS = new Set(['mcp', 'internal', 'skill']);
const DIRECT_HIDDEN_TOOLS = new Set(['memory_search', 'web_search']);
// Wrappers that hidden retrieval roles back. Hidden roles MUST NOT call
// these or they spawn another hidden agent of the same kind — nested chain
// + token burn. Block at call time; the role's rule prompt also says so.
const RETRIEVAL_WRAPPERS = new Set(['recall', 'search', 'explore']);
// Eager-dispatch: tools with readOnlyHint:true in their declaration are safe
// to execute during SSE parsing so tool work overlaps with the rest of the
// stream. Writes, bash, MCP and skills stay serial after send() returns.
const COMPLETION_HINT_TOOLS = new Set(['read', 'grep', 'glob', 'list', 'find_symbol']);
function isEagerDispatchable(name, tools) {
    if (!Array.isArray(tools)) return false;
    const def = tools.find(t => t?.name === name);
    return def?.annotations?.readOnlyHint === true;
}
// ── Bridge-worker permission enforcement ──────────────────────────────────────
// Mirrors the PreToolUse hook evaluation for tool calls that originate inside a
// bridge worker session. Worker dispatch previously bypassed the hook pipeline
// entirely; this guard closes that gap by running the same evaluator inline.
//
// `ask` is treated as deny here — forwarding to the channel UI (server-main.mjs:230)
// is out of scope; a TODO is left so the follow-up can wire the approval flow.
// TODO(server-main.mjs:230): forward `ask` decisions to the channel UI approval flow instead of blocking.
function _checkWorkerPermission(toolName, toolInput, sessionRef) {
    const permissionMode = sessionRef?.permissionMode;
    if (!permissionMode) return null;
    // Prefix bare mixdog tool names so the evaluator path-logic handles them correctly.
    const fullName = toolName.startsWith(MCP_TOOL_PREFIX) || toolName.startsWith('mcp__')
        ? toolName
        : `${MCP_TOOL_PREFIX}${toolName}`;
    const projectDir = sessionRef?.cwd || undefined;
    const userCwd = sessionRef?.cwd || undefined;
    try {
        const { decision, reason } = _evaluatePermission({
            toolName: fullName,
            toolInput: toolInput || {},
            permissionMode,
            projectDir,
            userCwd,
        });
        if (decision === 'deny' || decision === 'ask') {
            return `Error: tool "${toolName}" blocked by permission evaluator (decision=${decision}): ${reason}`;
        }
    } catch (err) {
        // Evaluator errors must not crash the loop — log and allow.
        try { process.stderr.write(`[permission-evaluator] error: ${err?.message}\n`); } catch {}
    }
    return null;
}
function withToolCompletionHint(name, result) {
    if (!COMPLETION_HINT_TOOLS.has(name)) return result;
    const text = String(result ?? '');
    if (!text || text.startsWith('Error:')) return result;
    return [
        `[${name} complete: if the requested value/evidence is present above, answer now. Do not repeat an identical ${name} call just to re-check the same result.]`,
        '',
        text,
    ].join('\n');
}
function effectiveToolPermission(sessionRef) {
    return sessionRef?.toolPermission || sessionRef?.permission || null;
}
function isBlockedByPermission(toolName, toolKind, permission) {
    if (permission === 'mcp') return !MCP_ONLY_ALLOWED_KINDS.has(toolKind);
    if (permission === 'read') return READ_BLOCKED_TOOLS.has(toolName);
    return false;
}
function isBlockedDirectHiddenTool(toolName, sessionRef) {
    if (!DIRECT_HIDDEN_TOOLS.has(toolName)) return false;
    if (sessionRef?.owner !== 'bridge') return false;
    return !isHiddenRole(sessionRef?.role);
}
function isBlockedHiddenWrapperCall(toolName, sessionRef) {
    if (!RETRIEVAL_WRAPPERS.has(toolName)) return false;
    if (sessionRef?.owner !== 'bridge') return false;
    return isHiddenRole(sessionRef?.role);
}
// Public bridge roles (worker/reviewer/debugger/tester) must not call
// retrieval wrappers — those spawn hidden sub-agents (explorer / recall-agent
// / search-agent + memory cycle), aggregating stale data and burning latency
// (observed: 5-min worker stall + 0.1.271 hallucination on a known-coord
// version query). Lead does retrieval in the brief and passes coordinates;
// the worker's job is direct read/grep/find_symbol on those coordinates.
function isBlockedPublicWrapperCall(toolName, sessionRef) {
    if (!RETRIEVAL_WRAPPERS.has(toolName)) return false;
    if (sessionRef?.owner !== 'bridge') return false;
    if (isHiddenRole(sessionRef?.role)) return false;
    return true;
}
function messagesArrayChanged(before, after) {
    if (!Array.isArray(before) || !Array.isArray(after)) return before !== after;
    if (before.length !== after.length) return true;
    for (let i = 0; i < before.length; i += 1) {
        if (before[i] !== after[i]) return true;
    }
    return false;
}
const SKILL_TOOL_NAMES = new Set(['skills_list', 'skill_view', 'skill_execute']);
const SPECIAL_TOOL_NAMES = new Set(['bash_session', 'apply_patch', 'code_graph']);
const BASH_SESSION_HEADER_RE = /\[session: ([^\]\r\n]+)\]/;
// Soft-warn sidecar: store advisory text on the tool message in a separate
// field instead of mutating `content`. Provider wrappers emit the sidecar
// as its own block AFTER the tool_result block so cache_control on the
// tool_result keeps hashing the same payload across turns. Mutating
// `toolMsg.content` directly invalidated the Anthropic prompt cache on
// every turn that any guard fired.
function appendToolWarnSidecar(toolMsg, warnText) {
    if (!toolMsg || toolMsg.role !== 'tool' || !warnText) return;
    toolMsg.warnSidecar = toolMsg.warnSidecar
        ? `${toolMsg.warnSidecar}\n\n${warnText}`
        : warnText;
}
function buildIterationWarnText({ iteration, threshold, toolCallsTotal, role }) {
    const scope = role ? ` for role \`${role}\`` : '';
    return [
        `⚠ Iteration soft-warn: this session has reached ${iteration} iterations${scope}.`,
        `- You crossed the soft iteration marker (${threshold}). Do not brute-force another loop by default.`,
        `- Synthesize from the evidence you already have unless the next call is materially narrower or uses a better tool.`,
        `- Total tool calls so far: ${toolCallsTotal}.`,
        `(Advisory only — the session continues.)`,
    ].join('\n');
}
/**
 * Execute a single tool call — routes to MCP or builtin.
 */
function getToolKind(name) {
    if (SKILL_TOOL_NAMES.has(name)) return 'skill';
    if (SPECIAL_TOOL_NAMES.has(name)) return 'builtin';
    if (isMcpTool(name)) return 'mcp';
    if (isInternalTool(name)) return 'internal';
    if (isBuiltinTool(name)) return 'builtin';
    return 'builtin';
}
function buildSkillsListResponse(cwd) {
    const skills = collectSkillsCached(cwd);
    const entries = skills.map(s => ({ name: s.name, description: s.description || '' }));
    return JSON.stringify({ skills: entries });
}
function viewSkill(cwd, name) {
    if (!name) return 'Error: skill name is required';
    const content = loadSkillContent(name, cwd);
    return content || `Error: skill "${name}" not found`;
}
function executeSkill(cwd, name, _args) {
    if (!name) return 'Error: skill name is required';
    const content = loadSkillContent(name, cwd);
    return content || `Error: skill "${name}" not found`;
}
function extractBashSessionId(result) {
    if (typeof result !== 'string') return null;
    const match = BASH_SESSION_HEADER_RE.exec(result);
    return match ? match[1] : null;
}

export function buildBridgeBashSessionArgs(args, sessionRef) {
    if (sessionRef?.owner !== 'bridge') return null;
    const routedArgs = { ...(args || {}) };
    const explicitSessionId = typeof routedArgs.session_id === 'string' && routedArgs.session_id.trim()
        ? routedArgs.session_id.trim()
        : null;
    const wantsPersistent = routedArgs.persistent === true || !!explicitSessionId;
    if (!wantsPersistent) return null;
    if (!explicitSessionId && sessionRef?.implicitBashSessionId) {
        routedArgs.session_id = sessionRef.implicitBashSessionId;
    } else if (explicitSessionId) {
        routedArgs.session_id = explicitSessionId;
    }
    delete routedArgs.persistent;
    return routedArgs;
}

async function executeTool(name, args, cwd, callerSessionId, sessionRef) {
    if (name === 'skills_list') {
        return buildSkillsListResponse(cwd);
    }
    if (name === 'skill_view') {
        return viewSkill(cwd, args?.name);
    }
    if (name === 'skill_execute') {
        return executeSkill(cwd, args?.name, args?.args);
    }
    if (isMcpTool(name)) {
        // 24h trace data shows ~24% of external MCP calls are cwd-sensitive
        // (bash / grep / read / list / glob etc.) but the worker session's
        // cwd was previously dropped here. Inject cwd only when the tool's
        // inputSchema declares the field — schemas without it would reject
        // an unknown argument.
        const needsCwdInjection = cwd
            && mcpToolHasField(name, 'cwd')
            && (args == null || args.cwd == null);
        const finalArgs = needsCwdInjection ? { ...(args || {}), cwd } : args;
        return executeMcpTool(name, finalArgs);
    }
    if (isCodeGraphTool(name)) {
        // cwd chain: args.cwd (caller-explicit) → session cwd → undefined (handler throws)
        const graphCwd = (typeof args?.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
        return executeCodeGraphTool(name, args, graphCwd);
    }
    if (isInternalTool(name)) {
        // callerSessionId propagates into server.mjs dispatchTool so that
        // dispatchAiWrapped can detect and reject recursive calls from a
        // hidden-role session (recall/search/explore → self).
        return executeInternalTool(name, args, { callerSessionId, callerCwd: cwd });
    }
    if (name === 'bash') {
        const routedArgs = buildBridgeBashSessionArgs(args, sessionRef);
        if (!routedArgs) {
            return executeBuiltinTool(name, args, cwd, { sessionId: callerSessionId });
        }
        // Thread the session's AbortSignal so close_session can interrupt the
        // persistent child process. getSessionAbortSignal is imported at top of
        // loop.mjs from manager.mjs; callerSessionId identifies the controller.
        let _bashAbortSignal = null;
        try { _bashAbortSignal = getSessionAbortSignal(callerSessionId); } catch { /* ignore */ }
        const result = await executeBashSessionTool('bash_session', routedArgs, cwd, {
            sessionId: callerSessionId,
            abortSignal: _bashAbortSignal,
        });
        const bashSid = extractBashSessionId(result);
        if (bashSid) {
            sessionRef.implicitBashSessionId = bashSid;
            // Track all persistent bash sessions for bulk teardown on close.
            if (sessionRef.allBashSessionIds) {
                if (!sessionRef.allBashSessionIds.includes(bashSid)) {
                    sessionRef.allBashSessionIds.push(bashSid);
                }
            } else {
                sessionRef.allBashSessionIds = [bashSid];
            }
        }
        return result;
    }
    if (name === 'apply_patch') {
        return executePatchTool(name, args, cwd, { sessionId: callerSessionId });
    }
    if (isBuiltinTool(name)) {
        return executeBuiltinTool(name, args, cwd, { sessionId: callerSessionId });
    }
    return `Error: unknown tool "${name}"`;
}
/**
 * Agent loop: send → tool_call → execute → re-send → repeat until text.
 * sendOpts may include:
 *   - `effort` (provider-specific)
 *   - `fast` (boolean)
 *   - `sessionId` — enables runtime liveness markers (optional)
 *   - `signal` — AbortSignal; checked at each iteration boundary and after each
 *                tool. When aborted, throws SessionClosedError so the ask
 *                wrapper can propagate a clean cancellation.
 *   - `onStageChange(stage)` / `onStreamDelta()` — forwarded to provider.send for heartbeats
 */
export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
    let iterations = 0;
    let toolCallsTotal = 0;
    let lastUsage;
    let firstTurnUsage;
    let response;
    const opts = sendOpts || {};
    const sessionId = opts.sessionId || null;
    const signal = opts.signal || null;
    const loopGuard = createGuard();
    // Per-role soft/hard iteration caps. soft = last warn threshold; hard =
    // emergency fuse default. Map + override resolution at module scope —
    // see resolveRoleIterationCaps / defaults/hidden-roles.json. Per-call
    // opts.iterationEmergencyFuse still wins for benchmarks / batch jobs.
    const sessionRole = opts.session?.role;
    const roleCaps = resolveRoleIterationCaps(sessionRole);
    const roleSoftCeiling = roleCaps.soft;
    const softIterationWarnThresholds = Array.isArray(opts.iterationWarnThresholds) && opts.iterationWarnThresholds.length
        ? [...opts.iterationWarnThresholds].filter((n) => Number.isFinite(Number(n))).map((n) => Number(n)).sort((a, b) => a - b)
        : Array.from(new Set([...SOFT_ITERATION_WARN_THRESHOLDS, roleSoftCeiling])).sort((a, b) => a - b);
    const emergencyIterationFuse = Number.isFinite(Number(opts.iterationEmergencyFuse))
        ? Number(opts.iterationEmergencyFuse)
        : roleCaps.hard;
    const forcedFirstTool = opts.forcedFirstTool ?? null;
    const forcedFirstToolDef = forcedFirstTool
        ? tools.find(tool => tool?.name === forcedFirstTool)
        : null;
    const warnedIterationThresholds = new Set();
    // Opaque providerState passthrough. The loop never inspects it; only the
    // originating provider does. Seed from sendOpts.providerState if the
    // manager restored one. No provider currently emits state (Codex OAuth is
    // stateless per contract); field remains undefined end-to-end for now.
    let providerState = opts.providerState ?? undefined;
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const reason = signal.reason instanceof Error ? signal.reason : null;
            // Preserve any structured abort reason (SessionClosedError,
            // StreamStalledAbortError, etc.). Fallback to SessionClosedError
            // when the reason is not an Error instance.
            if (reason) throw reason;
            throw new SessionClosedError(sessionId || 'unknown', 'agent loop aborted');
        }
    };
    const sessionRef = opts.session || null;
    while (true) {
        throwIfAborted();
        if (sessionRef && typeof sessionRef.contextWindow === 'number') {
            const safetyBudget = Math.floor(sessionRef.contextWindow * SAFETY_TRIM_PERCENT);
            // Snapshot pre-trim shape so trim_meta can record the actual
            // mutation (or no-op) for prefix-mutation forensics. Bytes are
            // a best-effort JSON.stringify length — close enough to the
            // payload we hand the provider for prefix-cache analysis.
            const beforeCount = messages.length;
            let beforeBytes = null;
            try { beforeBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { beforeBytes = null; }
            const trimmed = trimMessages(messages, safetyBudget);
            const trimChanged = messagesArrayChanged(messages, trimmed);
            const pruneCount = Math.max(beforeCount - trimmed.length, 0);
            if (trimChanged) {
                messages.length = 0;
                messages.push(...trimmed);
            }
            let afterBytes = null;
            try { afterBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { afterBytes = null; }
            traceBridgeTrim({
                sessionId,
                iteration: iterations + 1,
                prune_count: pruneCount,
                trim_changed: trimChanged,
                input_prefix_hash: messagePrefixHash(messages),
                before_count: beforeCount,
                after_count: messages.length,
                before_bytes: beforeBytes,
                after_bytes: afterBytes,
            });
        }
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        opts.providerState = providerState;
        if (forcedFirstTool && toolCallsTotal === 0) {
            opts.toolChoice = 'required';
        } else {
            delete opts.toolChoice;
        }
        const sendTools = forcedFirstToolDef && toolCallsTotal === 0 ? [forcedFirstToolDef] : tools;
        // Eager-dispatch queue: when the provider streams a tool-call event,
        // start read-only tools immediately so execution overlaps with the
        // remaining SSE parse. Writes and unknown tools wait until send()
        // returns and run serially in the call-order loop below.
        const pending = new Map();
        const startEagerTool = (call) => {
            if (!call?.id || pending.has(call.id) || !isEagerDispatchable(call.name, tools)) return null;
            const toolKind = getToolKind(call.name);
            // Run role guards before eager execution — same checks as the serial path.
            const noToolRole = sessionRef?.role === 'cycle1-agent' || sessionRef?.role === 'cycle2-agent';
            if (noToolRole) return null;
            if (isBlockedHiddenWrapperCall(call.name, sessionRef)) return null;
            if (isBlockedPublicWrapperCall(call.name, sessionRef)) return null;
            if (isBlockedDirectHiddenTool(call.name, sessionRef)) return null;
            if (isBlockedByPermission(call.name, toolKind, effectiveToolPermission(sessionRef))) return null;
            const entry = { startedAt: Date.now(), endedAt: null };
            entry.promise = (async () => {
                try {
                    const permBlocked = _checkWorkerPermission(call.name, call.arguments, sessionRef);
                    if (permBlocked !== null) return { ok: true, value: permBlocked };
                    return { ok: true, value: await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef) };
                } catch (error) {
                    return { ok: false, error };
                }
            })()
                .finally(() => { entry.endedAt = Date.now(); });
            pending.set(call.id, entry);
            return entry;
        };
        const startEagerRun = (calls, startIndex) => {
            for (let j = startIndex; j < calls.length; j += 1) {
                const call = calls[j];
                if (!call?.id || !isEagerDispatchable(call.name, tools)) break;
                if (!startEagerTool(call) && !pending.has(call.id)) break;
            }
        };
        opts.onToolCall = (call) => {
            startEagerTool(call);
        };
        // Pre-send fuse: stop before issuing the (N+1)-th provider call when
        // the prior iter already hit the ceiling. Avoids burning a final
        // round-trip and emits a structured trace so the abort is observable.
        if (iterations >= emergencyIterationFuse) {
            try {
                traceBridgeLoop({
                    sessionId,
                    iteration: iterations,
                    sendMs: 0,
                    messageCount: Array.isArray(messages) ? messages.length : 0,
                    bodyBytesEst: 0,
                    aborted: true,
                    abortReason: `emergency-fuse:${emergencyIterationFuse}`,
                });
            } catch { /* trace best-effort */ }
            response = response || { content: '', toolCalls: [] };
            response.content = (response.content || '') +
                `\n\n[Agent loop emergency fuse: reached ${emergencyIterationFuse} iterations, aborted before next send]`;
            break;
        }
        // Repair any dangling assistant tool_use left over from a prior
        // abort/error path before the provider sees the transcript. No-op
        // on the healthy iteration cycle (every assistant tool_use is
        // followed by tool results in the same loop body below).
        _ensureTranscriptPairing(messages, sessionId);
        const sendStartedAt = Date.now();
        response = await provider.send(messages, model, sendTools.length ? sendTools : undefined, opts);
        opts.onToolCall = undefined;
        // Capture opaque state for the next turn (may be undefined — that's
        // the stateless contract for providers that don't use continuation).
        providerState = response?.providerState ?? undefined;
        iterations = nextIteration;
        traceBridgeLoop({
            sessionId,
            iteration: iterations,
            sendMs: Date.now() - sendStartedAt,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            bodyBytesEst: estimateProviderPayloadBytes(messages, model, sendTools),
        });
        // Accumulate usage across iterations — every billable slot, not just
        // input/output. Anthropic cache_read/cache_write typically stay 0 on
        // the first iteration and surge on later ones (warm prefix reuse),
        // so aggregating only the head would silently drop most of the
        // cache-side tokens.
        if (response.usage) {
            if (lastUsage) {
                lastUsage.inputTokens += response.usage.inputTokens || 0;
                lastUsage.outputTokens += response.usage.outputTokens || 0;
                lastUsage.cachedTokens = (lastUsage.cachedTokens || 0) + (response.usage.cachedTokens || 0);
                lastUsage.cacheWriteTokens = (lastUsage.cacheWriteTokens || 0) + (response.usage.cacheWriteTokens || 0);
                lastUsage.promptTokens = (lastUsage.promptTokens || 0) + (response.usage.promptTokens || 0);
            }
            else {
                lastUsage = {
                    inputTokens: response.usage.inputTokens || 0,
                    outputTokens: response.usage.outputTokens || 0,
                    cachedTokens: response.usage.cachedTokens || 0,
                    cacheWriteTokens: response.usage.cacheWriteTokens || 0,
                    promptTokens: response.usage.promptTokens || 0,
                    raw: response.usage.raw,
                };
                // Snapshot the first turn separately so callers can show
                // iter1 vs final cache-hit ratios — first iter is the
                // warm-prefix signal, final iter is the steady-state
                // efficiency signal after tool-result accumulation.
                firstTurnUsage = { ...lastUsage };
            }
        }
        // Provider may have returned despite an abort (SDKs that don't honour
        // signal) — bail before processing any of its output.
        throwIfAborted();
        // No tool calls — done
        if (!response.toolCalls?.length)
            break;
        const calls = response.toolCalls;
        toolCallsTotal += calls.length;
        // Per-turn batch shape — one row per assistant turn so trace
        // consumers can derive multi-tool adoption ratio without scanning
        // every assistant message body.
        recordToolBatch(sessionId, calls.length);
        onToolCall?.(iterations, calls);
        let iterationWarnText = null;
        for (const threshold of softIterationWarnThresholds) {
            if (iterations >= threshold && !warnedIterationThresholds.has(threshold)) {
                warnedIterationThresholds.add(threshold);
                iterationWarnText = buildIterationWarnText({
                    iteration: iterations,
                    threshold,
                    toolCallsTotal,
                    role: sessionRef?.role || null,
                });
                traceToolLoopWarn({
                    sessionId,
                    iteration: iterations,
                    warnType: 'iteration',
                    info: { count: iterations, threshold, toolCallsTotal, role: sessionRef?.role || null },
                });
                break;
            }
        }
        // Append assistant message with tool calls. reasoningItems is the
        // OpenAI Responses API replay payload (encrypted_content blobs);
        // providers that ignore it just see an extra field and drop it,
        // openai-oauth.convertMessagesToResponsesInput emits matching
        // type:'reasoning' input items on the next turn to keep the Codex
        // server-side cache prefix stable.
        messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls: calls,
            ...(Array.isArray(response.reasoningItems) && response.reasoningItems.length
                ? { reasoningItems: response.reasoningItems }
                : {}),
            ...(typeof response.reasoningContent === 'string' && response.reasoningContent
                ? { reasoningContent: response.reasoningContent }
                : {}),
        });
        // Execute each tool and append results
        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            if (sessionId) markSessionToolCall(sessionId, call.name);
            let result;
            let toolStartedAt;
            let toolEndedAt;
            const toolKind = getToolKind(call.name);
            try {
                // Fallback for providers that don't stream tool calls early:
                // execute a contiguous read-only run in parallel, but never
                // cross a write/bash/MCP boundary that may change state.
                if (isEagerDispatchable(call.name, tools)) {
                    startEagerRun(calls, callIndex);
                }
                const eager = pending.get(call.id);
                if (eager !== undefined) {
                    toolStartedAt = eager.startedAt;
                    const settled = await eager.promise;
                    if (!settled.ok) throw settled.error;
                    result = settled.value;
                    toolEndedAt = eager.endedAt ?? Date.now();
                } else {
                    toolStartedAt = Date.now();
                    // Runtime permission guard. The tools schema stays full
                    // so every role shares one cache shard; restrictions are
                    // enforced at call time, not at schema build time.
                    const effectivePermission = effectiveToolPermission(sessionRef);
                    const permissionBlocked = isBlockedByPermission(call.name, toolKind, effectivePermission);
                    const noToolRole = sessionRef?.role === 'cycle1-agent' || sessionRef?.role === 'cycle2-agent';
                    if (noToolRole) {
                        result = `Error: tool "${call.name}" is not available in role "${sessionRef.role}". This role must output JSON only — re-emit the JSON without any tool call.`;
                        toolEndedAt = Date.now();
                    } else if (isBlockedHiddenWrapperCall(call.name, sessionRef)) {
                        result = `Error: tool "${call.name}" is the wrapper your role (${sessionRef?.role || 'hidden'}) backs. Calling it would spawn another hidden agent of the same kind — use the role's direct tool (memory_search / web_search / find_symbol+grep+read) instead.`;
                        toolEndedAt = Date.now();
                    } else if (isBlockedPublicWrapperCall(call.name, sessionRef)) {
                        result = `Error: tool "${call.name}" is a fan-out retrieval wrapper. Public bridge roles must use direct read/grep/find_symbol/list/glob on the coordinates Lead provided in the brief — see rules/bridge/02-public-work-principles.md Tool routing.`;
                        toolEndedAt = Date.now();
                    } else if (isBlockedDirectHiddenTool(call.name, sessionRef)) {
                        result = `Error: tool "${call.name}" is only available inside Pool C hidden retrieval roles. Use recall/search/explore instead.`;
                        toolEndedAt = Date.now();
                    } else if (permissionBlocked && effectivePermission === 'mcp') {
                        result = `Error: tool "${call.name}" is not available on this session (permission=mcp). Use MCP/internal retrieval tools only.`;
                        toolEndedAt = Date.now();
                    } else if (permissionBlocked && effectivePermission === 'read') {
                        result = `Error: tool "${call.name}" is not available on this session (permission=read). Use read/grep/glob/recall/search/explore or the read-only MCP tools instead.`;
                        toolEndedAt = Date.now();
                    } else {
                        const permBlocked = _checkWorkerPermission(call.name, call.arguments, sessionRef);
                        if (permBlocked !== null) {
                            result = permBlocked;
                            toolEndedAt = Date.now();
                        } else {
                            result = await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef);
                            toolEndedAt = Date.now();
                        }
                    }
                }
            }
            catch (err) {
                if (toolStartedAt === undefined) toolStartedAt = Date.now();
                toolEndedAt = Date.now();
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
            // Compression layer runs BEFORE offload so per-tool dedup /
            // family formatting can pull a result back under the offload
            // threshold (caller then sees a normal inline body instead of
            // a 2k preview pointer). offload still fires when the bound
            // is exceeded after compression.
            result = compressToolResult(call.name, call.arguments, result, { sessionId, toolKind });
            result = maybeOffloadToolResult(sessionId, call.id, call.name, result);
            result = withToolCompletionHint(call.name, result);
            traceBridgeTool({
                sessionId,
                iteration: iterations,
                toolName: call.name,
                toolKind,
                toolMs: toolEndedAt - toolStartedAt,
                toolArgs: call.arguments,
            });
            messages.push({
                role: 'tool',
                content: result,
                toolCallId: call.id,
            });
            // Loop guard: repeated identical failure signatures still abort as a
            // safety fuse, but repetition / family / budget caps are advisory
            // only and prepend soft-warn sidecars onto the tool result.
            const guardResult = checkToolCall(loopGuard, {
                toolName: call.name,
                args: call.arguments,
                result,
                iteration: iterations,
            });
            if (guardResult.action === 'detected') {
                traceToolLoopDetected({ sessionId, iteration: iterations, info: guardResult.info });
                // Soft-warn: attach a sidecar onto the tool message so the
                // provider wrapper emits it as a separate block AFTER the
                // tool_result. Keeps tool_result content stable so the
                // cache_control breakpoint still hits.
                appendToolWarnSidecar(messages[messages.length - 1], guardResult.warnText);
            } else if (guardResult.action === 'same_tool_warn') {
                // Same-tool repetition advisory. Never aborts — just
                // attaches a sidecar asking the model to stop and
                // synthesize. Fires once per whitelisted tool per session.
                traceToolLoopWarn({ sessionId, iteration: iterations, warnType: 'same_tool', info: guardResult.info });
                appendToolWarnSidecar(messages[messages.length - 1], guardResult.warnText);
            } else if (guardResult.action === 'family_warn') {
                // Cross-tool advisory for mixed low-level loops like
                // read+grep+glob+list or repeated edit-roundtrips.
                traceToolLoopWarn({ sessionId, iteration: iterations, warnType: 'family', info: guardResult.info });
                appendToolWarnSidecar(messages[messages.length - 1], guardResult.warnText);
            } else if (guardResult.action === 'budget_warn') {
                // Overall tool-budget advisory. Fires sparingly to nudge
                // synthesis once the session has already spent many tool turns.
                traceToolLoopWarn({ sessionId, iteration: iterations, warnType: 'budget', info: guardResult.info });
                appendToolWarnSidecar(messages[messages.length - 1], guardResult.warnText);
            } else if (guardResult.action === 'abort') {
                traceToolLoopAborted({ sessionId, iteration: iterations, info: guardResult.info });
                throw new ToolLoopAbortError(guardResult.info);
            }
            // Soft-cancel after each tool: if close landed during execution,
            // discard the rest of the batch and skip the next provider.send.
            throwIfAborted();
        }
        if (iterationWarnText) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const msg = messages[i];
                if (msg && msg.role === 'tool') {
                    appendToolWarnSidecar(msg, iterationWarnText);
                    break;
                }
            }
        }
        // About to re-send with tool results — transition back to connecting for the next turn.
        if (sessionId) updateSessionStage(sessionId, 'connecting');
    }
    return {
        ...response,
        usage: lastUsage || response.usage,
        lastTurnUsage: response.usage,
        firstTurnUsage: firstTurnUsage || response.usage,
        iterations,
        toolCallsTotal,
        providerState,
    };
}
