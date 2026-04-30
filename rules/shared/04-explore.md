# Explore root control

`explore` description carries the call rules (single rich query, fan-out, array only for genuinely unrelated questions, scope boundaries vs `recall` / `search`). This file covers root selection only — the part not in the description.

## Root control

The `cwd` argument is the authoritative search root. Absolute path or `~` expansion supported. When omitted, the launch workspace is used — pass `cwd: "~/.claude/..."` explicitly to target the plugin install tree or other directories outside the workspace. No silent fan-out between roots.

## Avoid these cwd shapes (runtime warns, does not block)

These roots are too broad. The runtime warns rather than blocks — `explore` against them synthesises across millions of files and has historically blown the V8 string limit, killing the mcp server. Treat the warn as a self-enforced halt:

- `~`, `$HOME`, `/`, `C:/`, `D:/`, drive roots
- `~/.claude` itself (whole tree — sessions, plugins, projects, transcripts mixed)

If you need something inside one of these, narrow first. Examples:

- transcript investigation → `~/.claude/projects/<project-slug>` (one project) or a single jsonl path with `read`
- plugin source → `~/.claude/plugins/marketplaces/<plugin>` (one plugin)
- rule sources → `~/.claude/plugins/marketplaces/<plugin>/rules`

If the right narrower root isn't obvious, do a `list` over `~/.claude` first to pick the subdir, then `explore` against that subdir.
