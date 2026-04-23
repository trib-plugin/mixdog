# Changelog

All notable changes to mixdog are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.14] - Unreleased

### Security / Reliability

- **C1 — Loopback bind**: `server.listen` now binds to `127.0.0.1` only; the config UI is never reachable from the LAN.
- **C2 — Origin/Referer guard**: added `isAllowedOrigin(req)` helper that allows direct curl/native clients (no Origin header) and rejects browser cross-origin requests not matching `http://(localhost|127.0.0.1):3458`. Returns `403 { ok: false, error: 'forbidden: cross-origin' }`. Applied to all mutating routes: `POST /config`, `POST /modules`, `POST /capabilities`, `POST /schedules`, `POST /webhooks`, `POST /agent/config`, `POST /agent/presets`, `POST /agent/maintenance`, `POST /agent/validate`, `POST /agent/learning`, `POST /memory/config`, `POST /memory/presets`, `POST /memory/backfill`, `POST /memory/delete`, `POST /memory/validate`, `POST /search/config`, `POST /search/validate`, `POST /install`, `POST /install/voice` + `GET /install/voice?stream=1`, `POST /api/memory/entries`, `POST /api/memory/entries/:id/status`, `POST /general/save`, `POST /md/project`, `POST /md/role`, `POST /workflow/save`, `POST /workflow/md`.
- **H3/H4 — Download integrity + .part pattern**: `downloadFile` now writes to `destPath + '.part'` and renames to `destPath` on success. Captures `content-length` as `expectedTotal`; on finish, if `bytesWritten !== expectedTotal` the `.part` file is deleted and the promise rejects with a truncation error. On any stream/socket/HTTP error the `.part` file is cleaned up. Added `unlinkSync`/`statSync` to named imports.
- **H3 — Model idempotency threshold**: `downloadModelToDataDir` threshold changed from `> 100 MB` to `>= 1.4 GB` (catches truncated re-runs of the ~1.5 GB turbo model). Added `// TODO: pin sha256 when upstream publishes` comment.
- **H5 — Abort on disconnect**: `/install/voice` handler sets up an `AbortController`; on `req.close` (while response still open) sets `aborted = true` and calls `abortController.abort()`. The signal is threaded into `downloadFile` (cleans up `.part` on abort) and `downloadModelToDataDir`. All `emitSSE`/`emitStage` calls are no-ops when `aborted`. `if (aborted) return` guards added before each long-running stage (downloads, builds, smoke test).
- **H6 — First-boot flag timing**: in `hooks/session-start.cjs`, the `.first-boot-seen` flag write is now moved to after the ngrok and git-hook spawn blocks, so the flag is only written once the spawns have been issued rather than before them.
- **H7 — PowerShell array-form spawn**: `Expand-Archive` call replaced with `spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive', '-Force', '-Path', archivePath, '-DestinationPath', binDir])` with `status !== 0` check. No more shell interpolation of archive path.
- **M8 — Array-form git/cmake on Linux**: `execSync` string-interpolated commands replaced with `spawnSync` array form for `git clone`, `cmake -B build`, and `cmake --build build`. Includes status-check error returns.
- **M9 — Validate tag_name**: after resolving the Purfview GitHub release `tag_name`, validates it matches `/^[\w.\-]+$/` and throws (falling back to `FALLBACK_PURFVIEW_TAG`) if it contains unsafe characters.

### Changed
- `downloadFile` User-Agent bumped to `mixdog/0.1.14`.

## [0.1.13] - Unreleased

### Added
- **Purfview dynamic release tag lookup (Windows)**: the Windows voice-install branch now queries `GET https://api.github.com/repos/Purfview/whisper-standalone-win/releases/latest` (5 s timeout, no auth) to resolve the current `tag_name` before constructing the download URL. Falls back to the hardcoded constant `FALLBACK_PURFVIEW_TAG = 'r245.5'` on any network/API error, logging a single stderr line.
- **SSE progress streaming for `/install/voice`**: the handler now accepts `GET /install/voice?stream=1` in addition to the legacy `POST`. In SSE mode it emits `event: stage` (stage transitions), `event: progress` (download bytes/total/speed every ≥ 200 ms), `event: done`, and `event: error` events so the UI can show real-time progress during the ~1.5 GB model download.
- **`downloadModelToDataDir(onProgress)`**: the model-download helper now accepts an optional `onProgress({bytes, total, speed})` callback; download speed is computed as bytes/sec over each 200 ms window. All three platform branches (win/mac/linux) pass the SSE emitter.
- **`downloadFile` progress hook**: the low-level `downloadFile` helper now accepts an optional `onProgress` callback and reports byte counts + speed in real time via `resp.on('data', …)`.
- **Stage events for all platforms**: all significant steps (purfview-lookup, purfview-download, purfview-extract, brew-check, brew-install, brew-prefix, brew-binary, build-tools-check, git-clone, build, download-model, write-config, smoke-test) emit `stage` SSE events with descriptive messages.
- **Progress bar UI in `setup.html`**: the voice install section now renders a progress bar (`.voice-progress-bar / .voice-progress-fill`), a stage label, and a download speed line. Uses `EventSource` with `addEventListener('stage'/'progress'/'done'/'error')`. On `done` with `skipped:true` it renders the installed state; on `error` it shows stage + message and re-enables the Retry button.
- **Linux distro expansion**: `/etc/os-release` detection extended with openSUSE (`ID=opensuse-*` or `ID_LIKE=*suse*` → `zypper`), Void Linux (`ID=void` → `xbps-install`), NixOS (`ID=nixos` → `nix-env` with declarative-config note), and Gentoo (`ID=gentoo` → `emerge`). The source-build fallback path is unchanged.

### Changed
- `downloadFile` User-Agent bumped to `mixdog/0.1.13`.
- `installVoice()` in `setup.html` migrated from `fetch` + JSON to `EventSource` SSE; legacy JSON POST endpoint preserved for backwards compatibility.

## [0.1.12] - Unreleased

### Added
- **`scripts/bump-version.mjs`** — one-command version sync across `package.json`, `package-lock.json`, and `.claude-plugin/plugin.json`. Validates semver, skips absent files gracefully, prints a summary of touched files.
- **`scripts/check-version.mjs`** — reads all version fields and exits 1 on any mismatch with a formatted table showing which field differs. Usable in CI pipelines and as a pre-commit hook.
- **`scripts/install-git-hooks.mjs`** — installs a pre-commit hook at `.git/hooks/pre-commit` that blocks commits when versions are out of sync. Idempotent: appends to existing hooks rather than overwriting; no-ops when the guard is already present; skips gracefully in non-git environments.
- **Auto-install pre-commit hook on first boot**: `hooks/session-start.cjs` now spawns `install-git-hooks.mjs` in the background on first boot (same guard as ngrok install), but only when the plugin directory is inside a git repo.
- **`npm run bump`** — alias for `node scripts/bump-version.mjs`.
- **`npm run check:version`** — alias for `node scripts/check-version.mjs`.

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
