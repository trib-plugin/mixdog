/**
 * Shared LLM helpers (post v0.6.46).
 *
 * The legacy `callLLM` dispatcher and direct CLI/HTTP runners have been
 * removed — every LLM call now flows through `bridge-llm.mjs`
 * (`makeBridgeLlm({ taskType })`) and, for memory maintenance specifically,
 * through `maintenance-llm.mjs`'s thin wrapper.
 *
 * Only preset resolution remains here: memory-cycle and future backend
 * callers still need a consistent way to map `(task, agent-config)` to a
 * preset id.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_MAINTENANCE } from '../../agent/orchestrator/config.mjs'
import { resolvePluginData } from '../plugin-paths.mjs'

const AGENT_CONFIG_PATH = join(resolvePluginData(), 'agent-config.json')

function loadAgentConfig() {
  try {
    return JSON.parse(readFileSync(AGENT_CONFIG_PATH, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[llm] agent-config parse error: ${e.message}`)
    return {}
  }
}

/**
 * Resolve maintenance preset ID for a given task from agent-config.
 * Falls back to canonical defaults (DEFAULT_MAINTENANCE from config.mjs).
 */
export function resolveMaintenancePreset(task, agentConfig) {
  const cfg = agentConfig || loadAgentConfig()
  const maint = cfg?.maintenance || {}
  const presetId = maint[task] || maint.defaultPreset
    || DEFAULT_MAINTENANCE[task] || DEFAULT_MAINTENANCE.defaultPreset
  const presets = cfg?.presets || []
  if (presets.some(p => p.id === presetId || p.name === presetId)) return presetId
  return { id: '_fallback', type: 'bridge', provider: 'anthropic-oauth', model: 'claude-sonnet-4-6', effort: 'medium' }
}
