/**
 * Skill suggestion engine.
 *
 * Analyzes trajectory patterns to detect repeating successful workflows,
 * then generates skill .md files for human approval.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const AUTO_SKILLS_DIR = join(homedir(), '.claude', 'skills', 'auto');
const AUTO_DRAFTS_DIR = join(homedir(), '.claude', 'skills', 'auto-drafts');
const USER_SKILLS_DIR = join(homedir(), '.claude', 'skills');

/**
 * Query trajectory DB for completed entries and group by scope.
 * Returns an array of pattern summaries.
 * @param {object|null} trajectoryDb - SQLite DatabaseSync instance
 * @returns {Array<{scope: string, totalCalls: number, avgDuration: number, avgTokensIn: number, avgTokensOut: number, successRate: number, topToolChains: string[], samplePrompts: string[]}>}
 */
export function detectPatterns(trajectoryDb) {
  if (!trajectoryDb) return [];

  try {
    const rows = trajectoryDb.prepare(`
      SELECT scope,
             COUNT(*)                          AS totalCalls,
             ROUND(AVG(duration_ms))           AS avgDuration,
             ROUND(AVG(tokens_in))             AS avgTokensIn,
             ROUND(AVG(tokens_out))            AS avgTokensOut,
             ROUND(COUNT(CASE WHEN completed = 1 THEN 1 END) * 100.0 / COUNT(*)) AS successRate
      FROM trajectories
      GROUP BY scope
      ORDER BY totalCalls DESC
    `).all();

    return rows.map((row) => {
      // Extract top tool chains from tool_calls_json
      let topToolChains = [];
      let samplePrompts = [];
      try {
        const details = trajectoryDb.prepare(`
          SELECT tool_calls_json
          FROM trajectories
          WHERE completed = 1 AND scope = ?
          ORDER BY created_at DESC
          LIMIT 10
        `).all(row.scope);

        const chainCounts = {};
        for (const d of details) {
          if (!d.tool_calls_json) continue;
          try {
            const tools = JSON.parse(d.tool_calls_json);
            const chain = (Array.isArray(tools) ? tools.map((t) => t.name || t).join(' -> ') : String(tools));
            chainCounts[chain] = (chainCounts[chain] || 0) + 1;
          } catch { /* skip malformed json */ }
        }
        topToolChains = Object.entries(chainCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([chain]) => chain);
      } catch { /* query failed, leave empty */ }

      return {
        scope: row.scope,
        totalCalls: row.totalCalls,
        avgDuration: row.avgDuration || 0,
        avgTokensIn: row.avgTokensIn || 0,
        avgTokensOut: row.avgTokensOut || 0,
        successRate: row.successRate || 0,
        topToolChains,
        samplePrompts,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Use an LLM to generate a SKILL.md from a detected pattern.
 *
 * @param {{scope: string, totalCalls: number, avgDuration: number, topToolChains: string[], samplePrompts: string[]}} pattern
 * @param {(systemPrompt: string, userPrompt: string) => Promise<string>} llmCallFn
 * @returns {Promise<string>} Generated markdown content
 */
export async function suggestSkillFromPattern(pattern, llmCallFn) {
  const systemPrompt = 'You are a skill file generator for Claude Code. Generate concise, actionable skill definitions in markdown format.';

  const userPrompt = `Based on this recurring workflow pattern, generate a Claude Code skill file in markdown.

Pattern:
- Scope: ${pattern.scope}
- Used ${pattern.totalCalls} times successfully
- Average duration: ${pattern.avgDuration}ms
- Common tool chains: ${pattern.topToolChains.join(', ') || 'N/A'}

Generate a skill with this format:
---
name: auto-${pattern.scope}-workflow
description: [brief description based on the pattern]
version: 1.0.0
---
# [Skill Title]
## When to Use
[conditions]
## Procedure
[step by step]
## Verification
[how to confirm it worked]`;

  return await llmCallFn(systemPrompt, userPrompt);
}

/**
 * Save a generated skill file to ~/.claude/skills/auto/{name}/SKILL.md
 * @param {string} name - Skill directory name
 * @param {string} content - Markdown content
 * @returns {string} Absolute path to the saved file
 */
export function saveAutoSkill(name, content) {
  const dir = join(AUTO_SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'SKILL.md');
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * List existing auto-generated skills.
 * @returns {Array<{name: string, path: string, description: string}>}
 */
export function listAutoSkills() {
  if (!existsSync(AUTO_SKILLS_DIR)) return [];

  const results = [];
  let entries;
  try { entries = readdirSync(AUTO_SKILLS_DIR, { withFileTypes: true }); } catch { return results; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(AUTO_SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    let description = '';
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim();
    } catch { /* skip read errors */ }

    results.push({
      name: entry.name,
      path: skillPath,
      description,
    });
  }
  return results;
}

/**
 * Generate a human-readable report of skill candidates from trajectory data.
 * Scopes with 5+ successful calls are flagged as candidates.
 * @param {object|null} trajectoryDb - SQLite DatabaseSync instance
 * @returns {string} Formatted report
 */
export function getSkillSuggestionReport(trajectoryDb) {
  const patterns = detectPatterns(trajectoryDb);
  if (patterns.length === 0) {
    return 'No trajectory data available for analysis.';
  }

  const lines = ['Skill Candidates:'];
  let hasCandidates = false;

  for (const p of patterns) {
    const durationLabel = p.avgDuration >= 1000
      ? `${(p.avgDuration / 1000).toFixed(0)}s`
      : `${p.avgDuration}ms`;

    if (p.totalCalls >= 5) {
      hasCandidates = true;
      lines.push(`- ${p.scope}: ${p.totalCalls} calls, ${p.successRate}% success, avg ${durationLabel} -> candidate for auto-skill`);
    } else {
      lines.push(`- ${p.scope}: ${p.totalCalls} calls -> not enough data yet`);
    }
  }

  if (!hasCandidates) {
    lines.push('');
    lines.push('No scopes have reached the 5-call threshold yet.');
  }

  // Append existing auto-skills info
  const existing = listAutoSkills();
  if (existing.length > 0) {
    lines.push('');
    lines.push('Existing auto-skills:');
    for (const s of existing) {
      lines.push(`- ${s.name}: ${s.description || '(no description)'}`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// WHAT / HOW / FLOW 3-axis extraction (Zenn-style blueprint)
// ─────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'for', 'in', 'of', 'with', 'and', 'or', 'is', 'be', 'that', 'this']);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Extract scope + tool-chain + ordered session-scope sequences from the
 * trajectory database. Returns raw events ready for 3-axis aggregation.
 * @param {object} trajectoryDb
 * @returns {{events: Array<{session: string, scope: string, toolChain: string[], ts: string}>}}
 */
function readTrajectoryEvents(trajectoryDb) {
  if (!trajectoryDb) return { events: [] };
  try {
    const rows = trajectoryDb.prepare(`
      SELECT session_id, scope, tool_calls_json, ts
      FROM trajectories
      WHERE completed = 1 AND scope IS NOT NULL
      ORDER BY session_id, ts
    `).all();
    const events = rows.map((r) => {
      let toolChain = [];
      try {
        const parsed = JSON.parse(r.tool_calls_json || '[]');
        if (Array.isArray(parsed)) toolChain = parsed.map((x) => x?.name || x).filter(Boolean).map(String);
      } catch { /* skip malformed */ }
      return { session: r.session_id || 'no-session', scope: r.scope, toolChain, ts: r.ts };
    });
    return { events };
  } catch {
    return { events: [] };
  }
}

/**
 * Extract WHAT candidates: goal-level scope frequency across all trajectories.
 * @param {Array} events
 * @returns {Map<string, {count: number, sessions: Set<string>}>}
 */
function extractWhat(events) {
  const whatMap = new Map();
  for (const e of events) {
    const key = slugify(e.scope);
    if (!key) continue;
    if (!whatMap.has(key)) whatMap.set(key, { count: 0, sessions: new Set(), label: e.scope });
    const rec = whatMap.get(key);
    rec.count += 1;
    rec.sessions.add(e.session);
  }
  return whatMap;
}

/**
 * Extract HOW candidates: tool-chain n-grams (length 2-3) across trajectories.
 * Each chain is a sequence like ["Read", "Grep", "Edit"].
 * @param {Array} events
 * @returns {Map<string, {count: number, sessions: Set<string>, chain: string[]}>}
 */
function extractHow(events) {
  const howMap = new Map();
  for (const e of events) {
    if (e.toolChain.length < 2) continue;
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= e.toolChain.length; i++) {
        const gram = e.toolChain.slice(i, i + n);
        const key = gram.join('->');
        if (!howMap.has(key)) howMap.set(key, { count: 0, sessions: new Set(), chain: gram });
        const rec = howMap.get(key);
        rec.count += 1;
        rec.sessions.add(e.session);
      }
    }
  }
  return howMap;
}

/**
 * Extract FLOW candidates: ordered scope-sequences within each session
 * (length 2-4 n-grams). Each FLOW is a sequence like ["plan", "execute", "verify"].
 * @param {Array} events
 * @returns {Map<string, {count: number, sessions: Set<string>, scopes: string[]}>}
 */
function extractFlow(events) {
  const flowMap = new Map();
  const bySession = new Map();
  for (const e of events) {
    if (!bySession.has(e.session)) bySession.set(e.session, []);
    bySession.get(e.session).push(slugify(e.scope));
  }
  for (const [session, scopes] of bySession) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= scopes.length; i++) {
        const gram = scopes.slice(i, i + n);
        if (gram.some((s) => !s)) continue;
        const key = gram.join('->');
        if (!flowMap.has(key)) flowMap.set(key, { count: 0, sessions: new Set(), scopes: gram });
        const rec = flowMap.get(key);
        rec.count += 1;
        rec.sessions.add(session);
      }
    }
  }
  return flowMap;
}

/**
 * Apply FLOW-absorbs-nested counting: any WHAT/HOW item whose key appears
 * inside a detected FLOW's component scopes gets its count reduced by the
 * FLOW's count (floored at 0). Prevents double-counting.
 */
function applyFlowAbsorption(whatMap, howMap, flowMap, minFlowFreq) {
  const activeFlows = [...flowMap.values()].filter((f) => f.count >= minFlowFreq);
  for (const flow of activeFlows) {
    for (const scope of flow.scopes) {
      if (whatMap.has(scope)) {
        const rec = whatMap.get(scope);
        rec.count = Math.max(0, rec.count - flow.count);
      }
    }
    // HOW is not scope-nested, so we only absorb WHAT here.
  }
}

/**
 * Score a candidate: log(freq+1) × consistencyWeight × routineRatio.
 * - frequency: raw count
 * - consistency: H (sessions >= 3) = 1.0, M (2) = 0.6, L (1) = 0.3
 * - routineRatio: FLOW=1.0 (inherently sequence), HOW=0.8 (tool chain), WHAT=0.5 (goal only)
 */
function scoreCandidate(axis, record) {
  const sessions = record.sessions.size;
  const consistency = sessions >= 3 ? 1.0 : sessions === 2 ? 0.6 : 0.3;
  const routine = axis === 'FLOW' ? 1.0 : axis === 'HOW' ? 0.8 : 0.5;
  const score = Math.log(record.count + 1) * consistency * routine;
  return {
    score: Math.round(score * 100) / 100,
    frequency: record.count,
    consistency: sessions >= 3 ? 'H' : sessions === 2 ? 'M' : 'L',
    routine,
  };
}

function collectExistingSkillNames() {
  const names = new Set();
  const dirs = [USER_SKILLS_DIR, AUTO_SKILLS_DIR, AUTO_DRAFTS_DIR];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          names.add(entry.name);
          const skillPath = join(dir, entry.name, 'SKILL.md');
          if (existsSync(skillPath)) {
            try {
              const match = readFileSync(skillPath, 'utf8').match(/^name:\s*(.+)$/m);
              if (match) names.add(match[1].trim());
            } catch { /* skip */ }
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          names.add(entry.name.replace(/\.md$/, ''));
          try {
            const match = readFileSync(join(dir, entry.name), 'utf8').match(/^name:\s*(.+)$/m);
            if (match) names.add(match[1].trim());
          } catch { /* skip */ }
        }
      }
    } catch { /* skip dir */ }
  }
  return names;
}

/**
 * Main 3-axis extraction entry point.
 *
 * @param {object} trajectoryDb - SQLite handle
 * @param {object} opts
 * @param {number} opts.minFreq - minimum frequency per axis (default 3)
 * @returns {{what: Array, how: Array, flow: Array}}
 */
export function extractPatterns3Axis(trajectoryDb, { minFreq = 3 } = {}) {
  const { events } = readTrajectoryEvents(trajectoryDb);
  if (events.length === 0) return { what: [], how: [], flow: [] };

  const whatMap = extractWhat(events);
  const howMap = extractHow(events);
  const flowMap = extractFlow(events);

  applyFlowAbsorption(whatMap, howMap, flowMap, minFreq);

  const filter = (map, axis) => {
    const existing = collectExistingSkillNames();
    const out = [];
    for (const [key, rec] of map) {
      if (rec.count < minFreq) continue;
      if (existing.has(key)) continue;
      out.push({ axis, key, label: rec.label || key, chain: rec.chain, scopes: rec.scopes, ...scoreCandidate(axis, rec) });
    }
    return out.sort((a, b) => b.score - a.score);
  };

  return {
    what: filter(whatMap, 'WHAT'),
    how: filter(howMap, 'HOW'),
    flow: filter(flowMap, 'FLOW'),
  };
}

/**
 * Run 3-axis extraction and return a human-readable report.
 */
export function get3AxisReport(trajectoryDb, opts = {}) {
  const { what, how, flow } = extractPatterns3Axis(trajectoryDb, opts);
  const total = what.length + how.length + flow.length;
  if (total === 0) return 'No 3-axis pattern candidates (insufficient trajectory data or all already covered).';

  const lines = [`3-axis skill candidates (${total}):`];
  if (flow.length) {
    lines.push('', 'FLOW (ordered session sequences):');
    for (const c of flow.slice(0, 10)) lines.push(`  [${c.frequency}x ${c.consistency}] ${c.scopes.join(' -> ')} (score ${c.score})`);
  }
  if (how.length) {
    lines.push('', 'HOW (tool chains):');
    for (const c of how.slice(0, 10)) lines.push(`  [${c.frequency}x ${c.consistency}] ${c.chain.join(' -> ')} (score ${c.score})`);
  }
  if (what.length) {
    lines.push('', 'WHAT (goals, FLOW-absorbed):');
    for (const c of what.slice(0, 10)) lines.push(`  [${c.frequency}x ${c.consistency}] ${c.label} (score ${c.score})`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Quality check — basic SKILL.md validity
// ─────────────────────────────────────────────────────────────────────

const REQUIRED_FRONTMATTER_KEYS = ['name', 'description'];
const RECOMMENDED_SECTIONS = ['when to', 'procedure', 'step', 'verification'];

export function qualityCheck(skillMdContent) {
  const issues = [];
  const fmMatch = skillMdContent.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) {
    issues.push('missing frontmatter (--- ... ---)');
    return { ok: false, issues };
  }
  const fm = fmMatch[1];
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (!new RegExp(`^${key}:`, 'm').test(fm)) issues.push(`frontmatter missing "${key}"`);
  }
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  if (descMatch) {
    const desc = descMatch[1].trim();
    if (desc.length > 300) issues.push('description > 300 chars (trim for Progressive Disclosure efficiency)');
    if (desc.length < 20) issues.push('description < 20 chars (too vague to trigger reliably)');
  }
  const body = skillMdContent.slice(fmMatch[0].length).toLowerCase();
  const hasAnyRecommended = RECOMMENDED_SECTIONS.some((s) => body.includes(s));
  if (!hasAnyRecommended) issues.push(`body lacks recommended section (${RECOMMENDED_SECTIONS.join(' / ')})`);

  return { ok: issues.length === 0, issues };
}

// ─────────────────────────────────────────────────────────────────────
// 3-tier skill catalog + promotion path
// ─────────────────────────────────────────────────────────────────────

function listSkillsInDir(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    let description = '';
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const match = content.match(/^description:\s*(.+)$/m);
      if (match) description = match[1].trim();
    } catch { /* skip */ }
    out.push({ name: entry.name, path: skillPath, description });
  }
  return out;
}

/**
 * 3-tier catalog: bundled (plugin), auto (promoted), drafts (pending).
 * Bundled path is probed from common locations; missing tiers return [].
 */
export function getSkillCatalog(pluginRoot) {
  const candidates = [];
  if (pluginRoot) candidates.push(join(pluginRoot, 'skills'));
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot && envRoot !== pluginRoot) candidates.push(join(envRoot, 'skills'));
  const bundled = [];
  const seenBundled = new Set();
  for (const dir of candidates) {
    for (const s of listSkillsInDir(dir)) {
      if (seenBundled.has(s.name)) continue;
      seenBundled.add(s.name);
      bundled.push(s);
    }
  }
  return {
    bundled,
    auto: listSkillsInDir(AUTO_SKILLS_DIR),
    drafts: listSkillsInDir(AUTO_DRAFTS_DIR),
  };
}

