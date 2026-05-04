/**
 * Smart Bridge — Internal LLM Helper (session-based).
 *
 * Every one-shot LLM dispatch from internal callers (memory-cycle,
 * scheduler, webhook) now flows through the SAME session pipeline as the
 * MCP `bridge` tool. No more parallel `provider.send()` helper — one code
 * path = one message shape = one usage log = "bridge single path".
 *
 * The returned function preserves the legacy signature used by
 * `makeMaintenanceLlm` and co., so callers do not need changes:
 *
 *   const llm = makeBridgeLlm({ role: 'maintenance', preset: 'haiku' });
 *   const text = await llm({ prompt });
 *
 * Internally it:
 *   1. Resolves the preset (explicit arg > opts.preset > user-workflow.json[role])
 *   2. Creates or reuses a session via the session manager
 *   3. Applies stateless-reset for stateless profiles so the prefix handle
 *      stays warm while per-dispatch transcripts never leak
 *   4. Calls `askSession` → provider.send() → usage logged via
 *      `session/manager.mjs` (mode='active')
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../config.mjs';
import { resolveRuntimeSpec } from '../config.mjs';
import { getHiddenRole } from '../internal-roles.mjs';
import { DEFAULT_PLUGIN, DEFAULT_MARKETPLACE } from '../../../shared/plugin-paths.mjs';
import { prepareBridgeSession } from './session-builder.mjs';
import {
    askSession,
    updateSessionStatus,
} from '../session/manager.mjs';

// Cap sub-agent synthesis to ~3000 tokens (~12 KB at the 4 B/tok
// working average). Pool B explore/recall/search answers occasionally land
// 8-10k-token walls that then ride in the Lead context for the rest of the
// turn; the cap keeps those outliers bounded without touching the 95%+ of
// answers already under the threshold.
const BRIEF_CAP_BYTES = 12 * 1024;
function applyBriefCap(text) {
    if (typeof text !== 'string') return text;
    if (text.length <= BRIEF_CAP_BYTES) return text;
    const head = text.slice(0, BRIEF_CAP_BYTES);
    const approxTokens = Math.round(text.length / 4);
    return `${head}\n\n... [TRUNCATED — full answer was ~${approxTokens} tokens / ${Math.round(text.length / 1024)} KB. Re-run with brief:false for the complete synthesis]`;
}

function pluginRoot() {
    return process.env.CLAUDE_PLUGIN_ROOT
        || join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', DEFAULT_PLUGIN);
}

// Unified-shard policy — every bridge session (Pool B + Pool C) shares the
// same tool schema so BP_1 is bit-identical across roles and one provider-side
// cache shard serves every caller. Per-role behaviour is steered by:
//   1. rules/bridge/*.md concatenated into BP2 roleCatalog (via
//      loadAllAgentBodies — every bridge session carries the full hidden-role
//      catalog so the shard stays bit-identical across roles)
//   2. call-time guards (loop.mjs write-block + ai-wrapped-dispatch
//      recursion break)
// See manager.mjs resolveSessionTools for the single source of truth;
// bridge visibility is declared via annotations.bridgeHidden on each tool def.

function buildUnifiedHeader({ permission, role }) {
    const lines = [];
    if (permission) lines.push(`Permission: ${permission}`);
    if (role) lines.push(`Role: ${role}`);
    if (lines.length === 0) return '';
    lines.push('');
    lines.push('---');
    lines.push('');
    return lines.join('\n');
}

/**
 * Resolve a preset name from (preset arg | opts.preset | hidden-role | user-workflow).
 *
 * Hidden roles (explorer / recall-agent / search-agent) are
 * plugin-managed and take precedence over user-workflow.json — users cannot
 * override them by redefining the same name.
 */
export function resolvePresetName({ preset, optsPreset, role, config: cfgIn = null }) {
    if (preset) return preset;
    if (optsPreset) return optsPreset;
    if (!role) return null;
    // Hidden roles look up preset via the shared maintenance config
    // slot so C and D move together when the user retunes a model tier.
    const hidden = getHiddenRole(role);
    if (hidden) {
        try {
            const config = cfgIn || loadConfig();
            return config?.maintenance?.[hidden.slot] || null;
        } catch { return null; }
    }
    try {
        const pluginData = process.env.CLAUDE_PLUGIN_DATA;
        if (!pluginData) return null;
        const wf = JSON.parse(readFileSync(join(pluginData, 'user-workflow.json'), 'utf8'));
        if (!Array.isArray(wf.roles)) return null;
        const entry = wf.roles.find((r) => r.name === role);
        return entry ? entry.preset : null;
    } catch {
        return null;
    }
}

/**
 * Build a bridge-backed LLM callback.
 *
 * @param {object} opts
 * @param {string} opts.role        — REQUIRED; canonical role name (worker, cycle1-agent, scheduler-task, ...)
 * @param {string} [opts.taskType]  — optional internal classification stamped on the session
 * @param {string} [opts.preset]    — explicit preset override (bypasses role → preset lookup)
 * @param {string} [opts.parentSessionId] — parent bridge session for trace aggregation
 * @param {AbortSignal} [opts.parentSignal] — optional AbortSignal from the fan-out coordinator;
 *   when aborted the sub-agent session's own controller is also aborted so the
 *   provider call tears down promptly (parent→child cascade).
 * @returns {(args: { prompt, preset?, sourceName? }) => Promise<string>}
 */
