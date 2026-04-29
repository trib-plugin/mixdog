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
        description: 'Search long-term memory. Returns ranked root entries. `period` for time filter, `offset` for paging, `sort` for order, `includeMembers` for chunk children. Pass `query` as array to fan out (results grouped per query).',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    anyOf: [
                        { type: 'string', minLength: 1 },
                        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
                    ],
                    description: 'NL query, or array of queries to fan out in one call. Hybrid text + vector search.',
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
        description: 'Search web / restricted domains. Pass `keywords` (string or array for parallel fan-out). Optional `site` to restrict, `type` for surface (web/news/images).',
        inputSchema: {
            type: 'object',
            properties: {
                keywords: {
                    anyOf: [
                        { type: 'string', minLength: 1 },
                        { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
                    ],
                    description: 'Query string, or array for parallel fan-out.'
                },
                site: {
                    type: 'string',
                    description: 'Restrict results to a domain (e.g. "anthropic.com"). Omit when not needed.',
                },
                type: {
                    type: 'string',
                    enum: ['web', 'news', 'images'],
                    description: 'Search surface. Default: web.',
                },
                maxResults: {
                    type: 'number',
                    description: 'Max results returned (1-20).',
                },
            },
            required: ['keywords'],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
]);
