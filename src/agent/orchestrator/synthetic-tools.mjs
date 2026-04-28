/**
 * Pool C synthetic tool definitions.
 *
 * These tools bypass the public MCP surface (not in tools.json) but are
 * registered at boot via server.mjs -> addInternalTools so every bridge
 * session with tools='full' sees them. Recall-agent / search-agent are the
 * primary callers, but since the unified-shard policy keeps BP_1 identical
 * across roles, every Pool B/C session carries the same schema.
 *
 * Executors live in server.mjs because they need loadModule() + callWorker
 * bindings that only exist in the main process boot scope. This module ships
 * the `def` half (name + description + inputSchema + annotations) so both
 * server.mjs registration and scripts/measure-bp1.mjs measurement read from
 * the same source of truth — no silent drift between advertised and measured
 * schemas.
 */

export const SYNTHETIC_TOOL_DEFS = Object.freeze([
    {
        name: 'memory_search',
        description: 'Search long-term memory. Returns ranked root entries matching the query. Supports exact time filtering via `period`, pagination via `offset`, alternate sort order, and child-member expansion. Pass `query` as an array to fan out across multiple angles in a single tool call — output groups results per query with `### Query: <text>` headers. Do not repeat an identical memory_search call; if the first result is not useful, change query/period/limit or synthesize.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    anyOf: [
                        { type: 'string', minLength: 1 },
                        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
                    ],
                    description: 'Natural-language query, or an array of queries to fan out in one tool call. Hybrid text + vector search per entry.',
                },
                limit: {
                    type: 'number',
                    description: 'Max root entries to return (default 10).',
                },
                offset: {
                    type: 'number',
                    description: 'Skip this many top entries — use for paging (default 0).',
                },
                period: {
                    type: 'string',
                    description: 'Time filter. Accepted forms: "1h"/"6h"/"24h" (hours back), "1d"/"7d"/"30d" (days back), "YYYY-MM-DD" (specific day), "YYYY-MM-DD~YYYY-MM-DD" (inclusive range), "last" (pre-boot only), "all" (disable — default is 30d when query is set).',
                },
                sort: {
                    type: 'string',
                    enum: ['importance', 'date'],
                    description: 'Sort order. "importance" (default) = score-weighted; "date" = reverse chronological.',
                },
                includeMembers: {
                    type: 'boolean',
                    description: 'When true, expand each root entry with its member chunk ids (default false).',
                },
            },
            required: ['query'],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
        name: 'web_search',
        description: 'Search the web, GitHub, or restricted domains. Supports plain web search, site filters, search type (web/news/images), and GitHub search/read (repositories, code, issues, files). For official/domain web searches, pass only `keywords`, optional `site`, optional `type`; never include GitHub fields. For GitHub read ops (file/repo/issue/pulls), omit `keywords` and pass `owner`+`repo` (+ `path`/`number` as needed). Omit unused optional fields entirely; empty strings and zero placeholders are invalid.',
        inputSchema: {
            type: 'object',
            properties: {
                keywords: {
                    anyOf: [
                        { type: 'string', minLength: 1 },
                        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
                    ],
                    description: 'Search query, or an array of queries to fan out in ONE call (parallel backend, results grouped with `### Query: <text>` headers). Required unless running a GitHub read op (file/repo/issue/pulls). For GitHub read ops, omit this field entirely instead of sending an empty string. Use array form only for genuinely distinct angles — do NOT split one intent into reworded variants.',
                },
                site: {
                    type: 'string',
                    description: 'Restrict results to a domain (e.g. "github.com", "anthropic.com"). Omit when not needed; do not send an empty string.',
                },
                type: {
                    type: 'string',
                    enum: ['web', 'news', 'images'],
                    description: 'Search surface. Default: web.',
                },
                github_type: {
                    type: 'string',
                    enum: ['repositories', 'code', 'issues', 'file', 'repo', 'issue', 'pulls'],
                    description: 'GitHub mode. Search (repositories/code/issues) uses keywords. Read (file/repo/issue/pulls) uses owner+repo. Omit for normal web or non-GitHub site searches.',
                },
                owner: { type: 'string', description: 'GitHub owner (user or org). Required for github_type file/repo/issue/pulls.' },
                repo:  { type: 'string', description: 'GitHub repo name. Required for github_type file/repo/issue/pulls.' },
                path:  { type: 'string', description: 'File path within repo. Required for github_type=file.' },
                number: { type: 'number', description: 'Issue or PR number. Required for github_type=issue.' },
                ref:   { type: 'string', description: 'Git ref (branch/tag/SHA). Optional for github_type=file.' },
                state: {
                    type: 'string',
                    enum: ['open', 'closed', 'all'],
                    description: 'PR filter state for github_type=pulls. Default: open.',
                },
                maxResults: {
                    type: 'number',
                    description: 'Max results returned (1-20).',
                },
            },
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
]);
