#!/usr/bin/env node
/**
 * skill-suggest.mjs — Detect repeated patterns from memory trajectory
 * and generate skill .md drafts.
 *
 * Scans the classifications table for recurring topic/classification
 * clusters that suggest a reusable skill. When a cluster exceeds the
 * frequency threshold, produces a skill .md file with frontmatter and
 * a scaffold body.
 *
 * Usage:
 *   node scripts/skill-suggest.mjs                   # classifications-based suggestions
 *   node scripts/skill-suggest.mjs --write           # write .md files to ~/.claude/skills/
 *   node scripts/skill-suggest.mjs --min-freq 5      # custom frequency threshold
 *   node scripts/skill-suggest.mjs --days 14         # look-back window in days
 *   node scripts/skill-suggest.mjs --3axis           # WHAT/HOW/FLOW extraction from trajectory.sqlite
 *   node scripts/skill-suggest.mjs --promote-drafts  # promote auto-drafts/ to auto/ when thresholds met
 *
 * Also exports detectPatterns() and generateSkillMd() for programmatic use.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractPatterns3Axis, get3AxisReport, promoteQualifyingDrafts, getSkillCatalog } from '../src/agent/orchestrator/skill-suggest.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = join(__dirname, '..');

// ── Resolve data directory ──────────────────────────────────────────

function resolveDataDir() {
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  return join(homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin');
}

// ── Parse CLI args ──────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { write: false, minFreq: 3, days: 30, threeAxis: false, promoteDrafts: false, minConsistency: 'M' };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--write') args.write = true;
    if (argv[i] === '--min-freq' && argv[i + 1]) args.minFreq = Number(argv[++i]);
    if (argv[i] === '--days' && argv[i + 1]) args.days = Number(argv[++i]);
    if (argv[i] === '--3axis') args.threeAxis = true;
    if (argv[i] === '--promote-drafts') args.promoteDrafts = true;
    if (argv[i] === '--min-consistency' && argv[i + 1]) args.minConsistency = argv[++i];
  }
  return args;
}

function openTrajectoryDb() {
  const dbPath = join(resolveDataDir(), 'trajectory.sqlite');
  if (!existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch {
    return null;
  }
}

// ── Pattern detection ───────────────────────────────────────────────

/**
 * Detect recurring patterns from classification history.
 *
 * Groups classifications by (classification, topic) and counts
 * occurrences within the look-back window. Clusters that appear
 * at least `minFreq` times are returned as pattern candidates.
 *
 * @param {object} opts
 * @param {string} opts.dbPath   - path to memory.sqlite
 * @param {number} opts.minFreq  - minimum occurrences to qualify (default 3)
 * @param {number} opts.days     - look-back window in days (default 30)
 * @returns {Array<{classification: string, topic: string, count: number, elements: string[], firstSeen: string, lastSeen: string}>}
 */
