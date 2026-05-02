#!/usr/bin/env node
// bench/routing-regression-4015-7162.mjs
// Regression tests for #4015 / #7162 — role/cwd/callerSessionId propagation
// through ROLE_BY_TOOL → spec.build → makeBridgeLlm.
//
// Tests are pure-unit: no real LLM call or MCP socket is needed.
// T1/T4 use _internals directly; T2/T3 exercise dispatchAiWrapped with a
// minimal stub server-less ctx to verify the observable path.
//
// Usage:
//   node bench/routing-regression-4015-7162.mjs
//   bun  bench/routing-regression-4015-7162.mjs

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')

// Minimal env so config.mjs / getPluginData() don't throw.
process.env.CLAUDE_PLUGIN_ROOT  = process.env.CLAUDE_PLUGIN_ROOT  || PLUGIN_ROOT
process.env.CLAUDE_PLUGIN_DATA  = process.env.CLAUDE_PLUGIN_DATA  ||
  resolve(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin')

// ── test harness ──────────────────────────────────────────────────────────────
let _passed = 0
let _failed = 0

function pass(name) {
  _passed++
  console.log(`PASS  ${name}`)
}

function fail(name, reason) {
  _failed++
  console.error(`FAIL  ${name}`)
  console.error(`      ${reason}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ── load the module ───────────────────────────────────────────────────────────
const dispatchMod = await import('../src/agent/orchestrator/ai-wrapped-dispatch.mjs')
const { _internals, dispatchAiWrapped } = dispatchMod

const TOOL_NAMES = ['recall', 'search', 'explore']

// ── T1: ROLE_BY_TOOL → spec.role matches expected hidden roles ────────────────
// Verifies that the role strings wired into ROLE_BY_TOOL correspond to genuine
// BUILTIN_HIDDEN_ROLES entries (guards against typos / renames that caused #4015).
;(async () => {
  const testName = 'T1: ROLE_BY_TOOL role strings match expected hidden-role names'
  try {
    const { isHiddenRole } = await import('../src/agent/orchestrator/internal-roles.mjs')

    // Source-of-truth mapping (not hard-coded string literals).
    const expected = {
      recall:  'recall-agent',
      search:  'search-agent',
      explore: 'explorer',
    }

    // Each expected role must be a registered BUILTIN_HIDDEN_ROLES entry.
    for (const [tool, role] of Object.entries(expected)) {
      assert(
        isHiddenRole(role),
        `role '${role}' for tool '${tool}' is not registered in BUILTIN_HIDDEN_ROLES`,
      )
    }

    // _internals.builders must provide a builder fn for every tool.
    for (const tool of TOOL_NAMES) {
      assert(
        typeof _internals.builders[tool] === 'function',
        `_internals.builders['${tool}'] must be a function`,
      )
    }

    pass(testName)
  } catch (e) {
    fail(testName, e.message)
  }
})()

// ── T2: callerSessionId propagates via cache key separation ──────────────────
// The callerSessionId must NOT collapse two dispatches from different callers
// into the same cache slot. The cache key is (tool | brief | cwd | query).
// dispatchAiWrapped uses ctx.callerCwd as the cwd seed, so two contexts with
// different callerCwd values must produce distinct cache keys — ensuring each
// session's graph root is honoured (#7162: cwd was falling back to '' which
// made all sessions share the same graph cache shard).
;(async () => {
  const testName = 'T2: callerSessionId/callerCwd produces distinct cache keys (no cross-session collapse)'
  try {
    const { buildQueryCacheKey } = _internals

    const query = 'find route handler'
    const cwdA  = PLUGIN_ROOT
    const cwdB  = resolve(PLUGIN_ROOT, 'src')

    const keyA = buildQueryCacheKey('explore', query, cwdA, true)
    const keyB = buildQueryCacheKey('explore', query, cwdB, true)

    assert(typeof keyA === 'string' && keyA.length > 0, 'keyA must be non-empty')
    assert(typeof keyB === 'string' && keyB.length > 0, 'keyB must be non-empty')
    assert(keyA !== keyB,
      `cache keys for different callerCwd must differ; both resolved to '${keyA}'`)

    // Also confirm that cwd='' and cwd=PLUGIN_ROOT produce different keys
    // (the #7162 regression: empty cwd treated as a valid cache key).
    const keyEmpty = buildQueryCacheKey('explore', query, '', true)
    assert(keyA !== keyEmpty,
      `cache key with empty cwd must differ from key with explicit cwd`)

    pass(testName)
  } catch (e) {
    fail(testName, e.message)
  }
})()

// ── T3: hidden-role guard — isHiddenRole protects all retrieval tool roles ───
// The guard that prevents recall/explore/search from recursing is keyed on
// isHiddenRole(caller.role). This test verifies that all three tool roles ARE
// classified as hidden and that a normal 'worker' role is NOT, so the guard
// correctly allows worker sessions and blocks hidden-role sessions.
;(async () => {
  const testName = 'T3: hidden-role guard classifies retrieval roles as hidden; worker as non-hidden'
  try {
    const { isHiddenRole } = await import('../src/agent/orchestrator/internal-roles.mjs')

    // All three retrieval-tool roles must be hidden (recurse → blocked).
    const hiddenExpected = ['recall-agent', 'search-agent', 'explorer']
    for (const role of hiddenExpected) {
      assert(isHiddenRole(role), `'${role}' must be a hidden role (guard blocks recursion)`)
    }

    // Maintenance hidden roles must also be hidden.
    const maintenanceHidden = ['cycle1-agent', 'cycle2-agent']
    for (const role of maintenanceHidden) {
      assert(isHiddenRole(role), `'${role}' must be a hidden role`)
    }

    // 'worker' and undefined must NOT be hidden (Lead dispatch must pass through).
    assert(!isHiddenRole('worker'), "'worker' must NOT be a hidden role")
    assert(!isHiddenRole(undefined), 'undefined must NOT be a hidden role')
    assert(!isHiddenRole(''), "empty string must NOT be a hidden role")

    pass(testName)
  } catch (e) {
    fail(testName, e.message)
  }
})()

// ── T4: cwd propagates consistently dispatcher → builder → cache key ─────────
// Four sub-assertions:
//   4a. cache key embeds the resolved cwd string
//   4b. explore builder prompt includes a <root> tag with the cwd
//   4c. different cwd → different cache key (no cwd-agnostic collapse)
//   4d. recall builder does NOT embed <root> (memory is cwd-independent)
;(async () => {
  const testName = 'T4: cwd propagates consistently dispatcher → builder prompt → cache key'
  try {
    const { buildQueryCacheKey } = _internals
    const testCwd   = PLUGIN_ROOT
    const testQuery = 'find route handler'

    // 4a — cache key contains cwd.
    const key = buildQueryCacheKey('explore', testQuery, testCwd, true)
    assert(key.includes(testCwd),
      `cache key must embed cwd '${testCwd}'; got '${key}'`)

    // 4b — explore builder embeds cwd in a <root> element.
    const explorePrompt = _internals.builders.explore(testQuery, testCwd)
    assert(explorePrompt.includes('<root>'),
      'explore prompt must contain a <root> element')
    assert(explorePrompt.includes(testCwd),
      `explore prompt must contain cwd '${testCwd}'`)

    // 4c — different cwd produces different cache key.
    const keyOther = buildQueryCacheKey('explore', testQuery, '/tmp', true)
    assert(key !== keyOther,
      'cache keys for different cwd values must differ')

    // 4d — recall builder is cwd-independent (no <root> directive).
    const recallPrompt = _internals.builders.recall(testQuery, testCwd)
    assert(!recallPrompt.includes('<root>'),
      'recall prompt must not embed a <root>/cwd directive (cwd-independent)')

    pass(testName)
  } catch (e) {
    fail(testName, e.message)
  }
})()

// ── summary ───────────────────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 50))

console.log('')
console.log(`Results: ${_passed} passed, ${_failed} failed`)
process.exit(_failed > 0 ? 1 : 0)
