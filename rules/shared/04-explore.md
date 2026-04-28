# Explore

- `explore` — internal codebase navigation. A single natural-language query lets ONE internal agent fan out glob + grep probes and return a synthesized answer covering several angles at once. Same single-agent-judges-multi-angle principle applies to `recall` (memory) and `search` (external web).
- Array form on any of the three = N INDEPENDENT agents, mechanical merge, no cross-synthesis. Default to a single rich query; use array only for genuinely unrelated questions.

## Explore-first (default move)

Start with `explore` for any local-filesystem question where one of these is true:
- the file location is uncertain,
- the answer needs structure + surrounding context ("how does X work AND where is it configured?"),
- the question spans multiple files or multiple angles.

`read` directly ONLY when both the exact absolute path AND the line range are already known. A single `grep` for a precise literal symbol is also fine. But if you catch yourself in a `grep` → `read` → `grep` → `read` loop, **stop immediately and switch to `explore`** — one fan-out call replaces three rounds and wastes no iters on location-finding.

If you know the identifier / constant / function / class name but not the file, prefer `find_symbol` before `grep`.

This rule applies equally to Lead and to every delegated role. Grep+read loops on a known topic are the single biggest source of wasted iters in this workflow; `explore` is the cure.

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
