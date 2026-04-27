# Bridge Cache-Shard Policy

Authoritative policy for prefix-cache shard construction across all bridge sessions. The implementation must satisfy every rule below; reviewers should reject changes that turn stable shared layers into per-call fragments.

## Design philosophy

Maximize cross-role / cross-call cache reuse by packing every role's policy into a SHARED monolithic prefix. Bridge sessions across all roles see bit-identical BP1 + BP2. User-defined customizations (roles / schedules / webhooks) are baked into BP1 as a fixed-value block — a user edit invalidates BP1 once and the new prefix re-warms across every role together.

The only per-call variance lives in BP4 (5m tail). Lead-only fields (e.g. memory recap) never enter bridge sessions.

## 4-Block Layout (Anthropic; non-Anthropic providers concatenate but the prefix bytes match)

| Block | Role | Cache TTL | Hashed by registry | Content | Variability |
|---|---|---|---|---|---|
| BP1 baseRules | system | 1h | YES | bridge common rules + tool/memory/search/explore guidance + DATA_DIR roles/schedules/webhooks (monolithic) | Stable across all bridge calls. Invalidated only when a user edits roles/schedules/webhooks or plugin upgrades. |
| BP2 roleCatalog | system | 1h | YES | every `agents/*.md` + `rules/bridge/*.md` body | Bit-identical across roles. Pool B and Pool C share the same array. |
| BP3 sessionMarker | user (`<system-reminder>` with `<!-- bp3-sentinel -->` marker) | 1h | NO | `# project-context` only | Stable per project. Empty when no project context. |
| BP4 volatileTail | user (`<system-reminder>`, no sentinel) | 5m | NO | role / permission / task-brief | May vary per call. |

**Note on tool schemas (Anthropic):** Anthropic's `cache_control` caches every block from the marked block back through the prefix (order: tools → system → messages). The system block's `cache_control` therefore covers the tool-schema array implicitly, so a separate dedicated tools breakpoint slot is not needed. This frees one of the 4 slots for the messages tail. See `anthropic.mjs:211-214` and `anthropic-oauth.mjs` for the layout decision.

## Hash inputs

`registry.markWarm` / `checkWarm` hash exactly two things:

1. `JSON.stringify(systemMessages)` — array of leading system-role messages from `session.messages` (BP1 + BP2 only)
2. `tools.map(t => ({ name, description, inputSchema }))` — the bridge tool array (sorted alphabetically by name for bridge sessions)

Anything outside these two inputs MUST NOT influence the registry hash. cwd, role, permission, project-context, task-brief, memory recap, files, prompt text, tool results, provider/model/effort/fast — all excluded.

## cwd policy

- `cwd: null` is a fixed sentinel meaning "no caller workspace context". Internal callers (memory-cycle, scheduler, webhook, proactive) pass null deliberately to share one shard.
- Never upgrade `null` to `process.cwd()` — that defeats fork suppression. The public bridge entry at `src/agent/index.mjs` MUST honor null.
- Tilde (`~`) and relative paths must be normalized at the entry point. Once inside `prepareBridgeSession`, cwd is either an absolute path or null.
- cwd does NOT enter the registry hash. cwd-aware tools receive cwd via tool args at call time, not via prompt injection.

## What goes where (must / must-not)

**baseRules (BP1) MUST contain (monolithic, fixed value):**
- `lib/rules-builder.cjs` static bridge injection (tool/memory/search/explore guidance)
- `rules/bridge/00-common.md`
- `DATA_DIR/roles/*.md` — every role definition aggregated
- `DATA_DIR/schedules/*/prompt.md` — every schedule aggregated
- `DATA_DIR/webhooks/*/instructions.md` — every webhook aggregated

User edits to roles/schedules/webhooks invalidate BP1 once. This is acceptable because: (a) edits are infrequent, (b) every role re-warms together to the new prefix, (c) keeping all role policies in BP1 maximizes cross-role hit rate compared to per-call branching.

**baseRules (BP1) MUST NOT contain:**
- per-call values (role identity, permission, task brief, memory recap)
- cwd, project context, file references

**roleCatalog (BP2) MUST contain only:**
- every `agents/*.md` body
- every `rules/bridge/*.md` body

**roleCatalog (BP2) MUST NOT contain:**
- per-role narrowing (always full all-role catalog)
- user-mutable data

**sessionMarker (BP3) MUST contain only:**
- `<!-- bp3-sentinel -->\n# project-context\n<projectContext>` when projectContext is present
- nothing when projectContext is absent — emit no `<system-reminder>` at all in that case

**volatileTail (BP4) MUST contain (any subset):**
- `# role`, `# permission`, `# task-brief`

**Lead-only fields — MUST NOT enter bridge sessions:**
- `# memory-context` — recap / history context. Reserved for Lead session prompt only. Bridge `composeSystemPrompt` callers must not pass `opts.memoryContext` for `opts.owner === 'bridge'`.

## Provider Tier3 selection

Anthropic provider wrapper auto-marks the first user `<system-reminder>` as BP3 (1h). To prevent volatileTail from being mistaken for BP3:

- `sessionMarker` MUST carry the explicit BP3 sentinel `<!-- bp3-sentinel -->` at the head.
- The provider wrapper MUST mark only sentinel-bearing reminders as 1h. Non-sentinel reminders ride 5m default.
- When sessionMarker is empty, no BP3 mark is emitted; volatileTail stays at 5m.

## Tool list canonicalization

Bridge sessions (`opts.owner === 'bridge'`) receive a tool array sorted alphabetically by `tool.name` after the deny-list filter. This eliminates incidental fragmentation from MCP/internal registration order changes.

## Entry-point checklist (cwd handling)

Every external entry point that constructs a bridge session must satisfy:

1. `args.cwd` provided → `normalizeInputPath(args.cwd)` (expand `~`, resolve relative)
2. `args.cwd` absent and `callerCwd` available → use `callerCwd`
3. Both absent → `cwd: null`. NEVER fall back to `process.cwd()`.

Current entry points (must remain compliant):
- `src/agent/index.mjs` `case 'bridge'` (Lead-originated MCP dispatch)
- `src/agent/index.mjs` `case 'bridge_spawn'`
- `src/agent/index.mjs` `case 'create_session'`
- `src/agent/orchestrator/smart-bridge/bridge-llm.mjs` `makeBridgeLlm` (internal callers)

## Trigger map (when prefix transitions)

Single transition cause → effect:

- Edit `lib/rules-builder.cjs` static block, `agents/*.md`, `rules/bridge/*.md`, or any `DATA_DIR/{roles,schedules,webhooks}/*.md` → BP1 or BP2 hash changes once → all roles/presets re-warm together (acceptable, infrequent)
- Add/remove an MCP or internal tool → tool_schema_hash changes → all bridge sessions re-warm
- Project switch → sessionMarker changes → BP3 re-warm; BP1/BP2 untouched
- Per-call (role / permission / task-brief change) → only BP4 5m tail differs; BP1/BP2/BP3 untouched

If a single per-call change invalidates more than BP4, the policy has been violated.

## Forbidden patterns

- per-role tool narrowing in bridge sessions (`opts.allowedTools` whitelist) — fragments BP2 by role group
- `process.cwd()` fallback in any bridge entry point — breaks the null sentinel
- emitting cwd or other variant data inside `<system-reminder>` blocks intended for BP3
- mid-pipeline cwd normalization (do it once at entry)
- routing memory-context into bridge sessions — Lead-only field
- changing the registry hash inputs (additions or removals) without updating this document in the same change
