import { executeMcpTool, isMcpTool, mcpToolHasField } from '../mcp/client.mjs';
import { executeBuiltinTool, isBuiltinTool } from '../tools/builtin.mjs';
import { executeBashSessionTool } from '../tools/bash-session.mjs';
import { executePatchTool } from '../tools/patch.mjs';
import { executeCodeGraphTool, isCodeGraphTool } from '../tools/code-graph.mjs';
import { executeInternalTool, isInternalTool } from '../internal-tools.mjs';
import { collectSkillsCached, loadSkillContent } from '../context/collect.mjs';
import { traceBridgeLoop, traceBridgeTool, traceToolLoopAborted, traceToolLoopDetected, traceToolLoopWarn, estimateProviderPayloadBytes } from '../bridge-trace.mjs';
import { markSessionToolCall, updateSessionStage, SessionClosedError } from './manager.mjs';
import { trimMessages } from './trim.mjs';
import { createGuard, checkToolCall, ToolLoopAbortError } from '../tool-loop-guard.mjs';
import { maybeOffloadToolResult } from './tool-result-offload.mjs';
import { isHiddenRole } from '../internal-roles.mjs';
const SAFETY_TRIM_PERCENT = 0.90;
const SOFT_ITERATION_WARN_THRESHOLDS = Object.freeze([24, 48, 96]);
const EMERGENCY_ITERATION_FUSE = 1000;
// Write-class tools that a permission=read session must not execute. The
// schema still advertises them to keep one unified shard; this runtime set
// is the fail-safe reject at call time.
const READ_BLOCKED_TOOLS = new Set([
    'bash', 'bash_session',
    'write',
    'edit', 'edit_lines',
    'apply_patch',
    'sg_rewrite',
]);
const MCP_ONLY_ALLOWED_KINDS = new Set(['mcp', 'internal', 'skill']);
const DIRECT_HIDDEN_TOOLS = new Set(['memory_search', 'web_search']);
// Eager-dispatch allowlist: read-only builtins can safely start executing
// during SSE parsing so tool work overlaps with the rest of the stream.
// Writes, bash, MCP and skills stay serial after send() returns.
const EAGER_TOOLS = new Set(['read', 'multi_read', 'grep', 'glob', 'list']);
const COMPLETION_HINT_TOOLS = new Set(['read', 'multi_read', 'grep', 'glob', 'list']);
const EXPLICIT_TOOL_VERBS = String.raw`(?:use|call|run|invoke|prefer)`
const EXPLICIT_TOOL_NEGATION = String.raw`(?:do\s+not|don't|never)\s+${EXPLICIT_TOOL_VERBS}`
function isEagerDispatchable(name) { return EAGER_TOOLS.has(name); }
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
function escapeRegex(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function userTextsNewestFirst(messages) {
    if (!Array.isArray(messages)) return [];
    const texts = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg?.role !== 'user') continue;
        if (typeof msg.content === 'string') {
            if (!msg.content.startsWith('<system-reminder>')) texts.push(msg.content);
            continue;
        }
        if (Array.isArray(msg.content)) {
            const text = msg.content.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n');
            if (text && !text.startsWith('<system-reminder>')) texts.push(text);
        }
    }
    return texts;
}
function explicitToolChoiceName(messages, tools) {
    const texts = userTextsNewestFirst(messages);
    if (!texts.length || !Array.isArray(tools) || !tools.length) return null;
    const names = tools.map(tool => tool?.name).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const text of texts) {
        for (const name of names) {
            const escaped = escapeRegex(name);
            const quotedName = '`?' + escaped + '`?';
            const positive = new RegExp(`\\b${EXPLICIT_TOOL_VERBS}\\s+(?:exactly\\s+one\\s+|one\\s+)?${quotedName}\\b`, 'i');
            const negative = new RegExp(`\\b${EXPLICIT_TOOL_NEGATION}\\s+${quotedName}\\b`, 'i');
            if (positive.test(text) && !negative.test(text)) return name;
        }
        if (names.includes('list') && /\buse\s+(?:exactly\s+)?one\s+directory\s+(?:find|metadata|list)\s+query\b/i.test(text)) {
            return 'list';
        }
    }
    return null;
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
        return executeCodeGraphTool(name, args, cwd);
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
        const result = await executeBashSessionTool('bash_session', routedArgs, cwd);
        const sessionId = extractBashSessionId(result);
        if (sessionId) sessionRef.implicitBashSessionId = sessionId;
        return result;
    }
    if (name === 'bash_session') {
        return executeBashSessionTool(name, args, cwd);
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
    let response;
    const opts = sendOpts || {};
    const sessionId = opts.sessionId || null;
    const signal = opts.signal || null;
    const loopGuard = createGuard();
    const softIterationWarnThresholds = Array.isArray(opts.iterationWarnThresholds) && opts.iterationWarnThresholds.length
        ? [...opts.iterationWarnThresholds].filter((n) => Number.isFinite(Number(n))).map((n) => Number(n)).sort((a, b) => a - b)
        : [...SOFT_ITERATION_WARN_THRESHOLDS];
    // Hidden retrieval roles (recall-agent / search-agent / explorer / cycle*
    // / recap) are bounded at 30: the loop cap keeps a single retrieval call
    // from grinding through dozens of probe iterations on an ambiguous query.
    // Worker is bounded tighter (56) than other bridge roles (64) because 24h
    // trace shows worker p95 hitting 88 on grep+read alt-loops; reviewer /
    // debugger / tester p95 stays under 12 in practice and benefits from the
    // larger headroom for genuine multi-file work.
    // The 1000-iter EMERGENCY fuse remains as the absolute backstop and can
    // be overridden via opts.iterationEmergencyFuse for special workloads.
    const HIDDEN_ROLE_ITERATION_FUSE = 30;
    const WORKER_ROLE_ITERATION_FUSE = 56;
    const BRIDGE_ROLE_ITERATION_FUSE = 64;
    const sessionRole = opts.session?.role;
    const emergencyIterationFuse = Number.isFinite(Number(opts.iterationEmergencyFuse))
        ? Number(opts.iterationEmergencyFuse)
        : (opts.session && isHiddenRole(sessionRole)
            ? HIDDEN_ROLE_ITERATION_FUSE
            : sessionRole === 'worker'
                ? WORKER_ROLE_ITERATION_FUSE
                : BRIDGE_ROLE_ITERATION_FUSE);
    const forcedFirstTool = opts.forcedFirstTool || explicitToolChoiceName(messages, tools);
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
            const trimmed = trimMessages(messages, safetyBudget);
            if (messagesArrayChanged(messages, trimmed)) {
                messages.length = 0;
                messages.push(...trimmed);
            }
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
            if (!call?.id || pending.has(call.id) || !isEagerDispatchable(call.name)) return null;
            const toolKind = getToolKind(call.name);
            if (isBlockedByPermission(call.name, toolKind, effectiveToolPermission(sessionRef))) return null;
            const entry = { startedAt: Date.now(), endedAt: null };
            entry.promise = (async () => {
                try {
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
                if (!call?.id || !isEagerDispatchable(call.name)) break;
                if (!startEagerTool(call) && !pending.has(call.id)) break;
            }
        };
        opts.onToolCall = (call) => {
            startEagerTool(call);
        };
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
            }
        }
        // Provider may have returned despite an abort (SDKs that don't honour
        // signal) — bail before processing any of its output.
        throwIfAborted();
        // No tool calls — done
        if (!response.toolCalls?.length)
            break;
        // Non-negotiable runaway fuse. Soft iteration caps warn below;
        // this remains only as an emergency brake for a genuinely broken loop.
        if (iterations > emergencyIterationFuse) {
            response.content = (response.content || '') +
                `\n\n[Agent loop emergency fuse: reached ${emergencyIterationFuse} iterations]`;
            break;
        }
        const calls = response.toolCalls;
        toolCallsTotal += calls.length;
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
        // Append assistant message with tool calls
        messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls: calls,
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
                if (isEagerDispatchable(call.name)) {
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
                    if (isBlockedDirectHiddenTool(call.name, sessionRef)) {
                        result = `Error: tool "${call.name}" is only available inside Pool C hidden retrieval roles. Use recall/search/explore instead.`;
                        toolEndedAt = Date.now();
                    } else if (permissionBlocked && effectivePermission === 'mcp') {
                        result = `Error: tool "${call.name}" is not available on this session (permission=mcp). Use MCP/internal retrieval tools only.`;
                        toolEndedAt = Date.now();
                    } else if (permissionBlocked && effectivePermission === 'read') {
                        result = `Error: tool "${call.name}" is not available on this session (permission=read). Use read/multi_read/grep/glob/recall/search/explore or the read-only MCP tools instead.`;
                        toolEndedAt = Date.now();
                    } else {
                        result = await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef);
                        toolEndedAt = Date.now();
                    }
                }
            }
            catch (err) {
                if (toolStartedAt === undefined) toolStartedAt = Date.now();
                toolEndedAt = Date.now();
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
            }
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
                // Soft-warn: prepend a synthetic sidecar onto the tool
                // result the model is about to read so it gets a
                // self-correction nudge BEFORE the hard abort at count 3.
                if (guardResult.warnText) {
                    const toolMsg = messages[messages.length - 1];
                    if (toolMsg && toolMsg.role === 'tool') {
                        toolMsg.content = `${guardResult.warnText}\n\n${toolMsg.content}`;
                    }
                }
            } else if (guardResult.action === 'same_tool_warn') {
                // Same-tool repetition advisory. Never aborts — just
                // prepends a sidecar asking the model to stop and
                // synthesize. Fires once per whitelisted tool per session.
                traceToolLoopWarn({ sessionId, iteration: iterations, warnType: 'same_tool', info: guardResult.info });
                if (guardResult.warnText) {
                    const toolMsg = messages[messages.length - 1];
                    if (toolMsg && toolMsg.role === 'tool') {
                        toolMsg.content = `${guardResult.warnText}\n\n${toolMsg.content}`;
                    }
                }
            } else if (guardResult.action === 'family_warn') {
                // Cross-tool advisory for mixed low-level loops like
                // read+grep+glob+list or repeated edit-roundtrips.
                traceToolLoopWarn({ sessionId, iteration: iterations, warnType: 'family', info: guardResult.info });
                if (guardResult.warnText) {
                    const toolMsg = messages[messages.length - 1];
                    if (toolMsg && toolMsg.role === 'tool') {
                        toolMsg.content = `${guardResult.warnText}\n\n${toolMsg.content}`;
                    }
                }
            } else if (guardResult.action === 'budget_warn') {
                // Overall tool-budget advisory. Fires sparingly to nudge
                // synthesis once the session has already spent many tool turns.
                traceToolLoopWarn({ sessionId, iteration: iterations, warnType: 'budget', info: guardResult.info });
                if (guardResult.warnText) {
                    const toolMsg = messages[messages.length - 1];
                    if (toolMsg && toolMsg.role === 'tool') {
                        toolMsg.content = `${guardResult.warnText}\n\n${toolMsg.content}`;
                    }
                }
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
                    msg.content = `${iterationWarnText}\n\n${msg.content}`;
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
        iterations,
        toolCallsTotal,
        providerState,
    };
}
