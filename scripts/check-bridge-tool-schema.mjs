#!/usr/bin/env bun
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { initProviders } from '../src/agent/orchestrator/providers/registry.mjs';
import { createSession, closeSession } from '../src/agent/orchestrator/session/manager.mjs';
import { setInternalToolsProvider, addInternalTools } from '../src/agent/orchestrator/internal-tools.mjs';
import { TOOL_DEFS } from '../src/agent/index.mjs';
import { SYNTHETIC_TOOL_DEFS } from '../src/agent/orchestrator/synthetic-tools.mjs';

function sortedNames(session) {
  return [...new Set((session.tools || []).map((t) => t?.name).filter(Boolean))].sort();
}

function diff(left, right) {
  const r = new Set(right);
  return left.filter((name) => !r.has(name));
}

async function main() {
  const cwd = fileURLToPath(new URL('..', import.meta.url));

  let failed = false;

  await initProviders({
    openai: { enabled: true, apiKey: 'schema-check-only' },
  });

  const toolsJson = JSON.parse(readFileSync(new URL('../tools.json', import.meta.url), 'utf8'));
  setInternalToolsProvider({
    executor: async () => ({ content: [{ type: 'text', text: 'schema-check-only' }] }),
    tools: [...toolsJson, ...TOOL_DEFS],
  });
  addInternalTools(SYNTHETIC_TOOL_DEFS.map((def) => ({
    def,
    executor: async () => ({ content: [{ type: 'text', text: 'schema-check-only' }] }),
  })));

  const preset = { name: 'SCHEMA CHECK', provider: 'openai', model: 'gpt-5.5', tools: 'full' };
  const poolB = createSession({ owner: 'bridge', role: 'worker', preset, cwd });
  const poolC = createSession({ owner: 'bridge', role: 'explorer', preset, permission: 'read', skipRoleReminder: true, cwd });

  try {
    const bNames = sortedNames(poolB);
    const cNames = sortedNames(poolC);
    const missingInC = diff(bNames, cNames);
    const missingInB = diff(cNames, bNames);
    const bDefs = Object.fromEntries((poolB.tools || []).map((tool) => [tool.name, JSON.stringify(tool)]));
    const cDefs = Object.fromEntries((poolC.tools || []).map((tool) => [tool.name, JSON.stringify(tool)]));
    const definitionMismatches = bNames.filter((name) => bDefs[name] !== cDefs[name]);
    const forbidden = ['bridge_send', 'bridge_spawn'];

    console.log('Pool B(role=worker) final tool manifest:');
    console.log(JSON.stringify(bNames, null, 2));
    console.log('Pool C(role=explorer) final tool manifest:');
    console.log(JSON.stringify(cNames, null, 2));
    const sameSet = missingInB.length === 0 && missingInC.length === 0;
    const sameDefs = definitionMismatches.length === 0;
    if (!sameSet) failed = true;
    if (!sameDefs) failed = true;
    console.log(`same set (order-insensitive): ${sameSet}`);
    console.log(`same definitions: ${sameDefs}`);
    console.log(`definition mismatches: ${JSON.stringify(definitionMismatches)}`);
    console.log(`missing in Pool B: ${JSON.stringify(missingInB)}`);
    console.log(`missing in Pool C: ${JSON.stringify(missingInC)}`);
    for (const name of forbidden) {
      const included = bNames.includes(name) || cNames.includes(name);
      if (included) failed = true;
      console.log(`${name} included: ${included}`);
    }

    const required = [
      'read', 'edit', 'write',
      'bash', 'bash_session', 'job_wait',
      'grep', 'glob', 'list', 'apply_patch', 'code_graph', 'find_symbol',
      'explore', 'memory_search', 'recall', 'search', 'web_search',
      'skills_list', 'skill_view', 'skill_execute',
    ];
    const bSet = new Set(bNames);
    const cSet = new Set(cNames);
    const requiredMissingB = required.filter((name) => !bSet.has(name));
    const requiredMissingC = required.filter((name) => !cSet.has(name));
    if (requiredMissingB.length > 0) failed = true;
    if (requiredMissingC.length > 0) failed = true;
    console.log(`required missing in Pool B: ${JSON.stringify(requiredMissingB)}`);
    console.log(`required missing in Pool C: ${JSON.stringify(requiredMissingC)}`);
    const leadOnly = ['get_workflow', 'get_workflows', 'set_prompt'];
    const leadOnlyIncluded = leadOnly.filter((name) => bSet.has(name) || cSet.has(name));
    if (leadOnlyIncluded.length > 0) failed = true;
    console.log(`lead-only helper tools included: ${JSON.stringify(leadOnlyIncluded)}`);

    // Validate bridge tool inputSchema oneOf/anyOf prompt/ref/file structure.
    const allTools = [...(poolB.tools || [])];
    const schemaIssues = [];
    for (const tool of allTools) {
      const schema = tool?.inputSchema;
      if (!schema) continue;
      const oneOfFields = schema.oneOf || schema.anyOf;
      if (oneOfFields) {
        for (const branch of oneOfFields) {
          const props = branch?.properties || {};
          const hasPromptLike = 'prompt' in props || 'ref' in props || 'file' in props;
          if (!hasPromptLike) {
            schemaIssues.push(`${tool.name}: oneOf/anyOf branch missing prompt/ref/file property`);
          }
        }
      }
      for (const field of ['prompt', 'ref', 'file']) {
        if (schema.properties?.[field] && !schema.properties[field].type && !schema.properties[field].anyOf && !schema.properties[field].oneOf) {
          schemaIssues.push(`${tool.name}: property "${field}" lacks type/anyOf/oneOf`);
        }
      }
    }
    if (schemaIssues.length > 0) failed = true;
    console.log(`inputSchema oneOf prompt/ref/file issues: ${JSON.stringify(schemaIssues)}`);
  } finally {
    closeSession(poolB.id);
    closeSession(poolC.id);
  }

  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
