/**
 * Internal hidden roles — plugin-managed, user-untouchable.
 *
 * Unlike user-workflow.json roles (which the user defines and edits freely),
 * these roles are NEVER exposed to callers of the `bridge` MCP tool. They are
 * invoked only by internal MCP handlers (explore / recall / search) and carry
 * their own system prompt + tool-set policy.
 *
 * Lookup order (bridge-llm.resolvePresetName):
 *   1. explicit preset arg
 *   2. opts.preset
 *   3. BUILTIN_HIDDEN_ROLES[role]         ← plugin-internal, this file
 *   4. user-workflow.json[role]           ← user-owned
 *
 * Adding or renaming entries here is a plugin-code change, not a user-config
 * change, so users cannot accidentally break the internal dispatch path by
 * editing their workflow JSON.
 *
 * The preset names refer to entries seeded in agent-config.json via
 * DEFAULT_PRESETS (see config.mjs). If the user deletes the referenced preset
 * from their config the hidden roles degrade gracefully — `resolvePresetName`
 * returns a name, but session creation will fail with a clear "preset not
 * found" error rather than silently mis-dispatching.
 *
 * Kind classification:
 *   - 'retrieval'  : short-lived MCP-invoked retrieval agents (explore/recall/search).
 *                    Receive `retrieval-role-principles` shared rules in BP2.
 *   - 'standalone' : long-running internal agents (memory cycle, recap).
 *                    Receive only their own self section in BP2.
 *
 * Permission classification:
 *   - 'read'       : read-only — write/edit/bash blocked at loop.mjs runtime
 *                    guard with the same error string public read-only roles see.
 *   - 'read-write' : full tool surface — used by hidden agents that legitimately
 *                    mutate state (scheduler-task launches commands,
 *                    webhook-handler persists payloads). bridge-llm honors this
 *                    declaratively instead of forcing every hidden role to 'read'.
 */

// The `slot` field is the maintenance-config key used to look up the preset
// at runtime: loadConfig().maintenance[slot]. By sharing the slot with the
// maintenance tasks (explore / recall / search), the user changes one setting
// and both the hidden-role path and the synth that it may invoke move to the
// new model in lockstep. Preset is NEVER hard-coded here.
export const BUILTIN_HIDDEN_ROLES = Object.freeze({
  'explorer': Object.freeze({
    slot: 'explore',
    systemFile: 'rules/bridge/10-explorer.md',
    description: 'Filesystem navigation agent invoked by the `explore` MCP tool',
    invokedBy: 'explore',
    kind: 'retrieval',
    permission: 'read',
  }),
  'recall-agent': Object.freeze({
    slot: 'recall',
    systemFile: 'rules/bridge/20-recall-agent.md',
    description: 'Memory retrieval agent invoked by the `recall` MCP tool',
    invokedBy: 'recall',
    kind: 'retrieval',
    permission: 'read',
  }),
  'search-agent': Object.freeze({
    slot: 'search',
    systemFile: 'rules/bridge/30-search-agent.md',
    description: 'External info agent invoked by the `search` MCP tool',
    invokedBy: 'search',
    kind: 'retrieval',
    permission: 'read',
  }),
  'cycle1-agent': Object.freeze({
    slot: 'cycle1',
    systemFile: 'rules/bridge/40-cycle1-agent.md',
    description: 'Chunker/classifier invoked by memory-cycle runCycle1',
    invokedBy: 'cycle1',
    kind: 'standalone',
    permission: 'read',
  }),
  'cycle2-agent': Object.freeze({
    slot: 'cycle2',
    systemFile: 'rules/bridge/41-cycle2-agent.md',
    description: 'Root re-scorer invoked by memory-cycle runCycle2',
    invokedBy: 'cycle2',
    kind: 'standalone',
    permission: 'read',
  }),
  'recap-agent': Object.freeze({
    slot: 'recap',
    systemFile: 'rules/bridge/50-recap-agent.md',
    description: 'Session-start handoff summarizer invoked by session-start hook',
    invokedBy: 'recap',
    kind: 'standalone',
    permission: 'read',
  }),
  'proactive-decision': Object.freeze({
    slot: 'proactive',
    systemFile: 'rules/bridge/50-proactive-decision.md',
    description: 'Decision agent invoked by scheduler proactive evaluator',
    invokedBy: 'scheduler',
    kind: 'standalone',
    permission: 'read',
  }),
  'scheduler-task': Object.freeze({
    slot: 'scheduler',
    systemFile: 'agents/scheduler-task.md',
    description: 'Scheduled-task executor invoked by scheduler tick',
    invokedBy: 'scheduler',
    kind: 'standalone',
    permission: 'read-write',
  }),
  'webhook-handler': Object.freeze({
    slot: 'webhook',
    systemFile: 'agents/webhook-handler.md',
    description: 'Webhook payload handler invoked by inbound webhook events',
    invokedBy: 'webhook',
    kind: 'standalone',
    permission: 'read-write',
  }),
  'memory-classification': Object.freeze({
    slot: 'classification',
    systemFile: 'agents/memory-classification.md',
    description: 'Memory entry classifier invoked by memory-cycle classification step',
    invokedBy: 'memory-cycle',
    kind: 'standalone',
    permission: 'read',
  }),
})

/**
 * Return the hidden-role definition, or null if the name is not internal.
 */
export function getHiddenRole(name) {
  if (!name) return null
  return BUILTIN_HIDDEN_ROLES[name] || null
}

/**
 * Boolean check — useful for branching inside bridge-llm / session-manager.
 */
export function isHiddenRole(name) {
  if (!name) return false
  return Object.prototype.hasOwnProperty.call(BUILTIN_HIDDEN_ROLES, name)
}

/**
 * List all hidden role names. Used by diagnostics / setup UI guards to ensure
 * a user-defined role doesn't collide with an internal one.
 */
export function listHiddenRoleNames() {
  return Object.keys(BUILTIN_HIDDEN_ROLES)
}

/**
 * List hidden role names matching a given kind ('retrieval' | 'standalone').
 * Consumed by collect.mjs to drive BP2 cache shard classification dynamically
 * instead of hard-coding role-name sets.
 */
export function listHiddenRolesByKind(kind) {
  const out = []
  for (const [name, def] of Object.entries(BUILTIN_HIDDEN_ROLES)) {
    if (def.kind === kind) out.push(name)
  }
  return out
}
