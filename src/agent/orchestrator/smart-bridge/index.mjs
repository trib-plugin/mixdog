/**
 * Smart Bridge — public API
 *
 * Resolution flow:
 *   request.role   →  getRoleConfig(role)         (user-workflow.json)
 *   request.preset →  presets[preset]             (agent-config.json presets)
 *
 * Missing role → preset comes from `request.preset` →
 * userRoles[request.role] → default preset.
 */

import { buildVirtualProfile } from './profiles.mjs';
import { CacheRegistry } from './registry.mjs';
import { buildProviderCacheOpts, computePrefixContent, ttlSecondsForCache } from './cache-strategy.mjs';
import { getHiddenRole } from '../internal-roles.mjs';

let _sharedInstance = null;

// Plugin-managed hidden roles live in internal-roles.mjs, not
// user-workflow.json. The resolver normalises them into the same RoleConfig
// shape user-defined roles produce so every caller lands in the cache
// registry with a stable profileId — no per-call branching, no fallback
// chain in downstream code.
function _hiddenRoleConfig(role) {
    const hidden = getHiddenRole(role);
    if (!hidden) return null;
    return {
        name: role,
        preset: null,
        desc_path: hidden.description || null,
    };
}

// Unified role resolver. Defaults to the hidden-role registry so SmartBridge
// is usable standalone before agent/init() runs; setRoleResolver() layers the
// user-workflow.json lookup on top once available. One function, one shape —
// downstream code never checks for null or picks a branch.
let _resolveRole = _hiddenRoleConfig;

/**
 * Install the user-workflow role lookup. Called once by agent/index.mjs after
 * the user-workflow.json cache is populated. The resulting resolver returns
 * user-defined roles when present and hidden-role metadata otherwise.
 */
export function setRoleResolver(fn) {
    const userResolver = typeof fn === 'function' ? fn : null;
    _resolveRole = userResolver
        ? (role) => userResolver(role) || _hiddenRoleConfig(role)
        : _hiddenRoleConfig;
}

async function _lazyGetRoleConfig(role) {
    // User-workflow resolver already installed — synchronous lookup is fine.
    if (_resolveRole !== _hiddenRoleConfig) return _resolveRole(role);
    // Pre-init: dynamic import so standalone tests / scripts still see the
    // user-workflow roles without requiring agent/init() to have run.
    try {
        const mod = await import('../../index.mjs');
        if (typeof mod.getRoleConfig === 'function') {
            setRoleResolver(mod.getRoleConfig);
            return _resolveRole(role);
        }
    } catch { /* ignore */ }
    return _hiddenRoleConfig(role);
}

function _syncGetRoleConfig(role) {
    return _resolveRole(role);
}

export class SmartBridge {
    constructor(opts = {}) {
        this.userRoles = opts.userRoles || {};
        this.presets = Array.isArray(opts.presets) ? opts.presets : [];
        this.llmCall = opts.llmCall || null;
        this.registry = opts.registry || CacheRegistry.shared();
    }

    /**
     * Async resolution — used by bridge-llm and any caller that can await.
     * Returns the same shape as resolveSync but falls back to the default
     * preset when no role config is found.
     */
    async resolve(request) {
        const role = request?.role || request?.taskType || null;
        const roleConfig = role ? await _lazyGetRoleConfig(role) : null;
        return this._finalize(roleConfig, request || {});
    }

    /**
     * Sync variant — used by createSession and the bridge tool entry point.
     * Returns null only when called before agent init has populated the
     * role-config cache. Callers fall back to classic preset behaviour.
     */
    resolveSync(request) {
        if (!request) return null;
        const role = request.role || request.taskType || null;
        const roleConfig = role ? _syncGetRoleConfig(role) : null;
        return this._finalize(roleConfig, request);
    }

    _finalize(roleConfig, request) {
        const profile = buildVirtualProfile(roleConfig);

        let presetName = request.preset
            || (request.role ? this.userRoles[request.role] : null)
            || (roleConfig?.preset || null)
            || null;

        let preset = this._findPreset(presetName);

        const provider = request.provider || preset?.provider || null;
        const model = request.model || preset?.model || null;
        const effort = preset?.effort || null;
        const fast = preset?.fast === true;

        const cacheOpts = buildProviderCacheOpts(provider, request.sessionId);

        return {
            profile,
            preset: preset || (presetName ? { name: presetName, id: presetName } : null),
            presetName,
            provider,
            model,
            effort,
            fast,
            source: roleConfig ? 'role-config' : 'default',
            reasoning: null,
            providerCacheOpts: cacheOpts,
        };
    }

    _findPreset(name) {
        if (!name || !this.presets.length) return null;
        return this.presets.find(p => p.id === name || p.name === name) || null;
    }

    /**
     * Called after a successful send to update the cache registry. Records
     * hit/miss from usage.cachedTokens when available. The registry keys on
     * the profile id (which is the role name post-refactor).
     */
    recordCall(profile, provider, { systemPrompt, tools, usage }) {
        if (!profile) return;
        const prefixContent = computePrefixContent(systemPrompt, tools);
        const ttlSeconds = ttlSecondsForCache();
        if (ttlSeconds > 0) {
            this.registry.markWarm(profile.id, provider, prefixContent, ttlSeconds);
        }
        const cachedTokens = usage?.cachedTokens ?? 0;
        if (cachedTokens > 0) {
            this.registry.recordHit(profile.id, provider);
        } else if (usage?.inputTokens > 0) {
            this.registry.recordMiss(profile.id, provider);
        }
        if (this.registry.dirty) this.registry.save();
    }

    /**
     * Called when user changes preset mapping for a role.
     */
    updateUserRoles(userRoles) {
        this.userRoles = userRoles || {};
    }

    /**
     * Update preset catalog — call when agent-config.json's presets change.
     */
    updatePresets(presets) {
        this.presets = Array.isArray(presets) ? presets : [];
    }

    /**
     * Returns a virtual profile for a role id. Used by session manager to
     * rehydrate the profile object after session reload.
     */
    getProfile(id) {
        if (!id) return null;
        const roleConfig = _syncGetRoleConfig(id);
        return buildVirtualProfile(roleConfig);
    }

    getStats() {
        return this.registry.getStats();
    }
}

/**
 * Singleton accessor.
 */
export function initSmartBridge(opts = {}) {
    _sharedInstance = new SmartBridge(opts);
    return _sharedInstance;
}

export function getSmartBridge() {
    if (!_sharedInstance) {
        _sharedInstance = new SmartBridge();
    }
    return _sharedInstance;
}

