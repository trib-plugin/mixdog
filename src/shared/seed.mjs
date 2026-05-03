import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { dirname, join, basename } from 'path';
import { DEFAULT_PRESETS, DEFAULT_MAINTENANCE } from '../agent/orchestrator/config.mjs';

// Idempotent seed of the unified mixdog-config.json so first-time installs
// land with the Config UI already populated with defaults (presets, search
// scaffold, memory config) instead of presenting empty lists.
//
// Only plugin-owned paths under `<plugin-data>/` are seeded. User-owned
// surfaces — the bare CLAUDE.md outside the managed block, project repo
// files, etc. — are never touched. `existsSync()` gates every write so a
// second boot never overwrites user edits.
//
// Migration-safe: if any legacy config file is still present in dataDir
// (config.json, agent-config.json, memory-config.json, search-config.json),
// seed is skipped entirely for that key. shared/config.mjs readAll() will
// absorb the legacy files on the first config read and write mixdog-config.json
// with real user data — seeding defaults on top of that would lose the
// migrated content.
const LEGACY_FILENAMES = new Set(['config.json', 'agent-config.json', 'memory-config.json', 'search-config.json']);

//
// Seed bodies are thunks so dynamic content (DEFAULT_PRESETS pulling
// ANTHROPIC_DEFAULT_*_MODEL overrides at load time) resolves at seed time,
// not at module-import time.
const SEEDS = {
    // Single unified config file — all sections in one JSON.
    // Prompt injection seeded under `channels` so lead-session rules land
    // in the strongest path on first boot.
    // providers/mcpServers intentionally omitted from `agent` so runtime
    // auto-detect (buildDefaultConfig) decides based on env keys / OAuth.
    'mixdog-config.json': () => JSON.stringify({
        channels: {
            promptInjection: {
                mode: 'claude_md',
                targetPath: '~/.claude/CLAUDE.md',
            },
        },
        memory: {
            enabled: true,
            user: { name: '', title: '' },
            cycle1: { interval: '10m' },
            cycle2: { interval: '1h' },
        },
        agent: {
            presets: DEFAULT_PRESETS.map((p) => ({ ...p })),
            maintenance: { ...DEFAULT_MAINTENANCE },
        },
        search: {
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
        },
    }, null, 2) + '\n',
};

export function ensureDataSeeds(dataDir) {
    if (!dataDir) return { created: [], skipped: [] };
    const created = [];
    const skipped = [];
    // Guard: if any legacy config file exists, skip ALL seeds so that
    // shared/config.mjs migration runs first (on the next config read) and
    // produces mixdog-config.json from real user data instead of defaults.
    let legacyPresent = false;
    try {
        for (const entry of readdirSync(dataDir)) {
            if (LEGACY_FILENAMES.has(basename(entry))) { legacyPresent = true; break; }
        }
    } catch { /* dataDir not yet created — no legacy files */ }
    if (legacyPresent) {
        return { created, skipped: Object.keys(SEEDS) };
    }
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
