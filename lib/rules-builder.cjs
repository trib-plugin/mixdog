'use strict';

/**
 * mixdog rules builder.
 *
 * Three surfaces:
 *   - buildInjectionContent              — Lead (Claude Code main session)
 *   - buildBridgeInjectionContent        — bridge agent BP1 (true cross-role common)
 *   - buildBridgeRoleSpecificContent     — bridge agent BP3 (role-specific instructions)
 *
 * 4-BP cache layout (composeSystemPrompt):
 *   BP1 = bridge BP1 content (this file's buildBridgeInjectionContent) — every role identical
 *   BP2 = scoped role catalog (collect.mjs loadScopedRoleCatalog) — role family / self
 *   BP3 = project context + role marker + permission + role-specific instructions
 *   BP4 = task brief + memory recap (5m volatile)
 *
 * Source files (rules/):
 *   - shared/01-tool.md              — universal tool policy (Lead + bridge BP1, identical full set)
 *   - shared/02-memory.md            — memory tool detail (Lead when enabled; recall-agent BP3)
 *   - shared/03-search.md            — search tool detail (Lead when enabled; search-agent BP3)
 *   - shared/04-explore.md           — explore tool detail (Lead always; explorer BP3)
 *   - lead/00-tool-lead.md           — Lead-specific control-tower / delegation / ToolSearch guidance
 *   - lead/01-04                     — Lead workflow / channels / team / general
 *   - bridge/00-common.md            — bridge agent common behavior (BP1)
 *   - bridge/01-retrieval-role-principles.md — hidden retrieval family principles (BP1)
 *   - bridge/02-public-work-principles.md — public work-role family principles (BP1)
 *   - bridge/10..50-*.md             — per-hidden-role bodies (consumed by loadScopedRoleCatalog)
 *
 * Core memory snapshot and session recap are injected separately by
 * hooks/session-start.cjs from memory.sqlite (Lead only).
 */

const fs = require('fs');
const path = require('path');

/**
 * Read a single section from mixdog-config.json (unified config).
 *
 * @param {string} dataDir  — DATA_DIR passed into build* functions
 * @param {string} section  — top-level key ('memory' | 'search' | …)
 * @returns {object}
 */
function readConfigSection(dataDir, section) {
  try {
    const unified = JSON.parse(fs.readFileSync(path.join(dataDir, 'mixdog-config.json'), 'utf8'));
    if (unified && typeof unified === 'object') return unified[section] || {};
  } catch {}
  return {};
}

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
}

/**
 * Build the Lead injection content.
 */
function buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const SHARED_DIR = path.join(RULES_DIR, 'shared');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');

  const memoryConfig = readConfigSection(DATA_DIR, 'memory');
  const searchConfig = readConfigSection(DATA_DIR, 'search');
  const parts = [];

  const general = readOptional(path.join(LEAD_DIR, '01-general.md'));
  if (general) parts.push(general);

  const tool = readOptional(path.join(SHARED_DIR, '01-tool.md'));
  if (tool) parts.push(tool);

  if (memoryConfig.enabled) {
    const memory = readOptional(path.join(SHARED_DIR, '02-memory.md'));
    if (memory) parts.push(memory);
  }

  if (searchConfig.enabled) {
    const search = readOptional(path.join(SHARED_DIR, '03-search.md'));
    if (search) parts.push(search);
  }

  const explore = readOptional(path.join(SHARED_DIR, '04-explore.md'));
  if (explore) parts.push(explore);

  const toolLead = readOptional(path.join(LEAD_DIR, '00-tool-lead.md'));
  if (toolLead) parts.push(toolLead);

  const channels = readOptional(path.join(LEAD_DIR, '02-channels.md'));
  if (channels) parts.push(channels);

  const team = readOptional(path.join(LEAD_DIR, '03-team.md'));
  if (team) parts.push(team);

  const workflow = readOptional(path.join(LEAD_DIR, '04-workflow.md'));
  if (workflow) parts.push(workflow);

  const userWorkflowJsonPath = path.join(DATA_DIR, 'user-workflow.json');
  let userWorkflow = { roles: [] };
  try {
    if (fs.existsSync(userWorkflowJsonPath)) {
      userWorkflow = JSON.parse(fs.readFileSync(userWorkflowJsonPath, 'utf8'));
    }
  } catch {}
  if (Array.isArray(userWorkflow.roles) && userWorkflow.roles.length > 0) {
    const roleLines = ['# Roles', ''];
    for (const role of userWorkflow.roles) {
      roleLines.push(`- ${role.name}: ${role.preset}`);
    }
    parts.push(roleLines.join('\n'));
  }

  const userWorkflowMdPath = path.join(DATA_DIR, 'user-workflow.md');
  const userWorkflowMd = readOptional(userWorkflowMdPath);
  if (userWorkflowMd) {
    const startsWithHeader = /^#\s+User Workflow/i.test(userWorkflowMd);
    parts.push(startsWithHeader ? userWorkflowMd : `# User Workflow\n\n${userWorkflowMd}`);
  }

  const userProfile = readOptional(path.join(HISTORY_DIR, 'user.md'));
  if (userProfile) parts.push(`# User Profile\n\n${userProfile}`);

  const botPersona = readOptional(path.join(HISTORY_DIR, 'bot.md'));
  if (botPersona) parts.push(`# Bot Persona\n\n${botPersona}`);

  const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (userName) {
    parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
  }

  return parts.join('\n\n');
}

