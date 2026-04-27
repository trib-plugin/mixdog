/**
 * Smart Bridge — Virtual Profile Helpers
 *
 * Single source of truth for role metadata is `user-workflow.json`, loaded
 * via `getRoleConfig(role)` in agent/index.mjs. This module keeps a small
 * helper used by callers that still think in terms of "profiles":
 *
 *   • buildVirtualProfile(roleConfig)
 *       Turn a user-workflow.json role into the shape older code expected
 *       (`{id, taskType, permission, description}`).
 *
 *   • ROLE_TOOLS_UNIFIED
 *       Every bridge caller ships the same tool surface at the cached
 *       prefix so the tools breakpoint stays bit-identical across roles.
 *       Per-role narrowing happens in the role.md injected into the first
 *       user turn.
 */

export const ROLE_TOOLS_UNIFIED = ['full'];

/**
 * Build a minimal profile-shaped object from a user-workflow.json role.
 * Used by the session manager + bridge-llm to keep the existing
 * `session.profileId` code paths working without introducing a second
 * registry.
 */
export function buildVirtualProfile(roleConfig) {
    if (!roleConfig || !roleConfig.name) return null;
    return {
        id: roleConfig.name,
        taskType: roleConfig.name,
        tools: ROLE_TOOLS_UNIFIED,
        permission: roleConfig.permission && roleConfig.permission !== 'full' ? roleConfig.permission : null,
        fallbackPreset: roleConfig.preset || null,
        description: roleConfig.desc_path || null,
    };
}
