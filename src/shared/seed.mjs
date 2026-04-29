import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DEFAULT_PRESETS, DEFAULT_MAINTENANCE } from '../agent/orchestrator/config.mjs';

// Idempotent seed of plugin-owned data files so first-time installs land with
// the Config UI already populated with defaults (presets, search scaffold,
// memory config) instead of presenting empty lists that force the user to
// build everything by hand before the plugin is usable.
//
// Only plugin-owned paths under `<plugin-data>/` are seeded. User-owned
// surfaces — the bare CLAUDE.md outside the managed block, project repo
// files, etc. — are never touched. `existsSync()` gates every write so a
// second boot never overwrites user edits.
//
// Seed bodies are thunks so dynamic content (DEFAULT_PRESETS pulling
// ANTHROPIC_DEFAULT_*_MODEL overrides at load time) resolves at seed time,
// not at module-import time.
const SEEDS = {
    // Main config — seed prompt injection to CLAUDE.md so lead-session
    // rules land in the strongest path on first boot instead of silently
    // falling back to SessionStart-hook-only injection.
    'config.json': () => JSON.stringify({
        promptInjection: {
            mode: 'claude_md',
            targetPath: '~/.claude/CLAUDE.md',
        },
    }, null, 2) + '\n',

    'memory-config.json': () => JSON.stringify({
        enabled: true,
        user: { name: '', title: '' },
        cycle1: { interval: '10m' },
        cycle2: { interval: '1h' },
    }, null, 2) + '\n',

    // Agent config — seed presets + maintenance slots. providers/mcpServers
    // are intentionally omitted so runtime auto-detect (buildDefaultConfig in
    // config.mjs) decides based on env keys and OAuth credentials on each
    // read, rather than freezing a snapshot at first-boot.
    'agent-config.json': () => JSON.stringify({
        presets: DEFAULT_PRESETS.map((p) => ({ ...p })),
        maintenance: { ...DEFAULT_MAINTENANCE },
    }, null, 2) + '\n',

    // Search config — scaffold every supported provider with empty credentials
    // so the Config UI Search tab loads populated rows that the user can fill
    // in. `enabled: true` matches the previous inline default in the search
    // module; the fail-fast guard in ai-wrapped-dispatch checks per-credential
    // emptiness, not this flag.
    'search-config.json': () => JSON.stringify({
        enabled: true,
        rawSearch: {
            priority: ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily', 'xai'],
            maxResults: 10,
            credentials: {
                serper: { apiKey: '' },
                brave: { apiKey: '' },
                perplexity: { apiKey: '' },
                firecrawl: { apiKey: '' },
                tavily: { apiKey: '' },
                xai: { apiKey: '' },
            },
        },
        requestTimeoutMs: 15000,
        crawl: { maxPages: 10, maxDepth: 2, sameDomainOnly: true },
        siteRules: {
            'x.com': { search: 'xai.x_search', scrape: 'xai.x_search' },
        },
    }, null, 2) + '\n',
};

export function ensureDataSeeds(dataDir) {
    if (!dataDir) return { created: [], skipped: [] };
    const created = [];
    const skipped = [];
    for (const [rel, bodyFn] of Object.entries(SEEDS)) {
        const full = join(dataDir, rel);
        if (existsSync(full)) {
            skipped.push(rel);
            continue;
        }
        try {
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, bodyFn(), 'utf8');
            created.push(rel);
        } catch (e) {
            process.stderr.write(`[seed] ${rel} create failed: ${e.message}\n`);
        }
    }
    if (created.length > 0) {
        process.stderr.write(`[seed] created ${created.length} file(s): ${created.join(', ')}\n`);
    }
    return { created, skipped };
}
