# Explore root control

`explore` description carries the call rules (single rich query, fan-out, array only for genuinely unrelated questions, scope boundaries vs `recall` / `search`). This file covers root selection only.

## When NOT to use explore

`explore` runs an internal agent that fans out across the codebase — synthesis cost is high. Prefer cheaper tools when:

- The target file or symbol is guessable from the question → `grep` / `find_symbol` is one cheap turn.
- A known identifier needs declaration + references → `find_symbol` default mode returns both in one call.
- A literal pattern needs a yes/no presence check → `grep` with a tight `path` or `glob` filter.

Reserve `explore` for genuinely unknown locations, cross-cutting questions, or when prior cheap probes returned nothing.

## Root control

`cwd` is the authoritative search root. Absolute path or `~` expansion supported. Omitted → launch workspace. Pass `cwd: "~/.claude/..."` explicitly to target the plugin install tree or other directories outside the workspace. No silent fan-out between roots.

## Avoid these cwd shapes (runtime hard-blocks)

Too broad — `explore` synthesises across millions of files and has historically blown the V8 string limit, killing the mcp server. The handler now returns a hard error (MCP `isError`) and never spawns a sub-agent:

- `~`, `$HOME`, `/`, `C:/`, `D:/`, drive roots
- `~/.claude` itself (whole tree mixes sessions, plugins, projects, transcripts)

Narrow first (e.g. `~/.claude/projects/<slug>` for one transcript, `~/.claude/plugins/marketplaces/<plugin>` for plugin source). If the right subdir isn't obvious, do a `list` over `~/.claude` to pick, then `explore` against that subdir.
