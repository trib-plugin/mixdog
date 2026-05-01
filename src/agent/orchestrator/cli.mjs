#!/usr/bin/env bun
/**
 * Orchestrator CLI — slash command entry point.
 *
 * Subcommands:
 *   bridge [--provider X] [--model Y] [--preset Z] [--role R] [--context "text"] [:sessionId] <prompt>
 *   new [prompt]
 *   resume [sessionId]
 *   clear
 *   model [name|index]
 *   sessions
 *
 * Active session pointer: pluginData/active-session.txt
 */
import { initProviders, getAllProviders, getProvider } from './providers/registry.mjs';
import { loadConfig, listPresets, getPreset, getDefaultPreset, setDefaultPreset, getPluginData, resolveRuntimeSpec } from './config.mjs';
import { connectMcpServers } from './mcp/client.mjs';
import {
    createSession,
    askSession,
    resumeSession,
    listSessions,
    closeSession,
    clearSessionMessages,
    findSessionByScopeKey,
} from './session/manager.mjs';
import { createJob, completeJob } from './jobs.mjs';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';

// --- Active session pointer ---

function getActivePath() {
    const dir = getPluginData();
    return join(dir, 'active-session.txt');
}

function readActiveSession() {
    try {
        return readFileSync(getActivePath(), 'utf-8').trim() || null;
    } catch {
        return null;
    }
}

function writeActiveSession(id) {
    const path = getActivePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id, 'utf-8');
}

function clearActiveSession() {
    try { unlinkSync(getActivePath()); } catch {}
}

// --- Token formatting (Claude Code style) ---