/**
 * BP1 — true cross-role common. Identical for every bridge role; the
 * role-specific stuff (per-event webhook instructions, per-task schedule
 * instructions, hidden role tool detail) lives in BP3 instead.
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT
 * @param {string} opts.DATA_DIR
 * @returns {string}
 */
function buildBridgeInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const SHARED_DIR = path.join(RULES_DIR, 'shared');
  const BRIDGE_DIR = path.join(RULES_DIR, 'bridge');
  const memoryConfig = readConfigSection(DATA_DIR, 'memory');
  const parts = [];

  // 1. Universal tool policy — same full set Lead receives.
  const tool = readOptional(path.join(SHARED_DIR, '01-tool.md'));
  if (tool) parts.push(tool);

  // 2. Bridge common behavior.
  const common = readOptional(path.join(BRIDGE_DIR, '00-common.md'));
  if (common) parts.push(common);

  // 3. Both family principles — every role sees both, but only the matching
  // family's principles are practically applied. Including both keeps BP1
  // bit-identical pool-wide so cross-role calls share one cache shard.
  const retrievalPrinciples = readOptional(path.join(BRIDGE_DIR, '01-retrieval-role-principles.md'));
  if (retrievalPrinciples) parts.push(retrievalPrinciples);
  const publicWork = readOptional(path.join(BRIDGE_DIR, '02-public-work-principles.md'));
  if (publicWork) parts.push(publicWork);

  // 4. User-defined work-role overrides (DATA_DIR/roles/*.md). Pool-wide.
  const rolesDir = path.join(DATA_DIR, 'roles');
  const collected = [];
  try {
    const stack = [rolesDir];
    while (stack.length) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) collected.push(full);
      }
    }
  } catch {}
  if (collected.length > 0) {
    collected.sort();
    const blocks = collected.map(f => readOptional(f)).filter(Boolean);
    if (blocks.length > 0) {
      parts.push(['# Agent roles', '', blocks.join('\n\n')].join('\n'));
    }
  }

  const userName = (memoryConfig.user && memoryConfig.user.name || '').trim();
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (userName) {
    parts.push(userTitle ? `User: ${userName} (${userTitle})` : `User: ${userName}`);
  }

  return parts.join('\n\n');
}

/**
 * BP3 role-specific instructions. Only the calling role's own task / tool
 * detail body emits — webhook-handler gets webhooks/<all-events>/, scheduler
 * gets schedules/<all-tasks>/, hidden retrieval roles get their own tool
 * detail. Other roles return ''.
 *
 * NOTE: webhook-event narrowing (one event per call) requires the inbound
 * payload's event id at compose time; not implemented yet, so all 4 webhook
 * instructions still bake into webhook-handler BP3 for now.
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT
 * @param {string} opts.DATA_DIR
 * @param {string|null} opts.currentRole
 * @returns {string}
 */
function buildBridgeRoleSpecificContent({ PLUGIN_ROOT, DATA_DIR, currentRole }) {
  if (!currentRole) return '';
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const SHARED_DIR = path.join(RULES_DIR, 'shared');
  const memoryConfig = readConfigSection(DATA_DIR, 'memory');
  const searchConfig = readConfigSection(DATA_DIR, 'search');
  const parts = [];

  // Hidden retrieval roles — fold in self-tool detail.
  if (currentRole === 'recall-agent' && memoryConfig.enabled) {
    const memory = readOptional(path.join(SHARED_DIR, '02-memory.md'));
    if (memory) parts.push(memory);
  } else if (currentRole === 'search-agent' && searchConfig.enabled) {
    const search = readOptional(path.join(SHARED_DIR, '03-search.md'));
    if (search) parts.push(search);
  } else if (currentRole === 'explorer') {
    const explore = readOptional(path.join(SHARED_DIR, '04-explore.md'));
    if (explore) parts.push(explore);
  }

  // webhook-handler / scheduler-task — pull their respective instruction trees.
  const subdirForRole =
    currentRole === 'webhook-handler' ? 'webhooks'
    : currentRole === 'scheduler-task' ? 'schedules'
    : null;
  if (subdirForRole) {
    const dir = path.join(DATA_DIR, subdirForRole);
    const collected = [];
    try {
      const stack = [dir];
      while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name.endsWith('.md')) collected.push(full);
        }
      }
    } catch {}
    if (collected.length > 0) {
      collected.sort();
      const blocks = collected.map(f => readOptional(f)).filter(Boolean);
      if (blocks.length > 0) {
        parts.push([`# Agent ${subdirForRole}`, '', blocks.join('\n\n')].join('\n'));
      }
    }
  }

  return parts.join('\n\n');
}

module.exports = {
  buildInjectionContent,
  buildBridgeInjectionContent,
  buildBridgeRoleSpecificContent,
};
