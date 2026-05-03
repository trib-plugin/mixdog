import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_PRESETS, DEFAULT_MAINTENANCE } from '../agent/orchestrator/config.mjs';

const DEFAULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'defaults');

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
    'mixdog-config.json': () => {
        // Template carries the static channels/memory/search defaults; agent
        // section is composed at seed time so DEFAULT_PRESETS picks up the
        // ANTHROPIC_DEFAULT_*_MODEL env overrides resolved at boot. Top-level
        // key order is rebuilt explicitly so seed output stays
        // channels/memory/agent/search regardless of template author.
        const template = JSON.parse(
            readFileSync(join(DEFAULTS_DIR, 'mixdog-config.template.json'), 'utf8'),
        );
        const composed = {
            channels: template.channels,
            memory: template.memory,
            agent: {
                presets: DEFAULT_PRESETS.map((p) => ({ ...p })),
                maintenance: { ...DEFAULT_MAINTENANCE },
            },
            search: template.search,
        };
        return JSON.stringify(composed, null, 2) + '\n';
    },
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
        // Body composition (template read / config build) errors are fatal —
        // a missing defaults/ file means the plugin install itself is
        // incomplete, and silently skipping the seed would leave the user
        // with an empty Config UI. Filesystem errors during the actual write
        // are non-fatal and only logged so a transient mkdir/write failure
        // does not block boot.
        const body = bodyFn();
        try {
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, body, 'utf8');
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