function fmtTokens(n) {
    if (typeof n !== 'number') return String(n ?? '?');
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(1)}k`;
}

// --- MCP setup (shared by bridge) ---

async function ensureMcpConnected(config) {
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
        await connectMcpServers(config.mcpServers);
    }
}

// --- Subcommands ---

async function cmdBridge(args) {
    // Parse flags: [--bg] [--lane X] [--scope Y] [--provider X] [--model Y]
    //              [--preset Z] [--role R] [--context "text"] [:sessionId] <prompt>
    let isBackground = false;
    let lane = null, scope = null;
    let provider = null, model = null, presetName = null, role = null;
    let context = null, explicitSession = null;
    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--bg' || a === '--background') { isBackground = true; continue; }
        if (a === '--lane' && args[i + 1]) { lane = args[++i]; continue; }
        if (a === '--scope' && args[i + 1]) { scope = args[++i]; continue; }
        if (a === '--provider' && args[i + 1]) { provider = args[++i]; continue; }
        if (a === '--model' && args[i + 1]) { model = args[++i]; continue; }
        if (a === '--preset' && args[i + 1]) { presetName = args[++i]; continue; }
        if (a === '--role') {
            const val = args[i + 1];
            if (!val || val.startsWith('--')) { process.stderr.write('--role requires a value\n'); process.exit(1); }
            role = args[++i]; continue;
        }
        if (a === '--context' && args[i + 1]) { context = args[++i]; continue; }
        if (!explicitSession && a.startsWith(':')) { explicitSession = a.slice(1); continue; }
        positional.push(a);
    }

    let prompt = positional.join(' ').trim();
    if (!prompt && !process.stdin.isTTY) {
        // Read from stdin when no CLI argument provided
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        prompt = Buffer.concat(chunks).toString('utf8').trim();
    }
    if (!prompt) {
        process.stderr.write('Usage: bridge [--provider X --model Y] [--preset Z] [--role R] [--context "text"] [:sessionId] <prompt>\n');
        process.exit(1);
    }

    const config = loadConfig();
    await initProviders(config.providers);

    // Background spawn (detach + return jobId)
    if (isBackground) {
        const jobId = createJob(explicitSession || readActiveSession() || '', prompt, context, { lane, scopeKey: scope });
        const childArgs = ['bridge'];
        if (lane) childArgs.push('--lane', lane);
        if (scope) childArgs.push('--scope', scope);
        if (provider) childArgs.push('--provider', provider);
        if (model) childArgs.push('--model', model);
        if (presetName) childArgs.push('--preset', presetName);
        if (role) childArgs.push('--role', role);
        if (context) childArgs.push('--context', context);
        if (explicitSession) childArgs.push(`:${explicitSession}`);
        childArgs.push(prompt);
        const child = spawn(process.execPath, [process.argv[1], ...childArgs], {
            cwd: process.cwd(),
            env: { ...process.env, ORCHESTRATOR_JOB_ID: jobId },
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
        process.stdout.write(`Background job started: ${jobId}\n`);
        process.exit(0);
    }

    // === Lane-based session resolution ===
    let session = null;

    // Explicit session ID always wins (backwards compat)
    if (explicitSession) {
        session = resumeSession(explicitSession);
        if (session) await ensureMcpConnected(config);
    }

    if (!session) {
        // Resolve preset object
        let preset = null;
        if (presetName) {
            preset = config.presets.find(x => x.id === presetName || x.name === presetName);
            if (!preset) {
                process.stderr.write(`preset "${presetName}" not found.\n`);
                process.exit(1);
            }
        } else if (provider || model) {
            let resolvedProvider = provider;
            let resolvedModel = model;
            if (!resolvedProvider || !resolvedModel) {
                const def = getDefaultPreset(config);
                if (def) { resolvedProvider = resolvedProvider || def.provider; resolvedModel = resolvedModel || def.model; }
            }
            if (!resolvedProvider || !resolvedModel) {
                process.stderr.write('provider and model required.\n');
                process.exit(1);
            }
            preset = { name: `${resolvedProvider}/${resolvedModel}`, provider: resolvedProvider, model: resolvedModel, type: 'bridge', tools: 'full' };
        } else {
            // No --preset/--provider/--model: try active session (bridge command without --scope), then default preset
            if (!scope && (!lane || lane === 'bridge')) {
                const activeId = readActiveSession();
                if (activeId) session = resumeSession(activeId);
            }
            if (!session) {
                preset = getDefaultPreset(config);
                if (!preset) {
                    process.stderr.write('No active session and no default preset configured.\n');
                    process.stderr.write('Run /mixdog:config to create a preset, then /mixdog:new.\n');
                    process.exit(1);
                }
            }
        }

        if (!session && preset) {
            await ensureMcpConnected(config);

            // Determine effective lane: bridge for scoped runs, reusable bridge session otherwise
            const effectiveLane = scope ? 'bridge' : (lane || 'bridge');
            const runtimeSpec = scope
                ? resolveRuntimeSpec(preset, {
                    lane: effectiveLane,
                    agentId: scope,
                })
                : {
                    lane: effectiveLane,
                    scopeKey: `bridge:${preset.name || preset.id}`,
                    reuse: true,
                    preset,
                };

            // Find existing session by scopeKey
            const existing = findSessionByScopeKey(runtimeSpec.scopeKey);
            if (existing) session = resumeSession(existing.id);

            if (!session) {
                session = createSession({
                    preset,
                    agent: role,
                    // Pass `role` so the session manager's smart bridge resolve
                    // fires and the session picks up providerCacheOpts (tier3
                    // 1h BP, registry tracking). Without it `opts.role` was
                    // undefined here — CLI bridge runs silently skipped the
                    // tier3 cache layer even though they carried a role flag.
                    role: role || undefined,
                    owner: scope ? 'bridge' : 'user',
                    scopeKey: runtimeSpec.scopeKey,
                    lane: runtimeSpec.lane,
                    cwd: process.cwd(),
                });
            }

            // Only update active pointer for bridge runs without --scope
            if (!scope) {
                writeActiveSession(session.id);
            }
        } else if (session) {
            await ensureMcpConnected(config);
        }
    }

    try {
        const t0 = Date.now();
        const result = await askSession(session.id, prompt, context, (iteration, calls) => {
            const names = calls.map(c => c.name).join(', ');
            process.stderr.write(`  tool #${iteration}: ${names}\n`);
        }, process.cwd());
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const inTok = fmtTokens(result.usage?.inputTokens);
        const outTok = fmtTokens(result.usage?.outputTokens);
        const loopNote = result.iterations > 1
            ? ` · ${result.iterations} loops, ${result.toolCallsTotal} calls` : '';
        const content = result.content || '';
        const output = `${content}\n\n\`${session.model} · ${inTok} in · ${outTok} out · ${elapsed}s${loopNote}\`\n`;
        process.stdout.write(output);
        const jobId = process.env.ORCHESTRATOR_JOB_ID;
        if (jobId) completeJob(jobId, content);
        process.exit(0);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const output = `**FAILED** ${msg}\n\n\`${session.model}\`\n`;
        process.stdout.write(output);
        const jobId = process.env.ORCHESTRATOR_JOB_ID;
        if (jobId) completeJob(jobId, `**FAILED** ${msg}`, true);
        process.exit(1);
    }
}

async function cmdNew(args) {
    const config = loadConfig();
    const preset = getDefaultPreset(config);
    if (!preset) {
        process.stderr.write('No default preset configured. Run /mixdog:config first.\n');
        process.exit(1);
    }
    await initProviders(config.providers);
    await ensureMcpConnected(config);
    const session = createSession({ preset, cwd: process.cwd() });
    writeActiveSession(session.id);

    const initialPrompt = args.join(' ').trim();
    if (initialPrompt) {
        // Forward to bridge flow inline
        await cmdBridge([initialPrompt]);
        return;
    }
    process.stdout.write(
        `New session created: ${session.id}\n` +
        `  preset: ${preset.name}\n` +
        `  model: ${session.provider}/${session.model}\n` +
        `  tools: ${session.tools.length}\n`
    );
    process.exit(0);
}

