# Explore root control

`explore` description carries the call rules (single rich query, fan-out, array only for genuinely unrelated questions, scope boundaries vs `recall` / `search`). This file covers root selection only.

## Root control

`cwd` is the authoritative search root. Absolute path or `~` expansion supported. Omitted → launch workspace. Pass `cwd: "~/.claude/..."` explicitly to target the plugin install tree or other directories outside the workspace. No silent fan-out between roots.

## Avoid these cwd shapes (runtime hard-blocks)

Too broad — `explore` synthesises across millions of files and has historically blown the V8 string limit, killing the mcp server. The handler now returns a hard error (MCP `isError`) and never spawns a sub-agent:

- `~`, `$HOME`, `/`, `C:/`, `D:/`, drive roots
- `~/.claude` itself (whole tree mixes sessions, plugins, projects, transcripts)

Narrow first (e.g. `~/.claude/projects/<slug>` for one transcript, `~/.claude/plugins/marketplaces/<plugin>` for plugin source). If the right subdir isn't obvious, do a `list` over `~/.claude` to pick, then `explore` against that subdir.