export function makeBridgeLlm(opts = {}) {
    if (!opts.role || typeof opts.role !== 'string') {
        throw new Error('[bridge-llm] opts.role is required');
    }
    const role = opts.role;

    return async function bridgeLlm({ prompt, preset: presetArg, sourceName: sourceNameArg }) {
        if (typeof prompt !== 'string' || !prompt) {
            throw new Error(`[bridge-llm] prompt required for role "${role}"`);
        }

        const config = loadConfig();
        const presetName = resolvePresetName({
            preset: presetArg,
            optsPreset: opts.preset,
            role,
            config,
        });
        if (!presetName) {
            throw new Error(
                `[bridge-llm] preset unresolved for role "${role}" `
                + `(preset="${presetArg || opts.preset || ''}")`,
            );
        }

        const preset = config.presets?.find((p) => p.id === presetName || p.name === presetName);
        if (!preset) {
            throw new Error(`[bridge-llm] preset "${presetName}" not found in agent-config.json`);
        }

        const runtimeSpec = resolveRuntimeSpec(preset, {
            lane: 'bridge',
            agentId: role,
        });

        // Callers (e.g. aiWrapped explore dispatch) may pass an explicit
        // `cwd` to scope the agent's filesystem view. Absolute path expected
        // (aiWrapped already expands `~` and resolves relatives). When unset
        // we pass `null` through instead of falling back to `process.cwd()`
        // — the MCP server's launch dir is not deterministic across callers,
        // and the downstream skill-discovery path tolerates null. Combined
        // with the frozen bridge skill meta-tools (collect.mjs) this keeps
        // every caller on the same provider cache shard.
        const cwd = (typeof opts.cwd === 'string' && opts.cwd) ? opts.cwd : null;

        // Unified dispatch: Pool B/C share bit-identical tools + system prompt
        // so every role lands on the same provider-side cache shard. Per-role
        // differentiation rides in the user-message header (permission + role
        // line) plus an optional short Pool C snippet. Tools stay on preset
        // default ('full'); the read-only contract is enforced at call time
        // via loop.mjs's READ_BLOCKED_TOOLS guard, not at schema build time.
        const hidden = getHiddenRole(role);
        const isPoolC = Boolean(hidden);
        // Permission resolution: explicit opts.permission > hidden-role
        // declared default (entry.permission in internal-roles.mjs) > unset
        // (preset/full default). State-changing hidden agents (scheduler-task,
        // webhook-handler) need the full tool surface; retrieval roles stay
        // read-only. Same call-time guard + same error string as public
        // read-only roles (loop.mjs:469). Callers may still pass
        // `permission: 'read-write'` explicitly to opt a Pool B role into the
        // same header format without the read-only call-time guard.
        const permission = opts.permission || (isPoolC ? (hidden.permission || 'read') : null);
        // Pool C hidden-role instructions live in BP2 roleCatalog (loaded
        // by loadAllAgentBodies from rules/bridge/*.md) — the Tier 3
        // reminder is suppressed so the shard stays bit-identical across
        // every bridge role.
        //
        // User message = pure query. Permission / role ride in BP3
        // sessionMarker (composeSystemPrompt) — only the query varies per
        // call, so provider cache reuses the shared prefix.
        //
        // Stateless ephemeral session — created fresh per call, never
        // pooled or resumed. Cache prefix matching happens at the provider
        // layer (account-level), not the session level.
        const finalPrompt = prompt;
        const { session } = prepareBridgeSession({
            role,
            presetName,
            preset,
            runtimeSpec,
            permission,
            cwd,
            sourceType: opts.sourceType,
            sourceName: sourceNameArg || opts.sourceName,
            taskType: opts.taskType,
            parentSessionId: opts.parentSessionId || null,
            skipRoleReminder: isPoolC,
        });

        updateSessionStatus(session.id, 'running');
        // Parent→child abort cascade: when opts.parentSignal fires, abort the
        // sub-session's own controller so the provider call tears down promptly.
        // Best-effort: if the session/manager import or linkAbortSignalToSession
        // is unavailable we fall back silently.
        if (opts.parentSignal instanceof AbortSignal) {
            try {
                const { linkParentSignalToSession } = await import('../session/manager.mjs');
                if (typeof linkParentSignalToSession === 'function') {
                    linkParentSignalToSession(session.id, opts.parentSignal);
                }
            } catch { /* best-effort; non-critical */ }
        }
        let terminalStatus = 'idle';
        process.stderr.write(`[bridge-llm] role=${role} preset=${presetName} model=${preset.model} provider=${preset.provider} session=${session.id}\n`);
        const _bridgeT0 = Date.now();
        try {
            const result = await askSession(session.id, finalPrompt, null, null, cwd);
            process.stderr.write(`[bridge-llm] role=${role} session=${session.id} elapsed=${Date.now() - _bridgeT0}ms\n`);
            const raw = result?.content || '';
            // Brief cap. Sub-agent answers (explore/recall/search)
            // occasionally balloon to 8-10k token walls that then ride in the
            // parent Lead's context for the rest of the turn. A 3000-token
            // (~12 KB) ceiling trims the long tail while leaving the vast
            // majority of answers untouched. Opt-out via `brief:false` when
            // the caller explicitly wants the full synthesis.
            if (opts.brief === false) return raw;
            return applyBriefCap(raw);
        } catch (err) {
            terminalStatus = 'error';
            throw err;
        } finally {
            // Always flip out of 'running' before returning so the sweep never
            // leaves a stateless Pool C session stuck in 'running' when the
            // try/catch falls through in unexpected ways.
            try { updateSessionStatus(session.id, terminalStatus); } catch { /* ignore */ }
        }
    };
}