function cmdResume(args) {
    const sessions = listSessions();
    if (!args.length) {
        // Print list
        if (!sessions.length) {
            process.stdout.write('No sessions.\n');
            process.exit(0);
        }
        const active = readActiveSession();
        const lines = sessions.map((s, i) => {
            const mark = s.id === active ? '← active' : '';
            const updated = new Date(s.updatedAt).toLocaleString('sv-SE');
            const msgCount = Array.isArray(s.messages) ? s.messages.length : 0;
            return `[${i}] ${s.id}  ${s.provider}/${s.model}  msgs=${msgCount}  ${updated}  ${mark}`;
        });
        process.stdout.write(lines.join('\n') + '\n');
        process.stdout.write('\nUsage: /mixdog:resume <sessionId>\n');
        process.exit(0);
    }
    const target = args[0];
    // Numeric → index
    let session;
    if (/^\d+$/.test(target)) {
        session = sessions[Number(target)];
    } else {
        session = sessions.find(s => s.id === target || s.id.endsWith(target));
    }
    if (!session) {
        process.stderr.write(`Session "${target}" not found.\n`);
        process.exit(1);
    }
    writeActiveSession(session.id);
    process.stdout.write(`Active session: ${session.id} (${session.provider}/${session.model})\n`);
    process.exit(0);
}

function cmdClear() {
    const id = readActiveSession();
    if (!id) {
        process.stdout.write('No active session.\n');
        process.exit(0);
    }
    const ok = clearSessionMessages(id);
    if (!ok) {
        process.stderr.write(`Session ${id} not found. Clearing pointer.\n`);
        clearActiveSession();
        process.exit(1);
    }
    process.stdout.write(`Cleared messages of session ${id}.\n`);
    process.exit(0);
}

function cmdModel(args) {
    const config = loadConfig();
    const presets = listPresets(config);
    const def = getDefaultPreset(config);

    if (!args.length) {
        if (!presets.length) {
            process.stdout.write('No presets configured. Run /mixdog:config to add one.\n');
            process.exit(0);
        }
        const lines = presets.map((p, i) => {
            const isDef = def && p.name === def.name;
            const parts = [p.model];
            if (p.effort) parts.push(p.effort);
            if (p.fast) parts.push('fast');
            const meta = parts.join(' · ');
            const mark = isDef ? '  ← active' : '';
            return `[${i}] ${meta}${mark}`;
        });
        const head = def ? `Current: [${presets.indexOf(def)}] ${def.model}${def.effort ? ' · ' + def.effort : ''}${def.fast ? ' · fast' : ''}\n\n` : '';
        process.stdout.write(head + lines.join('\n') + '\n');
        process.exit(0);
    }

    // Switch default
    const target = args[0];
    let preset;
    if (/^\d+$/.test(target)) {
        preset = presets[Number(target)];
    } else {
        preset = presets.find(p => p.name === target);
    }
    if (!preset) {
        process.stderr.write(`Preset "${target}" not found.\n`);
        process.exit(1);
    }
    setDefaultPreset(config, preset.name);
    process.stdout.write(`Default preset: ${preset.name} (${preset.model})\n`);
    process.exit(0);
}

function cmdSessions() {
    const sessions = listSessions();
    if (!sessions.length) {
        process.stdout.write('No sessions.\n');
        process.exit(0);
    }
    const active = readActiveSession();
    const lines = sessions.map((s, i) => {
        const mark = s.id === active ? '  ← active' : '';
        const updated = new Date(s.updatedAt).toLocaleString('sv-SE');
        const msgCount = Array.isArray(s.messages) ? s.messages.length : 0;
        return `[${i}] ${s.id}  ${s.provider}/${s.model}  msgs=${msgCount}  ${fmtTokens(s.totalInputTokens || 0)} in / ${fmtTokens(s.totalOutputTokens || 0)} out  ${updated}${mark}`;
    });
    process.stdout.write(lines.join('\n') + '\n');
    process.exit(0);
}

// --- Main dispatcher ---

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const rest = args.slice(1);

    switch (command) {
        case 'bridge':    await cmdBridge(rest); break;
        case 'new':       await cmdNew(rest); break;
        case 'resume':    cmdResume(rest); break;
        case 'clear':     cmdClear(); break;
        case 'model':     cmdModel(rest); break;
        case 'sessions':  cmdSessions(); break;
        default:
            process.stderr.write(
                'Usage:\n' +
                '  cli.js bridge [--provider X --model Y] [--preset Z] [--role R] [--context "text"] [:sessionId] <prompt>\n' +
                '  cli.js new [prompt]\n' +
                '  cli.js resume [sessionId]\n' +
                '  cli.js clear\n' +
                '  cli.js model [name|index]\n' +
                '  cli.js sessions\n'
            );
            process.exit(1);
    }
}

main().catch((err) => {
    process.stderr.write(`Error: ${err?.message || err}\n`);
    process.exit(1);
});