/**
 * Promote a draft skill from auto-drafts/ to auto/.
 * Fails safely if source missing or target already exists.
 * @returns {{ok: boolean, from: string, to: string, error?: string}}
 */
export function promoteDraft(name) {
  const src = join(AUTO_DRAFTS_DIR, name);
  const dst = join(AUTO_SKILLS_DIR, name);
  if (!existsSync(src)) return { ok: false, from: src, to: dst, error: 'draft not found' };
  if (existsSync(dst)) return { ok: false, from: src, to: dst, error: 'already promoted' };
  try {
    mkdirSync(AUTO_SKILLS_DIR, { recursive: true });
    renameSync(src, dst);
    return { ok: true, from: src, to: dst };
  } catch (e) {
    return { ok: false, from: src, to: dst, error: e.message };
  }
}

/**
 * Scan auto-drafts, promote any whose name matches a 3-axis candidate
 * meeting the given frequency/consistency thresholds.
 *
 * @param {object} trajectoryDb
 * @param {object} opts
 * @param {number} opts.minFreq - default 5
 * @param {'H'|'M'|'L'} opts.minConsistency - default 'M'
 * @returns {Array<{name: string, promoted: boolean, reason?: string}>}
 */
export function promoteQualifyingDrafts(trajectoryDb, { minFreq = 5, minConsistency = 'M' } = {}) {
  const drafts = listSkillsInDir(AUTO_DRAFTS_DIR);
  if (drafts.length === 0) return [];
  const { what, how, flow } = extractPatterns3Axis(trajectoryDb, { minFreq: 1 });
  const all = new Map();
  for (const c of [...what, ...how, ...flow]) all.set(c.key, c);
  const levelRank = { H: 3, M: 2, L: 1 };
  const threshold = levelRank[minConsistency] || 2;
  const results = [];
  for (const d of drafts) {
    const candidate = all.get(d.name);
    if (!candidate) { results.push({ name: d.name, promoted: false, reason: 'no matching pattern in data' }); continue; }
    if (candidate.frequency < minFreq) { results.push({ name: d.name, promoted: false, reason: `frequency ${candidate.frequency} < ${minFreq}` }); continue; }
    if ((levelRank[candidate.consistency] || 0) < threshold) { results.push({ name: d.name, promoted: false, reason: `consistency ${candidate.consistency} below ${minConsistency}` }); continue; }
    const r = promoteDraft(d.name);
    results.push({ name: d.name, promoted: r.ok, reason: r.ok ? 'promoted' : r.error });
  }
  return results;
}
