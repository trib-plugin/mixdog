# Changelog

All notable changes to mixdog are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.11] - Unreleased

### Added
- **macOS voice auto-install**: new macOS branch in `/install/voice` probes for Homebrew, runs `brew install whisper-cpp`, resolves the binary via `brew --prefix whisper-cpp` (`whisper-cli` as of Apr 2026), downloads the turbo model, and smoke-tests the binary. If Homebrew is absent a clean error with the https://brew.sh install URL is returned (`stage: brew-check`).
- **Linux voice auto-install**: new Linux branch clones `ggerganov/whisper.cpp` (shallow) into `<dataDir>/voice/whisper.cpp-src/`, builds via CMake into `build/bin/whisper-cli`, downloads the turbo model, and smoke-tests. If any of `git`, `cmake`, `make`, `g++`/`clang++` are missing, returns a clean error with a distro-specific install command (`apt`/`dnf`/`pacman` detected from `/etc/os-release`).
- **Shared voice-install helpers**: extracted `downloadModelToDataDir()`, `writeVoiceConfig()`, and `smokeTestWhisper()` — all three platform branches (win/mac/linux) use these; no duplicated download or config-write logic.
- **Full idempotency across all platforms**: if `voice.command` binary and model already exist and the binary passes a smoke test, the endpoint returns `{ ok: true, skipped: true }` immediately without re-downloading or rebuilding.

### Changed
- `/install/voice` User-Agent bumped to `mixdog/0.1.11`.
- `setup.html` stage-label map extended with macOS/Linux-specific stages: `brew-check`, `brew-install`, `brew-prefix`, `brew-binary`, `build-tools-check`, `git-clone`, `build`.

## [0.1.10] - Unreleased

### Added
- **One-click Voice install**: new `/install/voice` endpoint downloads whisper.cpp binary (Windows x64: Purfview/whisper-standalone-win portable) and `ggml-large-v3-turbo.bin` (~1.5 GB) from HuggingFace into the plugin data directory, writes `voice.command` and `voice.model` to `mixdog-config.json`, and smoke-tests the binary — no Python required. macOS/Linux return a clear "install manually" message (no prebuilt available yet).
- **Voice UI overhaul**: `renderVoiceSection()` now shows a single [Install] button with a stage-level progress label and error display. Installed state shows ✓ badge plus resolved binary and model paths. A "Reinstall" link re-triggers the endpoint for idempotent re-installs.
- **Auto-install ngrok on first boot**: `hooks/session-start.cjs` runs a background `npm install -g ngrok` the first time the plugin boots if `ngrok` is not on PATH. Non-blocking, non-fatal; subsequent boots skip it.
- **`@huggingface/transformers` ^3.x** added to `dependencies` — was missing while being imported by `src/memory/lib/embedding-worker.mjs` and `src/memory/index.mjs`, causing silent failures in vector search.
- **`ffmpeg-static` ^5.x** added to `optionalDependencies` — the cpp branch of `transcribeVoice` now resolves `ffmpeg-static` first and falls back to PATH `ffmpeg`.

### Changed
- `scripts/run-mcp.mjs`: removed `--omit=optional` from both npm arg arrays (legacy fallback and main shared-install path). Optional dependencies (`sqlite-vec`, `node-cron`, Discord voice) now install by default on first boot.
- `/cli-check` endpoint: whisper detection now checks `mixdog-config.json → voice.command` points to an existing file instead of probing PATH for the deprecated `openai-whisper` CLI.
- `/install` endpoint: whisper branch removed (replaced by `/install/voice`); ngrok branch unchanged.

## [0.1.9] - Unreleased

### Fixed
- **Config UI re-open is now idempotent**: the setup-server `/open` endpoint previously skipped `openAppWindow()` when its in-memory `windowOpen` flag was already `true`, which stuck at `true` even when the initial browser spawn silently failed. Subsequent `/mixdog:config` invocations returned 200 without actually opening anything. The flag gate has been removed — every `/open` request now re-triggers the platform browser spawn, so re-running the command self-recovers from a missed first open.

## [0.1.8] - Unreleased

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
- **Dep-hash now uses `package-lock.json`** instead of `package.json`: a version-only plugin bump (e.g. 0.1.7 → 0.1.8 with identical deps) no longer triggers an unnecessary `npm ci`. If `package-lock.json` is absent the hash falls back to only the `dependencies`/`optionalDependencies`/`peerDependencies` objects of `package.json` (sorted for stability), so unrelated metadata changes are also ignored.
- **Lock-holder liveness check**: the shared-install lock file now stores `{pid, hostname, startedAt}` as JSON. A waiting process probes whether the holder is still alive (`process.kill(pid, 0)`) on the same host, or uses a 10-minute mtime threshold on a different host, before stealing the lock — preventing two concurrent `npm ci` runs into the same `node_modules` directory on slow or cold-network machines.
- **Atomic stamp write**: the `.deps-stamp` file is now written via a `.deps-stamp.tmp` + `fs.renameSync` pair, ensuring a crash or out-of-disk error between the `npm ci` and the stamp write can never leave the stamp in an inconsistent state that would suppress a legitimate reinstall.
- **Search seed timeout aligned with example**: the `requestTimeoutMs` default in the first-boot seed was corrected from 30 000 ms to 15 000 ms, matching `search-config.example.json` and the practical MCP tool boundary (~14 s).
- **Removed inaccurate GitHub unauthenticated claim**: the search-config example no longer states that GitHub works without a token. All providers — including GitHub — require a credential; requests are rejected when all provider credentials are blank.

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
