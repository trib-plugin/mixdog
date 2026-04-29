#!/usr/bin/env bun
/**
 * SessionStart hook — clear the active orchestrator session pointer.
 * Each Claude Code session starts fresh; users opt back in via /mixdog:resume
 * or /mixdog:new (or simply call /mixdog:ask to auto-create).
 *
 * Stored sessions on disk are NOT deleted — only the pointer is cleared.
 */
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { resolvePluginData } from '../src/shared/plugin-paths.mjs';

try {
    const path = join(resolvePluginData(), 'active-session.txt');
    if (existsSync(path)) unlinkSync(path);
} catch {
    // best-effort, never fail the session start
}
process.exit(0);
