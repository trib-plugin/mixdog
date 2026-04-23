# Changelog

All notable changes to mixdog are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.29] - Unreleased

### Fixed

- **StatusLine still invisible on Windows despite 0.1.28 Git Bash path** — 0.1.28 injected `"C:/Program Files/Git/bin/bash.exe" "C:/Users/.../statusline.sh"` into `statusLine.command`. The `bash.exe` path itself was correct, but cmd.exe's quote-handling for the full command string is brittle when *two* separately-quoted paths each contain spaces: depending on whether Claude Code invokes through `cmd /d /s /c` or plain `cmd /c`, the outer quotes are stripped in a way that re-splits `C:/Program Files/...` on the internal space and the whole line silently fails to parse, so the statusline never rendered. `hooks/session-start.cjs` now resolves the Git Bash executable to its 8.3 short form (`C:/PROGRA~1/Git/bin/bash.exe`) via `cmd /c for %I in (...) do @echo %~sI` before injecting, so the executable half has no spaces, needs no outer quoting, and cannot interact with cmd's quote heuristics. The script-path half keeps its quotes for the same reason but there the cache path is under `%USERPROFILE%` which is normally space-free.

## [0.1.28] - Unreleased

### Fixed

- **StatusLine invisible on Windows when `bash` resolves to WSL** — the injected `statusLine.command` was `bash "C:/Users/.../statusline.sh"`. On Windows with WSL installed, PATH resolution picks `C:\Windows\System32\bash.exe` (the WSL launcher) first, which cannot read Windows-style paths and fails with `exit 127, No such file or directory`. Claude Code treats non-zero exit as "hide the statusline", so nothing ever rendered — not even line 1. The earlier 0.1.27 event-loop-contention diagnosis was wrong; the status server was never being reached because the script never ran. `hooks/session-start.cjs` now probes known Git Bash install paths on Windows (`C:/Program Files/Git/bin/bash.exe` and variants) and emits a fully-qualified executable in the command, bypassing PATH and pinning execution to MSYS bash. Non-Windows platforms keep the bare `bash` token.

## [0.1.27] - Unreleased

### Fixed

- **Status HTTP server isolated from MCP tool activity** — 0.1.26 boot-ed the status HTTP server inside the MCP process so it shared the Node event loop with tool handlers. While the MCP process was busy serving bursty tool calls (bash / read / grep), the statusline's 1-second `curl --max-time 1` could not complete, and line 2 silently dropped. The status server now runs in its OWN forked process (`child_process.fork` at boot); the MCP process kills it at shutdown (Windows uses `taskkill /F /T`, elsewhere `SIGTERM` → child's `disconnect` handler). Config is passed via `MIXDOG_STATUS_DATA_DIR` / `MIXDOG_STATUS_ADVERTISE_PATH` env vars. The same HTTP endpoint (`GET /bridge/status`) and advertisement file (`~/.claude/mixdog-status.json`) remain — statusline side is unchanged.

## [0.1.26] - Unreleased

### Fixed

- **StatusLine suppressed when line 2 empty** — `bin/statusline.sh` ended with `[ -n "$L2" ] && printf ...`; when L2 was empty the bare-test exit code 1 propagated to the script, and Claude Code treats non-zero exit as "hide the statusline" — so the fully-rendered line 1 never surfaced. Replaced the `&&` tail with an explicit `if` block and a terminal `exit 0`.

### Added

- **MCP-embedded status HTTP server** — `src/status/server.mjs` boots alongside the MCP process (`server.mjs`) on an ephemeral loopback port and serves `GET /bridge/status` for statusline consumers. Its port is advertised via `~/.claude/mixdog-status.json` (`{pid, port, startedAt}`). Removes the statusline's dependency on the on-demand setup-server (port 3458) — line 2 segments (`Running`, `Last`, `Jobs`, `Next`, `Scheduled`, `Unread`, `Tunnel`, `Recall`) now populate whenever the MCP server is alive, not only when `/mixdog:config` is open.
- **Shared status aggregator** — `src/status/aggregator.mjs` extracts the session / schedule / recall / jobs / ngrok aggregation previously inlined in `setup-server.mjs`. Both the MCP-embedded server and the setup-server now delegate to it, so they cannot drift.
- **Statusline endpoint discovery** — `bin/statusline.sh` reads the port from `~/.claude/mixdog-status.json` and `curl`s the advertised endpoint. Falls back to the legacy `127.0.0.1:3458` (setup-server) when the advertisement is absent.

## [0.1.25] - Unreleased

### Changed

