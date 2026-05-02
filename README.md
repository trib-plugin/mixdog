# mixdog

Claude Code all-in-one agent plugin.
Autonomous agents, continuous memory, lower cost,
and every model within Claude Code.

- Proactive autonomous agents — driven by Discord, schedules, and webhooks
- Lower cost — session-spanning cache with real-time token tracking
- Continuous memory — conversations, decisions, and work flow persist across sessions
- Natural-language search — web, GitHub, URL scraping in one line
- All models as sub-agents — OpenAI, Anthropic, Gemini, local models
- Syntax-aware code editing — AST-based exploration and rewrites that save context

## Why mixdog

Claude Code is powerful, but out of the box it forgets everything between
sessions, treats every request as a fresh context, and has no built-in way
to delegate to cheaper or specialised models. Cost runs high, answers
drift, and long-lived projects lose the thread.

mixdog replaces that pattern with a single MCP server that bundles four
cooperating modules — **agent**, **memory**, **search**, and **channels** —
so your Claude Code session gains persistent memory, multi-provider
sub-agents, web / GitHub lookup, and an optional Discord front-end,
all behind one install.

The goal is deployment-grade: plain ESM, zero build step for runtime
code, no hidden state outside the plugin data directory, and every
configuration surface readable as JSON you can diff.

## Install

```
/plugin marketplace add trib-plugin/mixdog
/plugin install mixdog@trib-plugin
```

Claude Code will register the repository as a marketplace, clone it,
run `npm install`, and register the MCP server declared in
`.mcp.json`. Node.js >= 20.10 is required.

## Quick start

1. **Install.**
   ```
   /plugin marketplace add trib-plugin/mixdog
   /plugin install mixdog@trib-plugin
   ```

2. **Restart Claude Code.** The MCP server bootstraps dependencies
   automatically (`npm ci`) and seeds its data directory with working
   defaults under `~/.claude/plugins/data/mixdog-trib-plugin/`.

3. **That's it.** Anthropic OAuth (the Claude Code login) is the default
   provider, so bridge / recall / explore / memory work immediately — no
   API keys required.

4. **Config UI.** On first launch the config UI opens automatically at
   `http://localhost:3458` for providers, presets, and role bindings.
   You can re-open it any time with `/mixdog:config`.

5. **Optional external web search.** Add a Brave / Serper / Tavily / etc.
   key in the config UI (or edit `search-config.json` directly in the
   data directory).

6. **Optional Discord backend.** Copy `config/bot.example.json` to the
   data directory as `bot.json`, fill in the token and channel IDs, then
   enable channels from the config UI.

## Features

### Autonomous agents

The agent module exposes a session orchestrator that can dispatch work
to any registered provider. Each role is a plain markdown prompt under
`agents/` plus a binding in `user-workflow.json`. Sessions run as
long-lived loops with trim / compress, a stream watchdog, and
background job tracking, so Claude Code can fan out real work rather
than one-shot completions.

### Persistent memory

SQLite + `sqlite-vec` back a hybrid FTS + vector store. Every
conversation chunk is scored, deduped, and — if durable — promoted to
core memory. The two-cycle pipeline (chunker → curator) keeps the
active set compact so recall stays fast across months of sessions.

### Cache & cost tracking

A shared-prefix cache strategy propagates Anthropic and OpenAI prompt
caching across every role in a session. Token usage is logged per
provider and per role so you can see where cost lands before the bill
arrives.

### Output compression

Tool results are compressed before they hit the model context: smart
head/tail truncation for large reads, ANSI / whitespace / repeated-line
dedup for sub-agent fan-out bodies, and file-grouped grep output that
emits each path once with indented `line: content` rows.

### Bridge guards

Public bridge roles (worker / reviewer / debugger / tester) route
through direct `read` / `grep` / `find_symbol` on the coordinates Lead
provides; opt-in `allow_retrieval: true` is required to reach
`recall` / `explore` / `search` wrappers. A `<final-answer>` tag
protocol cleanly separates the worker's final reply from any internal
deliberation.

