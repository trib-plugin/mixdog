import { executeMcpTool, isMcpTool } from '../mcp/client.mjs';
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
import {
    shouldCompress,
    compress,
    estimateMessagesTokensRough,
    THRESHOLD_PERCENT,
} from './compressor.mjs';
const SAFETY_TRIM_PERCENT = 0.90;
const SOFT_ITERATION_WARN_THRESHOLDS = Object.freeze([24, 48, 96]);
const EMERGENCY_ITERATION_FUSE = 1000;
// Write-class tools that a permission=read session must not execute. The
// schema still advertises them to keep one unified shard; this runtime set
// is the fail-safe reject at call time.
const READ_BLOCKED_TOOLS = new Set(['bash', 'bash_session', 'write', 'edit', 'multi_edit', 'batch_edit', 'apply_patch', 'job_cancel', 'rename_symbol_refs', 'rename_file_refs']);
// Eager-dispatch allowlist: read-only builtins can safely start executing
// during SSE parsing so tool work overlaps with the rest of the stream.
// Writes, bash, MCP and skills stay serial after send() returns.
const EAGER_TOOLS = new Set(['read', 'multi_read', 'grep', 'glob', 'list']);
function isEagerDispatchable(name) { return EAGER_TOOLS.has(name); }
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
        return executeMcpTool(name, args);
    }
    if (isCodeGraphTool(name)) {
        return executeCodeGraphTool(name, args, cwd);
    }
    if (isInternalTool(name)) {
        // callerSessionId propagates into server.mjs dispatchTool so that
        // dispatchAiWrapped can detect and reject recursive calls from a
        // hidden-role session (recall/search/explore → self).
        return executeInternalTool(name, args, { callerSessionId });
    }
    if (name === 'bash') {
        const routedArgs = buildBridgeBashSessionArgs(args, sessionRef);
        if (!routedArgs) {
            return executeBuiltinTool(name, args, cwd);
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
        return executePatchTool(name, args, cwd);
    }
    if (isBuiltinTool(name)) {
        return executeBuiltinTool(name, args, cwd);
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
    const emergencyIterationFuse = Number.isFinite(Number(opts.iterationEmergencyFuse))
        ? Number(opts.iterationEmergencyFuse)
        : EMERGENCY_ITERATION_FUSE;
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
    // Session ref for in-flight compressor state. Provided by the caller when
    // available (askSession passes it); the loop mutates messages in place.
    const sessionRef = opts.session || null;
    while (true) {
        throwIfAborted();
        // --- Hermes-style in-flight compression (before each provider.send) ---
        // Only runs when we have a session ref (i.e. called from askSession).
        // Threshold: messages token estimate >= contextWindow * THRESHOLD_PERCENT.
        // Failure cooldown is handled inside compressor.mjs via its per-process
        // _summaryFailureCooldownUntil gate — no session-level gate here.
        if (sessionRef && typeof sessionRef.contextWindow === 'number') {
            try {
                const currentTokens = estimateMessagesTokensRough(messages);
                const thresholdTokens = Math.round(sessionRef.contextWindow * THRESHOLD_PERCENT);
                if (shouldCompress(messages, currentTokens, thresholdTokens)) {
                    const result = await compress(messages, {
                        provider,
                        sendOpts: { ...opts, model },
                        previousSummary: sessionRef.previousSummary || null,
                        focusTopic: null,
                        contextLength: sessionRef.contextWindow,
                        thresholdTokens,
                    });
                    if (result.compressed && Array.isArray(result.messages)) {
                        // Mutate the shared array in place so callers holding the
                        // same reference observe the compaction.
                        messages.length = 0;
                        messages.push(...result.messages);
                        sessionRef.previousSummary = result.summary || sessionRef.previousSummary || null;
                        sessionRef.compressionCount = (sessionRef.compressionCount || 0) + 1;
                    }
                }
            } catch (err) {
                process.stderr.write(`[loop] compressor error: ${err?.message || err}\n`);
            }
            // Safety net: hard-limit byte trim after compaction (or when
            // compaction declined). Compaction is primary; this only drops
            // messages when the total still exceeds SAFETY_TRIM_PERCENT of the
            // context window — prevents sending bodies past provider limits.
            const safetyBudget = Math.floor(sessionRef.contextWindow * SAFETY_TRIM_PERCENT);
            const trimmed = trimMessages(messages, safetyBudget);
            if (trimmed.length !== messages.length) {
                messages.length = 0;
                messages.push(...trimmed);
            }
        }
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        opts.providerState = providerState;
        // Eager-dispatch queue: when the provider streams a tool-call event,
        // start read-only tools immediately so execution overlaps with the
        // remaining SSE parse. Writes and unknown tools wait until send()
        // returns and run serially in the call-order loop below.
        const pending = new Map();
        opts.onToolCall = (call) => {
            if (!call?.id || !isEagerDispatchable(call.name)) return;
            // endedAt is stamped by finally so `toolMs` reflects the true
            // execution duration — independent of when the serial for-loop
            // consumes the result (otherwise later eager calls would inflate
            // by the await delay of earlier ones).
            const entry = { startedAt: Date.now(), endedAt: null };
            entry.promise = executeTool(call.name, call.arguments, cwd, sessionId)
                .finally(() => { entry.endedAt = Date.now(); });
            pending.set(call.id, entry);
        };
        const sendStartedAt = Date.now();
        response = await provider.send(messages, model, tools.length ? tools : undefined, opts);
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
            bodyBytesEst: estimateProviderPayloadBytes(messages, model, tools),
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
        for (const call of calls) {
            if (sessionId) markSessionToolCall(sessionId, call.name);
            let result;
            let toolStartedAt;
            let toolEndedAt;
            const toolKind = getToolKind(call.name);
            try {
                const eager = pending.get(call.id);
                if (eager !== undefined) {
                    toolStartedAt = eager.startedAt;
                    result = await eager.promise;
                    toolEndedAt = eager.endedAt ?? Date.now();
                } else {
                    toolStartedAt = Date.now();
                    // Runtime permission guard — block write-class tools for
                    // read-permission sessions before dispatch. tools schema
                    // stays full so every role shares one cache shard; the
                    // guard happens at call time, not at schema build time.
                    if (sessionRef?.permission === 'read' && READ_BLOCKED_TOOLS.has(call.name)) {
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
            traceBridgeTool({
                sessionId,
                iteration: iterations,
                toolName: call.name,
                toolKind,
                toolMs: toolEndedAt - toolStartedAt,
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
