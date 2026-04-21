import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

// Phase D Ship D — idempotent seed of plugin-owned data files so first-time
// installs land with the Pool B surface already populated enough to edit via
// the Config UI (instead of presenting "file not found" and forcing the user
// to disambiguate between "empty content" vs "missing path").
//
// Only plugin-owned paths under `<plugin-data>/` are seeded. User-owned
// surfaces — the bare CLAUDE.md outside the managed block, project repo
// files, etc. — are never touched.
//
// Every seed is a scaffold: a commented template with edit guidance, not
// real content. The user fills it in. `existsSync()` gates every write so
// a second boot never overwrites user edits.
const SEEDS = {
    // agent.md lives in plugin rules/ (plugin-fixed, not user-editable),
    // so no data-dir seed for it.


    // Phase E: history/user.md and history/bot.md seeds removed.
    // User/bot persona now lives in user-workflow.json role configs and
    // agents/*.md files. Existing data files are no longer read at runtime.

    'memory-config.json': JSON.stringify({
        enabled: true,
        user: { name: '', title: '' },
        cycle1: { interval: '10m' },
        cycle2: { interval: '1h' },
    }, null, 2) + '\n',
};

export function ensureDataSeeds(dataDir) {
    if (!dataDir) return { created: [], skipped: [] };
    const created = [];
    const skipped = [];
    for (const [rel, body] of Object.entries(SEEDS)) {
        const full = join(dataDir, rel);
        if (existsSync(full)) {
            skipped.push(rel);
            continue;
        }
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