### Multi-provider sub-agents

Anthropic (direct or OAuth), OpenAI (direct or OAuth), Google Gemini,
and any OpenAI-compatible endpoint (LM Studio, Ollama, vLLM, LiteLLM)
are first-class providers. Switch a role to a cheaper model by editing
one line in `user-workflow.json`.

### Smart web search

One natural-language entry point routes across multiple search
providers, scrapes URLs through a Readability pipeline, and talks
directly to GitHub for code / issue / repo lookup. Results are cached
and formatted for model consumption, not browser consumption.

### AST-based code tools

`code_graph`, `references`, `rename_symbol_refs`, and
`rename_file_refs` sit on top of `@ast-grep/cli`, so refactors
stay syntax-correct across large trees without dumping whole files
into the context window.

### Crash-resilient sessions

Session state is journalled to the plugin data directory on every
turn. A mid-session crash — dropped network, killed shell, hard
restart — resumes cleanly on next boot instead of wiping the working
context.

## Configuration

All user-editable config lives in the plugin data directory
(`~/.claude/plugins/data/mixdog-trib-plugin/`), NOT in the repository.
The easiest way to edit it is `/mixdog:config` — this opens the in-browser
UI. Editing the JSON files directly is also fully supported.

The following files are managed in the data directory:

| File                  | How it gets there       | Purpose                                       |
| --------------------- | ----------------------- | --------------------------------------------- |
| `agent-config.json`   | Auto-seeded on install  | Provider presets and maintenance role bindings |
| `user-workflow.json`  | Auto-seeded on install  | Role → preset bindings for delegated agents   |
| `config.json`         | Auto-seeded on install  | Prompt injection mode and target path          |
| `memory-config.json`  | Auto-seeded on install  | Memory pipeline toggles and cycle intervals    |
| `search-config.json`  | Auto-seeded on install  | Web search providers and API credentials       |
| `bot.json`            | Manual copy (see below) | Discord credentials (required for channels)   |

The repository ships matching `.example.json` files under `config/` that
mirror the exact seed defaults — useful as a reference or for diffing
after manual edits.

**Discord setup (optional).** Copy `config/bot.example.json` to the data
directory as `bot.json`, fill in the bot token and channel IDs, then
enable channels from `/mixdog:config`.

## Commands

Slash commands live under `commands/` and are invoked as
`/mixdog:<name>`.

| Command                 | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `/mixdog:new`           | Start a fresh session with a clean context window.   |
| `/mixdog:resume`        | Resume the most recent session (or pick by id).      |
| `/mixdog:clear`         | Clear transient session state while keeping memory.  |
| `/mixdog:config`        | Open the in-browser config page.                     |
| `/mixdog:model`         | Switch the active model for the current role.        |
| `/mixdog:bridge`        | Route a prompt through the external-agent bridge.    |
| `/mixdog:review`        | Delegate a code review to the reviewer role.         |
| `/mixdog:security`      | Run the security-audit prompt on the current diff.   |
| `/mixdog:memory-delete` | Wipe all memory entries (requires `DELETE ALL MEMORY` confirmation). |

## Safety

- **Protected paths.** The MCP server refuses destructive shell
  patterns (recursive root deletes, force pushes, disk formatting)
  unless the caller passes an explicit escape.
- **Approval gates.** Destructive filesystem writes outside the
  workspace and any command that modifies SSH / Git config require a
  user confirmation prompt.
- **Tool scope.** Each role has an explicit tool preset
  (`readonly` / `full` / custom) — there is no ambient access.
- **No background exfiltration.** The plugin makes no outbound calls
  beyond the providers you configure and the search endpoints you
  opt into.

## Windows support

mixdog is developed on Windows and tested on Windows + Linux.
All scripts use forward slashes or `path.join`, line endings are
normalised to LF via `.gitattributes` (except `.cmd` / `.bat` /
`.ps1`, which stay CRLF), and Node child-process calls resolve
binaries through `process.platform`-aware shims.

## License

MIT — see [LICENSE](LICENSE).