export function detectPatterns({ dbPath, minFreq = 3, days = 30 } = {}) {
  const resolvedDb = dbPath || join(resolveDataDir(), 'memory.sqlite');
  if (!existsSync(resolvedDb)) return [];

  const db = new DatabaseSync(resolvedDb, { open: true, readOnly: true });
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  try {
    // Stage 1: find topic clusters exceeding threshold.
    // Classification column may be a placeholder ('-') so group primarily by topic.
    const clusters = db.prepare(`
      SELECT topic, COUNT(*) AS cnt,
             MIN(day_key) AS first_seen, MAX(day_key) AS last_seen
      FROM classifications
      WHERE status = 'active'
        AND day_key >= ?
        AND topic != ''
        AND LENGTH(topic) >= 3
      GROUP BY topic
      HAVING COUNT(*) >= ?
      ORDER BY cnt DESC
      LIMIT 50
    `).all(cutoff, minFreq);

    // Stage 2: collect representative elements for each cluster
    const results = [];
    for (const c of clusters) {
      const elements = db.prepare(`
        SELECT DISTINCT element FROM classifications
        WHERE topic = ? AND status = 'active' AND day_key >= ?
        ORDER BY ts DESC
        LIMIT 10
      `).all(c.topic, cutoff).map(r => r.element);

      // Stage 3: filter noise — skip if all elements are short noise or identical to topic
      const meaningful = elements.filter(e => e.length >= 10 && e !== c.topic);
      if (meaningful.length === 0) continue;

      // Stage 4: determine classification from the most common value in cluster
      const cls = db.prepare(`
        SELECT classification, COUNT(*) AS cnt FROM classifications
        WHERE topic = ? AND status = 'active' AND day_key >= ?
          AND classification NOT IN ('-', '', 'noise', 'skip')
        GROUP BY classification ORDER BY cnt DESC LIMIT 1
      `).all(c.topic, cutoff);
      const classification = cls.length > 0 ? cls[0].classification : 'pattern';

      // Stage 5: span check — require occurrences on at least 2 different days
      // unless frequency is very high (>=6 on a single day)
      const daySpan = db.prepare(`
        SELECT COUNT(DISTINCT day_key) AS days FROM classifications
        WHERE topic = ? AND status = 'active' AND day_key >= ?
      `).get(c.topic, cutoff);
      if (daySpan.days < 2 && c.cnt < 6) continue;

      results.push({
        classification,
        topic: c.topic,
        count: c.cnt,
        elements: meaningful,
        firstSeen: c.first_seen,
        lastSeen: c.last_seen,
      });
    }

    return results;
  } finally {
    db.close();
  }
}

// ── Skill name derivation ───────────────────────────────────────────

function deriveSkillName(pattern) {
  // Build a slug from topic: lowercase, replace spaces/special chars with hyphens
  const slug = pattern.topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return slug || `skill-${pattern.classification}`;
}

// ── Skill .md generation ────────────────────────────────────────────

/**
 * Generate a skill .md file from a detected pattern.
 *
 * @param {object} pattern - a single pattern from detectPatterns()
 * @returns {{ name: string, content: string }}
 */
export function generateSkillMd(pattern) {
  const name = deriveSkillName(pattern);
  const elementList = pattern.elements.map(e => `- ${e}`).join('\n');

  const content = `---
name: ${name}
description: Auto-suggested skill for repeated "${pattern.topic}" pattern (${pattern.classification}). Detected ${pattern.count} occurrences from ${pattern.firstSeen} to ${pattern.lastSeen}.
---

# ${capitalize(pattern.topic)}

This skill was suggested by trajectory pattern detection. The following
pattern was observed ${pattern.count} times in the last sessions:

**Classification:** ${pattern.classification}
**Topic:** ${pattern.topic}
**Frequency:** ${pattern.count} occurrences (${pattern.firstSeen} ~ ${pattern.lastSeen})

## Observed Elements

${elementList}

## When to Use

Use this skill when the task involves "${pattern.topic}" in the context of
"${pattern.classification}" operations.

## Steps

1. Identify the specific variant of the pattern from the user request.
2. Apply the established approach based on prior successful executions.
3. Verify the result matches the expected outcome.

## Notes

- This is a generated draft. Refine the steps and add concrete instructions
  based on actual workflow experience.
- Review the observed elements above and consolidate into reusable procedures.
`;

  return { name, content };
}

// ── Existing skill check ────────────────────────────────────────────

