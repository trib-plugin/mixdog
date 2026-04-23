# Changelog

All notable changes to mixdog are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.8] - Unreleased

### Fixed
- **Dep-hash now uses `package-lock.json`** instead of `package.json`: a version-only plugin bump (e.g. 0.1.7 → 0.1.8 with identical deps) no longer triggers an unnecessary `npm ci`. If `package-lock.json` is absent the hash falls back to only the `dependencies`/`optionalDependencies`/`peerDependencies` objects of `package.json` (sorted for stability), so unrelated metadata changes are also ignored.
- **Lock-holder liveness check**: the shared-install lock file now stores `{pid, hostname, startedAt}` as JSON. A waiting process probes whether the holder is still alive (`process.kill(pid, 0)`) on the same host, or uses a 10-minute mtime threshold on a different host, before stealing the lock — preventing two concurrent `npm ci` runs into the same `node_modules` directory on slow or cold-network machines.
- **Atomic stamp write**: the `.deps-stamp` file is now written via a `.deps-stamp.tmp` + `fs.renameSync` pair, ensuring a crash or out-of-disk error between the `npm ci` and the stamp write can never leave the stamp in an inconsistent state that would suppress a legitimate reinstall.
- **Search seed timeout aligned with example**: the `requestTimeoutMs` default in the first-boot seed was corrected from 30 000 ms to 15 000 ms, matching `search-config.example.json` and the practical MCP tool boundary (~14 s).
- **Removed inaccurate GitHub unauthenticated claim**: the search-config example no longer states that GitHub works without a token. All providers — including GitHub — require a credential; requests are rejected when all provider credentials are blank.

## [Unreleased]

### Added
- Auto-open config UI on first install (session-start hook, `.first-boot-seen` flag).
- `config/memory-config.example.json` — seed reference for the memory pipeline.
- `config/search-config.example.json` — seed reference for web search providers.

### Changed
- npm dependencies now install into the plugin data directory (`~/.claude/plugins/data/mixdog-trib-plugin/node_modules/`) and are reused across plugin versions via a symlink from the cache directory. Upgrades skip reinstall unless `package.json` changes.
- `node-cron` and `sqlite-vec` moved to `optionalDependencies` — both are already loaded via dynamic try/catch imports in code.
- `config/*.example.json` contents now exactly match the actual seed schema written by the server.
- README Quick start reflects automatic bootstrap and Anthropic OAuth as the default provider.

### Fixed
- `search-config.example.json` github.token comment no longer misattributes it to Anthropic OAuth.
- `package.json` version aligned with `.claude-plugin/plugin.json` (both now `0.1.7`).

## [0.1.7] - 2026-04-23

### Fixed
- `claude-md-writer`: after the `trib-plugin` → `mixdog` rename, `CLAUDE.md`
  accumulated two managed blocks (one with the old marker, one with the new),
  causing rules to be duplicated on every session.
- `upsertManagedBlock` now strips all legacy-marker blocks before searching,
  replaces the first current-marker block in place, and collapses blank-line
  runs left by the strips.
- `removeManagedBlock` receives the same legacy-strip pass so teardown does
  not leave old blocks stranded.
- `LEGACY_MARKERS` exported as a frozen array so the next rename only needs
  to append an entry.

## [0.1.6] - 2026-04-23

### Fixed
- Config UI was writing to a hardcoded `mixdog-mixdog/` data path while every
  runtime path resolved `mixdog-trib-plugin/`. UI saves landed in an orphan
  directory, so edits (including the `claude_md` injection-mode switch) never
  reached the session-start hook.

### Changed
- Introduced `lib/plugin-paths.cjs` (CJS) and `src/shared/plugin-paths.mjs`
  (ESM) as single resolvers for the plugin data directory; all callers updated.
- Resolver throws when neither `CLAUDE_PLUGIN_DATA` nor `CLAUDE_PLUGIN_ROOT`
  is set, preventing silent fallback to a stale path.

## [0.1.5] - 2026-04-23

### Changed
- Config UI (`setup.html`): opens on the **Modules** tab by default instead
  of Connection.
- Config UI: shortened OAuth provider labels to prevent truncation in
  Providers/Status rows.
- Config UI: moved Webhook settings from Advanced into the dedicated Webhooks
  tab; Advanced panel renamed to Voice.
- Config UI: Custom Workflow preset dropdown now matches stored `role.preset`
  against both `id` and `name`, fixing silent HAIKU fallback for existing
  `SONNET HIGH` / `OPUS XHIGH` entries.
- Config UI: dropped model-id suffix from Proactive / Schedule / Webhook card
  dropdowns for consistent preset selection styling.
- Default injection mode flipped from `hook` to `claude_md` for new installs.

### Fixed
- `setup/launch.mjs`: parent-PID detection now walks one level up the process
  tree (grandparent of the shell wrapping `node launch.mjs`) so
  `MIXDOG_SETUP_PARENT_PID` points at the Claude Code CLI; previous behaviour
  killed the config UI server ~5 s after spawn because the shell exited.

## [0.1.4] - 2026-04-23

### Added
- `seed.mjs`: first-install seeding now covers `agent-config.json` (preset
  definitions + maintenance role slots) and `search-config.json` (empty
  provider credential scaffold), in addition to the existing
  `memory-config.json`.
- Seed bodies are thunks so model-ID resolution runs at seed time, not at
  import time.

### Changed
- `ai-wrapped-dispatch.mjs`: `background` default flipped to `false` so
  `recall` / `explore` / `search` answers land in-turn as the MCP tool
  response rather than via a deferred channel notification.
- `ai-wrapped-dispatch.mjs`: fail-fast guard added when `search` is called
  with zero configured provider credentials, preventing silent hallucinated
  output.
- `tools.json`: updated `recall` / `explore` / `search` descriptions and
  `background` parameter docs to reflect sync-by-default behaviour.
- `rules/lead/02-channels.md`: clarified that `dispatch_result` channel
  notifications only arrive when the caller explicitly passes
  `background: true`.

## [0.1.2] - 2026-04-23

### Fixed
- MCP server config key renamed from `trib-plugin` to `mixdog` so Claude Code
  registers the server under the correct name.
- Removed self-referential `env` block from `.claude-plugin/plugin.json` and
  `.mcp.json`; literal `${CLAUDE_PLUGIN_ROOT}` strings were being passed as
  values instead of resolved by Claude Code, breaking `server.mjs` startup.

## [0.1.0] - Initial release

First public release of mixdog — an all-in-one Claude Code plugin that bundles
four cooperating modules behind a single MCP server.

### Added
- **Agent orchestrator** — multi-provider sub-agents (Anthropic, OpenAI,
  Google Gemini, OpenAI-compatible local endpoints) with a workflow store,
  session compression, and cross-provider prompt caching.
- **Persistent memory** — hybrid (FTS + vector) recall over a local SQLite
  store, plus a two-cycle chunk / curate pipeline that promotes durable
  facts to core memory.
- **Smart search** — unified web search, URL scraping, and GitHub
  code / issue / repo lookup behind a single natural-language entry point.
- **Channels (Discord)** — optional Discord backend with message I/O,
  scheduler (timed + proactive), voice pipeline, and webhook receiver.
- **Syntax-aware code tools** — AST-based code graph, reference tracing,
  multi-file rename, and patch application that preserve working context.
- **Session resilience** — crash-safe session store with trim / compress,
  stream watchdog, and background job tracking.
- **Configurable UI surface** — slash commands, hooks, and agent roles
  shipped as plain markdown and ESM, ready to edit in place.
