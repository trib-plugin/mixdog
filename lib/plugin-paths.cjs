'use strict';

/**
 * Canonical resolver for CLAUDE_PLUGIN_DATA (plugin data dir).
 *
 * Resolution order:
 *   1. process.env.CLAUDE_PLUGIN_DATA  — set by Claude Code when spawning
 *                                        the MCP server or a hook.
 *   2. Derive from CLAUDE_PLUGIN_ROOT  — works both for cache layout
 *                                        (.../cache/{marketplace}/{plugin}/{version}/)
 *                                        and marketplace layout
 *                                        (.../marketplaces/{marketplace}/external_plugins/{plugin}/).
 *
 * Throws if neither env var is present — the plugin always runs under
 * Claude Code, which sets one of them. Callers must not silently fall
 * back to a hardcoded path.
 *
 * DEFAULT_PLUGIN / DEFAULT_MARKETPLACE are exported so a handful of
 * callers (MCP client spawning sibling plugins, session-manager building
 * PLUGIN_ROOT for rule injection) can reference the canonical names
 * without re-hardcoding the strings. Update both in lockstep with
 * `.claude-plugin/marketplace.json` if the marketplace is ever renamed.
 */

const path = require('path');
const os = require('os');

const DEFAULT_PLUGIN = 'mixdog';
const DEFAULT_MARKETPLACE = 'trib-plugin';

function resolvePluginData() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const dirName = path.basename(root);
    // Cache layout: .../cache/{marketplace}/{plugin}/{version}/
    if (/^\d+\.\d+\.\d+/.test(dirName)) {
      const pluginName = path.basename(path.join(root, '..'));
      const marketplace = path.basename(path.join(root, '..', '..'));
      return path.join(os.homedir(), '.claude', 'plugins', 'data', `${pluginName}-${marketplace}`);
    }
    // Marketplace layout: .../marketplaces/{marketplace}/external_plugins/{plugin}/
    const marketplace = path.basename(path.join(root, '..', '..'));
    return path.join(os.homedir(), '.claude', 'plugins', 'data', `${dirName}-${marketplace}`);
  }
  throw new Error('[plugin-paths] CLAUDE_PLUGIN_DATA and CLAUDE_PLUGIN_ROOT are both unset — cannot resolve plugin data dir outside of Claude Code.');
}

module.exports = { resolvePluginData, DEFAULT_PLUGIN, DEFAULT_MARKETPLACE };
