# Changelog

All notable changes to mixdog are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

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
