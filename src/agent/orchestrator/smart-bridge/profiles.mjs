/**
 * Smart Bridge — Virtual Profile Helpers
 *
 * BUILTIN_PROFILES and the router layer were removed in v0.6.72. The single
 * source of truth for role metadata is now `user-workflow.json`, loaded via
 * `getRoleConfig(role)` in agent/index.mjs. This module keeps a couple of
 * small helpers used by callers that still think in terms of "profiles":
 *
 *   • buildVirtualProfile(roleConfig)
 *       Turn a 5-field user-workflow.json role into the shape older code
 *       expected (`{id, taskType, cacheType, behavior, description}`).
 *       `cacheType` is derived from role.behavior: stateless roles use the
 *       stateless cache strategy, stateful roles use the stateful strategy.
 *
 *   • ROLE_TOOLS_UNIFIED
 *       Every Pool B caller ships the same tool surface at the cached
 *       prefix so BP_1 stays bit-identical across roles. Per-role narrowing
 *       happens in the Tier 3 role.md injected into the first user turn.
 */

export const ROLE_TOOLS_UNIFIED = ['full'];

/**
 * Build a minimal profile-shaped object from a user-workflow.json role.
 * Used by the session manager + bridge-llm to keep the existing
 * `session.profileId`, `session.behavior`, and cache-strategy code paths
 * working without introducing a second registry.
 */
export function buildVirtualProfile(roleConfig) {
    if (!roleConfig || !roleConfig.name) return null;
    const behavior = roleConfig.behavior === 'stateless' ? 'stateless' : 'stateful';
    return {
        id: roleConfig.name,
        taskType: roleConfig.name,
        cacheType: behavior,
        behavior,
        tools: ROLE_TOOLS_UNIFIED,
        fallbackPreset: roleConfig.preset || null,
        description: roleConfig.desc_path || null,
    };
}
