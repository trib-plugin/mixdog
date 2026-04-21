#!/usr/bin/env node
/**
 * SessionStart hook — clear the active orchestrator session pointer.
 * Each Claude Code session starts fresh; users opt back in via /mixdog:resume
 * or /mixdog:new (or simply call /mixdog:ask to auto-create).
 *
 * Stored sessions on disk are NOT deleted — only the pointer is cleared.
 */
import { unlinkSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

function resolveDataDir() {
    if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (root) {
        const pluginName = basename(root);
        const marketplace = basename(join(root, '..', '..'));
        return join(homedir(), '.claude', 'plugins', 'data', `${pluginName}-${marketplace}`);
    }
    return join(homedir(), '.claude', 'plugins', 'data', 'mixdog-mixdog');
}

try {
    const path = join(resolveDataDir(), 'active-session.txt');
    if (existsSync(path)) unlinkSync(path);
} catch {
    // best-effort, never fail the session start
}
process.exit(0);