- **StatusLine line 1 redesign** — `bin/statusline.sh` now renders line 1 from stdin-JSON fields only (no dependency on the setup-server endpoint): `Model · EFFORT │ $cost │ Context Window ▓░░ 12% │ 5H 15% │ 7D 8% │ Reset HH:MM`. Separator changed from ` · ` to ` │ ` (U+2502). Labels moved to Title Case (`Context Window`, `5H`, `7D`, `Reset`). Context window usage gained a progress bar (10 cells wide, 6 cells medium, percentage-only narrow) with at-least-one-cell guarantee for non-zero values. Model name is family-only (`Opus`) below the wide breakpoint. Block reset time derived from `rate_limits.five_hour.resets_at` via `date -d @ts` / `date -r ts` / `awk strftime` fallback.
- **Effort indicator** — reads `CLAUDE_CODE_EFFORT_LEVEL` env var first, then falls back to `.effortLevel` in `~/.claude/settings.json` (via `jq`). Rendered uppercase next to the model name when present; silently omitted otherwise.
- **StatusLine line 2 moved to bridge-only** — all incoming/event segments (`Running`, `Last`, `Jobs`, `Next`, `Scheduled`, `Unread`, `Tunnel`, `Recall`) now live exclusively on line 2 and source from the setup-server `/bridge/status` endpoint. When the endpoint is unreachable (setup-server not running) line 2 collapses to empty and is not emitted, so Claude Code does not render a blank second row. Previously the `Idle` sessions pseudo-segment caused line 2 to always render.
- **`statusLine` auto-injection now sets `refreshInterval: 2`** — `hooks/session-start.cjs` writes `refreshInterval: 2` alongside `command` so the statusline re-runs every 2 seconds independent of assistant-message events. Fixes the case where bridge-driven line 2 segments (running agents, schedule next, unread) go stale while the main session is idle waiting on background work. Docs: [Customize your status line — refreshInterval](https://code.claude.com/docs/en/statusline).

## [0.1.24] - Unreleased

### Added

- **StatusLine auto-injection** — `hooks/session-start.cjs` now writes a `statusLine` entry into `~/.claude/settings.json` on every interactive session start, pointing at `${CLAUDE_PLUGIN_ROOT}/bin/statusline.sh`. Tagged with `source: "mixdog-auto"` so subsequent runs refresh the path after a version bump without touching user-owned or other plugins' `statusLine` settings. Replaces the silently-ignored plugin-manifest `statusLine` field attempted in 0.1.22 (removed in 0.1.23); Claude Code's plugin schema does not honour a top-level `statusLine` key, so injection into the user settings file is the only working path.

## [0.1.23] - Unreleased

### Fixed

- **Bridge fast-path / prefetch false positives** — `_extractGithubRepoSlug` in `src/agent/orchestrator/session/manager.mjs` no longer matches arbitrary `word/word` patterns (file paths, URL segments, etc.). Only `github.com/owner/repo` URLs or explicit quoted `owner/repo` tokens qualify, using GitHub's real owner/repo naming constraints, and the returned slug carries a `source` tag. `_isGithubRepoQuery` cross-checks that source; keyword-only triggers are rejected. Previously a prompt containing the word "repo" plus any path was misread as a GitHub repo query, the search result was collapsed to a one-line summary, and the worker returned that string without ever invoking the LLM (`completed=1 tokens_in=0 duration≈300ms`).
- **Fast-path empty-result guard** — `_summarizeRepoSearchText` returns `null` when `_extractRepoSearchEvidence` finds no actual evidence in the search output, so the fast-path falls through to the normal LLM path instead of replacing the task with a canned "… is a GitHub repository." string.
- **Duplicate search call** — when prefetch already injected context, the fast-path is skipped, avoiding a second identical GitHub search (trajectory previously logged two `search` tool calls at iteration 1 for the same slug).

### Added

- **Embedding-based intent classifier** (`src/agent/orchestrator/intent-classifier.mjs`, new) — classifies a prompt against a caller-provided candidate list (`github_repo`, `definition_lookup`, `usage_lookup`, `callers`, `references`, `dependents`, `imports`). Fast-path and prefetch in `manager.mjs` now gate their actions on this classification instead of regex keyword triggers.
- **Code-graph tool surface** (`src/agent/orchestrator/tools/code-graph.mjs`) — `find_symbol` extensions plus symbol-only handling for `callers` / `references`. Tool registrations updated in `tools.json`.
- **Retrieval prompt tightening** — `src/agent/orchestrator/ai-wrapped-dispatch.mjs` and `rules/shared/01-tool.md` sharpen explore / retrieval routing and alias handling.
- **Embedding runtime hardening** — `src/memory/lib/embedding-provider.mjs` cleans up worker `execArgv`; `src/memory/lib/embedding-worker.mjs` fixes ORT loading and corrects the CPU default path.

### Removed

- **Plugin-level `statusLine` field** in `.claude-plugin/plugin.json` (added in 0.1.22). Claude Code's plugin spec only honours `agent` and `subagentStatusLine` keys at the plugin level, so the declared `statusLine` was silently ignored. Regular `statusLine` configuration belongs in the user's own `~/.claude/settings.json`.

## [0.1.22] - Unreleased

### Added

- **Plugin-level `statusLine` auto-injection** — `.claude-plugin/plugin.json` now declares `statusLine.command = bash ${CLAUDE_PLUGIN_ROOT}/bin/statusline.sh`. Claude Code applies the 2-line width-responsive statusline automatically on enable; the setup UI snippet in `~/.claude/settings.json` is no longer required. Users who want to disable it can override `statusLine` in their own settings.

## [0.1.21] - Unreleased

### Changed

- **Discord unread hook wired** — the `recordFetchedMessages` tracker exported in 0.1.19 is now called from every Discord message fetch / receive path in `src/channels/index.mjs`: the HTTP `/fetch` handler, the `createHttpMcpServer` fetch case, the direct-mode MCP fetch case, and the realtime `messageCreate` handler. The snapshot's `discord.totalUnread` now reflects actual state. Label resolution: `labelForChannelId(channelId)` reverse-looks up the human-readable label from `config.channelsConfig`; falls back to raw channel ID.
- **`createHttpMcpServer` fetch pre-existing bug** — that path was passing a label string directly to `backend.fetchMessages` without resolving to a channelId. Fixed as a prerequisite for tracker hook; return shape unchanged.

## [0.1.20] - Unreleased

### Added

- **`find_symbol` MCP tool** — code-graph-backed symbol lookup across the workspace. Implementation in `src/agent/orchestrator/tools/code-graph.mjs` (`_findSymbolAcrossGraph` + new tool def); registered as a builtin in `src/agent/orchestrator/tools/builtin.mjs`. Added to every agent role doc (`agents/worker.md`, `agents/reviewer.md`, `agents/debugger.md`, `agents/tester.md`, `agents/researcher.md`) and the shared tool-routing rules (`rules/shared/01-tool.md`, `rules/bridge/00-common.md`).
- **Explore fast-path** — `runExploreFastPath` in `src/agent/orchestrator/ai-wrapped-dispatch.mjs`. When the query yields a clean identifier candidate, answer directly via `executeBuiltinTool` / `executeCodeGraphTool` without going through the LLM bridge. Layered on top of main's existing `searchProviderKeysMissing` gate and sync-by-default behaviour (0.1.19).
- **`fetch_many` channels MCP tool** — multi-channel fetch in a single call. Defined in `src/channels/index.mjs` alongside existing `fetch`.
- **Bridge eager-dispatch hooks** — `src/agent/orchestrator/session/loop.mjs` and `src/agent/orchestrator/session/manager.mjs` expose fast-path helper surface (`_extractBridgeIdentifier`, `_parseFindSymbolBestCandidate`, etc.).
- **GitHub search metadata** — `src/search/lib/formatter.mjs` renders repo / issue metadata; `src/search/lib/providers.mjs` extracts it from GitHub API responses.
- **`openai-oauth` token grace window** — `_refreshFallbackUntil` in `src/agent/orchestrator/providers/openai-oauth.mjs` keeps the still-valid previous access token usable for a short window if a refresh fails, reducing transient auth failures.
- **`tools.json`** — new tool entries (find_symbol, fetch_many, related). Unchanged for recall / search / explore descriptions.
- **Rule refinements** — `rules/bridge/00-common.md`, `rules/bridge/10-explorer.md`, `rules/shared/01-tool.md`, `rules/shared/04-explore.md` tool-preference and explorer-role guidance.

### Changed

- `server.mjs` dispatch branch now routes `code_graph` tool invocations to the new executor.
- `src/agent/orchestrator/tools/patch.mjs` description tweaked.

## [0.1.19] - Unreleased

### Added

- **Channels worker snapshot** — `src/channels/lib/status-snapshot.mjs` writes `<DATA_DIR>/channels/status-snapshot.json` every 10 seconds (plus once on startup). Covers cross-process data: cron-expression next-fire time, deferred schedule count, Discord unread count (in-memory, no persistence across restarts), ngrok tunnel URL. Atomic write (tmp → rename). Writer started from `startOwnedRuntime()` alongside `scheduler.start()`.
- **`/bridge/status` snapshot integration** — setup-server reads the snapshot when present and fresh (≤30 s old). Merges `schedules.next` (now supports cron-expression schedules, not just HH:MM), `schedules.deferredCount`, `discord.totalUnread`, and `ngrok.tunnelUrl` into the JSON response. Falls back gracefully to config.json-derived best-effort (0.1.17 behaviour) when snapshot is stale or absent.
- **`bin/statusline.sh` rate_limits segments** — parses `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` from Claude Code stdin JSON. Rendered as `⏱ 42%/5h` (wide), `⏱ 42%` (medium), `⏱ 42%` (narrow, ≥50% only). 7d shown only in wide tier as `📅 18%/7d`. Both jq and grep/sed fallback paths updated.
- **`bin/statusline.sh` discord unread segment** — parses `discord.totalUnread` from `/bridge/status` JSON. Rendered as `💬 3 unread` (wide), `💬 3` (medium/narrow). Segment omitted when `totalUnread` is 0 or field is absent.
- **Layout updated across all three width tiers** — line 1 (runtime): `⚙ … · ✓ … · 🔧 … · 🪙 … · ⏱ …`; line 2 (incoming): `⏰ … · 📋 … · 💬 … · 🌐 … · 🧠 … · 📅 …` (wide). Medium and narrow tiers updated accordingly.

### Notes

- Discord unread count is in-memory only; resets to zero on channels worker restart (clean start is fine for v1).
- Passive tracking only: unread count is based on messages received across `fetchMessages` calls — no extra polling loop added.

## [0.1.18] - Unreleased

### Added

- **`bin/statusline.sh`** — bash wrapper that reads Claude Code stdin JSON (cost, model, context) and fetches `GET /bridge/status?format=json` to produce a 2-line width-responsive statusline. Three tiers: ≥120 cols (wide), 80–119 (medium), <80 (narrow). Uses `jq` when available; falls back to `grep`/`sed` parsing. Graceful degradation: missing jq, endpoint down, or absent stdin all handled without error.
- **`/bridge/status` JSON extended** — two new fields: `jobs.count` (active background jobs from `jobs/state.json`) and `ngrok.online` (boolean, probes ngrok local API at `127.0.0.1:4040` with 300 ms timeout).
- **`GET /api/plugin-path`** — new read-only endpoint returns `{ path: <plugin-root> }` so setup.html can render the correct absolute path in the statusline snippet.
- **Setup UI Statusline panel updated** — snippet now shows `bash <plugin-root>/bin/statusline.sh` (path resolved dynamically via `/api/plugin-path`); preview renders a 2-line layout from the JSON endpoint with a note that the cost segment requires Claude Code stdin.

## [0.1.17] - Unreleased

### Added

- **Status endpoint**: new `GET /bridge/status` on the setup-server (port 3458). Supports `?format=json` (structured payload) and `?format=text` / `Accept: text/plain` (single-line statusline string). No Origin guard needed — read-only endpoint per C2 convention.
- **Statusline segments**: active bridge sessions with role list · most recent completed session (within 30 min) · next scheduled item within 12 hours · schedule roster count · recall tool calls in the last hour.
- **Setup UI**: new Statusline panel (General → Statusline) with copyable `settings.json` snippet for Claude Code's `statusLine.command` and a live preview section that fetches current output from the endpoint.

## [0.1.16] - Unreleased

### Changed

- **Cleanup**: removed dead whisper branch from `POST /install` handler (validator already allows only `tool === 'ngrok'`; handler now matches that invariant cleanly)
- **Privacy**: `/cli-check` no longer leaks absolute paths — response now carries `commandName` / `modelName` (basenames only) under `voice` instead of full filesystem paths
- **API**: renamed `_voiceCfg` → `voice` in `/cli-check` response (dropped misleading underscore prefix; `voice.commandName` / `voice.modelName`)

### Fixed

- **Reliability**: smoke test now matches `usage`/`whisper` substring in combined stdout+stderr instead of trusting exit code 0/1 — segfaulting binaries no longer pass
- **Reliability**: smoke test `setTimeout` handle is now cleared on both `close` and `error` paths (was leaking a delayed `resolve(false)` call)
- **UX**: Purfview tag fallback now emits an SSE `purfview-fallback` stage event so users see "Using pinned tag … (GitHub API unreachable)" in the UI

### Internal

- `scripts/bump-version.mjs`: added comment noting that only `lockfileVersion` 2/3 (`packages[""]` path) is handled; v1 (npm 6) only gets the top-level `.version` updated — fine for this repo (npm 7+)

## [0.1.15] - Unreleased

### Fixed

- **Tool-loop-guard: raised `structure_probe` family-abort threshold 32 → 48** — legitimate multi-site edits in large (~2000 LOC) files were hitting the old cap (false-positive abort confirmed in sess_...89263b with 32 distinct calls across 4 tools).
- **Tool-loop-guard: productive-tool reset** — a successful `edit`, `multi_edit`, `batch_edit`, `apply_patch`, `write`, `bash`, or `bash_session` call now resets all family counters (`structure_probe`, `search_fanout`, `edit_roundtrip`). Probe→edit→probe cycles no longer accumulate toward abort; only true uninterrupted grinding triggers the guard.

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