function getExistingSkillNames() {
  const names = new Set();
  const dirs = [
    join(homedir(), '.claude', 'skills'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir, { recursive: true })) {
        if (!String(f).endsWith('.md')) continue;
        const content = readFileSync(join(dir, String(f)), 'utf8');
        const match = content.match(/^---\n[\s\S]*?^name:\s*(.+?)\s*$/m);
        if (match) names.add(match[1].replace(/['"]/g, '').trim());
      }
    } catch { /* ignore */ }
  }
  return names;
}

// ── Main ────────────────────────────────────────────────────────────

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Run full suggestion pipeline: detect patterns, filter existing skills,
 * generate .md drafts.
 *
 * @param {object} opts
 * @param {number} opts.minFreq
 * @param {number} opts.days
 * @param {boolean} opts.write - write files to ~/.claude/skills/
 * @returns {{ patterns: Array, suggestions: Array<{name: string, content: string, written?: boolean}> }}
 */
export function suggest({ minFreq = 3, days = 30, write = false } = {}) {
  const patterns = detectPatterns({ minFreq, days });
  if (patterns.length === 0) return { patterns: [], suggestions: [] };

  const existing = getExistingSkillNames();
  const suggestions = [];

  for (const p of patterns) {
    const skill = generateSkillMd(p);
    if (existing.has(skill.name)) continue;

    if (write) {
      const skillsDir = join(homedir(), '.claude', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      const outPath = join(skillsDir, `${skill.name}.md`);
      if (!existsSync(outPath)) {
        writeFileSync(outPath, skill.content, 'utf8');
        skill.written = true;
        skill.path = outPath;
      } else {
        skill.written = false;
        skill.path = outPath;
      }
    }
    suggestions.push(skill);
  }

  return { patterns, suggestions };
}

// ── CLI entry ───────────────────────────────────────────────────────

if (basename(process.argv[1] || '') === 'skill-suggest.mjs') {
  const args = parseArgs(process.argv);

  // --promote-drafts: scan auto-drafts/ and promote qualifying ones
  if (args.promoteDrafts) {
    const tdb = openTrajectoryDb();
    if (!tdb) {
      console.log('trajectory.sqlite not found — nothing to promote.');
      process.exit(0);
    }
    const results = promoteQualifyingDrafts(tdb, { minFreq: args.minFreq, minConsistency: args.minConsistency });
    tdb.close();
    if (results.length === 0) {
      console.log('No drafts present in ~/.claude/skills/auto-drafts/.');
    } else {
      console.log(`Draft promotion results (minFreq=${args.minFreq}, minConsistency=${args.minConsistency}):`);
      for (const r of results) {
        const mark = r.promoted ? '✓' : '·';
        console.log(`  ${mark} ${r.name}: ${r.reason}`);
      }
    }
    process.exit(0);
  }

  // --3axis: WHAT/HOW/FLOW extraction from trajectory.sqlite
  if (args.threeAxis) {
    const tdb = openTrajectoryDb();
    if (!tdb) {
      console.log('trajectory.sqlite not found. No trajectory data to analyze.');
      process.exit(0);
    }
    const report = get3AxisReport(tdb, { minFreq: args.minFreq });
    tdb.close();
    console.log(report);
    const catalog = getSkillCatalog(join(dirname(fileURLToPath(import.meta.url)), '..'));
    const totalCatalog = catalog.bundled.length + catalog.auto.length + catalog.drafts.length;
    if (totalCatalog > 0) {
      console.log(`\nSkill catalog: ${catalog.bundled.length} bundled, ${catalog.auto.length} auto, ${catalog.drafts.length} drafts.`);
    }
    process.exit(0);
  }

  // Default path: classifications-based suggestions
  const result = suggest(args);

  if (result.patterns.length === 0) {
    console.log('No recurring patterns found.');
    process.exit(0);
  }

  console.log(`Found ${result.patterns.length} pattern(s):\n`);
  for (const p of result.patterns) {
    console.log(`  [${p.count}x] ${p.classification} / ${p.topic}`);
    console.log(`       ${p.firstSeen} ~ ${p.lastSeen}`);
    console.log(`       elements: ${p.elements.slice(0, 3).join(', ')}${p.elements.length > 3 ? ' ...' : ''}`);
    console.log();
  }

  if (result.suggestions.length > 0) {
    console.log(`\n${result.suggestions.length} skill suggestion(s):\n`);
    for (const s of result.suggestions) {
      if (s.written) {
        console.log(`  + ${s.name} -> ${s.path}`);
      } else if (s.path) {
        console.log(`  = ${s.name} (already exists at ${s.path})`);
      } else {
        console.log(`  ? ${s.name}`);
        console.log(s.content.split('\n').map(l => `    ${l}`).join('\n'));
      }
    }
  } else if (result.patterns.length > 0) {
    console.log('All detected patterns already have matching skills.');
  }
}
