#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync, utimesSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const RECALL_TARGET = 'LIVE_RECALL_TARGET=opal-memory-v1';
let runtime = null;
let syntheticToolsRegistered = false;

function readJsonIfExists(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function ensureLocalPluginEnv() {
    if (!process.env.CLAUDE_PLUGIN_ROOT) process.env.CLAUDE_PLUGIN_ROOT = REPO_ROOT;
    if (!process.env.CLAUDE_PLUGIN_DATA) {
        const plugin = readJsonIfExists(join(REPO_ROOT, '.claude-plugin', 'plugin.json'))?.name || 'mixdog';
        const marketplace = readJsonIfExists(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'))?.name || 'trib-plugin';
        process.env.CLAUDE_PLUGIN_DATA = resolvePluginDataCandidate(plugin, marketplace);
    }
}

function resolvePluginDataCandidate(plugin, marketplace) {
    const suffix = `${plugin}-${marketplace}`;
    const candidates = [];
    const add = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };
    const roots = [process.env.CLAUDE_PLUGIN_ROOT, REPO_ROOT].filter(Boolean).map((p) => resolve(p));
    for (const root of roots) {
        const parent = dirname(root);
        const grandparent = dirname(parent);
        if (basename(parent) === 'marketplaces') {
            add(join(grandparent, 'data', suffix));
        }
        if (basename(parent) === 'external_plugins' && basename(grandparent)) {
            add(join(dirname(grandparent), 'data', `${plugin}-${basename(grandparent)}`));
        }
        const m = root.match(/^\/mnt\/([a-z])\/Users\/([^/]+)\//i);
        if (m) add(`/mnt/${m[1]}/Users/${m[2]}/.claude/plugins/data/${suffix}`);
    }
    add(join(homedir(), '.claude', 'plugins', 'data', suffix));
    return candidates.find((p) => existsSync(p)) || candidates[0];
}

async function loadRuntime() {
    if (runtime) return runtime;
    ensureLocalPluginEnv();
    const agent = await import('../src/agent/index.mjs');
    runtime = {
        init: agent.init,
        stop: agent.stop,
        handleToolCall: agent.handleToolCall,
        TOOL_DEFS: agent.TOOL_DEFS,
    };
    return runtime;
}

function parseArgs(argv) {
    const out = {
        caseName: 'all',
        runs: 1,
        role: 'worker',
        preset: null,
        workspace: null,
        keepWorkspace: false,
        timeoutMs: 420000,
        parallel: false,
        json: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--case') out.caseName = next() || out.caseName;
        else if (a === '--runs') out.runs = Math.max(1, Number(next()) || 1);
        else if (a === '--role') out.role = next() || out.role;
        else if (a === '--preset') out.preset = next() || null;
        else if (a === '--workspace') out.workspace = resolve(next() || '.');
        else if (a === '--keep-workspace') out.keepWorkspace = true;
        else if (a === '--timeout-ms') out.timeoutMs = Math.max(1000, Number(next()) || out.timeoutMs);
        else if (a === '--parallel') out.parallel = true;
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') {
            printHelp();
            process.exit(0);
        }
    }
    return out;
}

function printHelp() {
    console.log([
        'Usage: node scripts/live-io-smoke.mjs [options]',
        '',
        'Runs real bridge worker smoke tests and sums worker iterations plus traced nested children.',
        '',
        'Options:',
        '  --role <name>              Bridge role to spawn. Default worker.',
        '  --preset <id|name>         Optional explicit preset passed to bridge.',
        '  --case <all|name[,name...]>  pagination,discovery,multi_read,glob_multi,list_recent,symbol_lookup,count_tail,tree_shape,grep_multi,grep_context,grep_count,list_find_size,list_find_mtime,code_graph_callers,read_bookends,read_offset_window,explore_fast_symbol,explore_fanout,recall_single,search_live_official,search_config_guard,explore.',
        '  --runs <n>                 Repeat each case. Default 1.',
        '  --parallel                 Run selected cases concurrently within each run.',
        '  --workspace <path>         Reuse/create a fixture workspace at path.',
        '  --keep-workspace           Do not delete temp workspace.',
        '  --timeout-ms <n>           Per-case timeout. Default 420000.',
        '  --json                     Print JSON only.',
    ].join('\n'));
}

function createFixture(workspace) {
    mkdirSync(workspace, { recursive: true });
    const dirs = {
        docs: join(workspace, 'docs'),
        src: join(workspace, 'src'),
        configs: join(workspace, 'configs'),
        releases: join(workspace, 'releases'),
        logs: join(workspace, 'logs'),
        artifacts: join(workspace, 'artifacts'),
    };
    dirs.nested = join(dirs.src, 'nested');
    dirs.checkout = join(dirs.src, 'checkout');
    dirs.routes = join(dirs.src, 'routes');
    dirs.policies = join(dirs.src, 'policies');
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

    writeFileSync(join(dirs.docs, 'paged.txt'), [
        'section 01: setup',
        'section 02: glossary',
        'section 03: ordinary context',
        'section 04: ordinary context',
        'section 05: ordinary context',
        'section 06: page boundary should expose next offset',
        'section 07: after boundary',
        'section 08: more context',
        'section 09: MARK_TARGET=aurora-next-offset',
        'section 10: stop here',
        'section 11: trailing context',
    ].join('\n'), 'utf8');

    for (let i = 0; i < 18; i++) {
        const dir = i % 3 === 0 ? dirs.nested : dirs.src;
        const extra = i === 13
            ? "\nexport function smokeNeedleTarget() { return 'IO_SMOKE_NEEDLE'; }\n"
            : '\nexport const ordinary = true;\n';
        writeFileSync(join(dir, `module-${String(i).padStart(2, '0')}.mjs`), [
            `import { helper } from './helper-${i}.mjs';`,
            `export const moduleId = ${i};`,
            extra,
        ].join('\n'), 'utf8');
    }

    writeFileSync(join(dirs.configs, 'service-a.json'), JSON.stringify({
        service: 'checkout-a',
        timeoutMs: 2400,
        retries: 2,
        featureFlag: 'IO_MULTI_READ_A',
    }, null, 2), 'utf8');
    writeFileSync(join(dirs.configs, 'service-b.json'), JSON.stringify({
        service: 'checkout-b',
        timeoutMs: 4100,
        retries: 4,
        featureFlag: 'IO_MULTI_READ_B',
    }, null, 2), 'utf8');

    writeFileSync(join(dirs.checkout, 'retry.mjs'), [
        'export async function retryFetch(url, options = {}) {',
        '    return { url, attempts: options.retries || 1, ok: true };',
        '}',
    ].join('\n'), 'utf8');
    writeFileSync(join(dirs.checkout, 'pipeline.mjs'), [
        "import { retryFetch } from './retry.mjs';",
        '',
        'export function buildCheckoutPipeline(cart) {',
        "    return retryFetch(`/checkout/${cart.id}`, { retries: 3, marker: 'SYMBOL_TARGET' });",
        '}',
        '',
        'export function buildRefundPipeline(refund) {',
        "    return retryFetch(`/refund/${refund.id}`, { retries: 1 });",
        '}',
    ].join('\n'), 'utf8');
    writeFileSync(join(dirs.src, 'app.mjs'), [
        "import { buildCheckoutPipeline } from './checkout/pipeline.mjs';",
        '',
        'export function runCheckoutSmoke(cart) {',
        "    return buildCheckoutPipeline({ ...cart, source: 'GRAPH_CALLER_TARGET' });",
        '}',
    ].join('\n'), 'utf8');
    writeFileSync(join(dirs.routes, 'order.route.mjs'), "export const routeMarker = 'ROUTE_TARGET_ORDER';\n", 'utf8');
    writeFileSync(join(dirs.routes, 'profile.route.mjs'), "export const routeMarker = 'ROUTE_TARGET_PROFILE';\n", 'utf8');
    writeFileSync(join(dirs.policies, 'refund.policy.json'), JSON.stringify({
        policy: 'refund',
        marker: 'POLICY_TARGET_REFUND',
    }, null, 2), 'utf8');

    const longLog = Array.from({ length: 120 }, (_, i) => {
        const line = i + 1;
        return line === 118 ? 'line 118: TAIL_TARGET=violet-tail' : `line ${String(line).padStart(3, '0')}: ordinary log row`;
    });
    writeFileSync(join(dirs.docs, 'long-log.txt'), longLog.join('\n'), 'utf8');
    writeFileSync(join(dirs.docs, 'bookends.txt'), [
        'BOOKEND_HEAD=coral-start',
        'ordinary middle 01',
        'ordinary middle 02',
        'ordinary middle 03',
        'BOOKEND_TAIL=indigo-finish',
    ].join('\n'), 'utf8');

    writeFileSync(join(dirs.logs, 'events.log'), [
        '2026-04-24T01:00:00Z INFO boot',
        '2026-04-24T01:01:00Z ERROR_PAYMENT_TIMEOUT order=41 marker=PAYMENT_TIMEOUT_TARGET',
        '2026-04-24T01:02:00Z WARN cache-warm',
        '2026-04-24T01:03:00Z ERROR_INVENTORY_MISS sku=blue marker=INVENTORY_MISS_TARGET',
        '2026-04-24T01:04:00Z INFO done',
    ].join('\n'), 'utf8');
    writeFileSync(join(dirs.logs, 'status.log'), [
        'status: ordinary',
        'STATUS_TARGET=amber',
        'owner: platform-live-smoke',
        'severity: medium',
    ].join('\n'), 'utf8');

    writeFileSync(join(dirs.artifacts, 'tiny-report.json'), JSON.stringify({
        marker: 'SMALL_ARTIFACT',
    }, null, 2), 'utf8');
    writeFileSync(join(dirs.artifacts, 'large-report.json'), JSON.stringify({
        marker: 'LARGE_ARTIFACT_TARGET',
        payload: 'x'.repeat(1800),
    }, null, 2), 'utf8');

    for (const [file, codename, ts] of [
        ['release-2026-04-20.json', 'atlas', '2026-04-20T10:00:00Z'],
        ['release-2026-04-23.json', 'zephyr', '2026-04-23T10:00:00Z'],
        ['release-2026-04-24.json', 'aurora', '2026-04-24T10:00:00Z'],
    ]) {
        const full = join(dirs.releases, file);
        writeFileSync(full, JSON.stringify({ codename, marker: `RELEASE_${codename.toUpperCase()}` }, null, 2), 'utf8');
        const t = new Date(ts);
        utimesSync(full, t, t);
    }
}

const CASES = {
    pagination: {
        expectAll: [/aurora-next-offset|MARK_TARGET/i],
        preferTools: ['read'],
        maxTotalIterations: 3,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Use `read` on `docs/paged.txt` with offset 0 and limit 6, follow the reported next offset once, find `MARK_TARGET`, and answer compact JSON.',
        ].join('\n'),
    },
    discovery: {
        expectAll: [/smokeNeedleTarget|IO_SMOKE_NEEDLE/i],
        preferTools: ['grep'],
        maxTotalIterations: 3,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Find the file under `src` that contains `IO_SMOKE_NEEDLE`, identify the exported function name, and answer compact JSON.',
        ].join('\n'),
    },
    multi_read: {
        expectAll: [/1700|timeout_delta|service-a|service-b|IO_MULTI_READ/i],
        preferTools: ['read'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Compare the already-known files `configs/service-a.json` and `configs/service-b.json`. Report timeout_delta_ms, retry_delta, and both featureFlag values as compact JSON.',
        ].join('\n'),
    },
    glob_multi: {
        expectAll: [/order\.route\.mjs|profile\.route\.mjs/i, /refund\.policy\.json/i],
        preferTools: ['glob'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [{ tool: 'glob', pattern: /policy/i }],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Locate both route modules and policy JSON files under `src` using filename patterns. Use one `glob` call whose pattern array includes both route patterns and policy patterns. Answer compact JSON with keys: case, routes, policies. Both categories are required.',
        ].join('\n'),
    },
    list_recent: {
        expectAll: [/release-2026-04-24\.json|aurora|RELEASE_AURORA/i],
        preferTools: ['list', 'read'],
        maxTotalIterations: 3,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Using directory metadata, identify the newest file under `releases`, then report its codename as compact JSON.',
        ].join('\n'),
    },
    symbol_lookup: {
        expectAll: [/buildCheckoutPipeline|pipeline\.mjs|SYMBOL_TARGET/i],
        preferTools: ['find_symbol'],
        maxTotalIterations: 3,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Find where exact symbol `buildCheckoutPipeline` is defined and identify the helper it calls. Answer compact JSON.',
        ].join('\n'),
    },
    count_tail: {
        expectAll: [/120/i, /TAIL_TARGET|violet-tail/i],
        preferTools: ['read'],
        maxTotalIterations: 3,
        noDuplicateToolCalls: true,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: For `docs/long-log.txt`, report total line count and TAIL_TARGET value near the end as compact JSON.',
        ].join('\n'),
    },
    tree_shape: {
        expectAll: [/checkout/i, /routes/i, /nested/i, /polic/i],
        preferTools: ['list'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Inspect the shape of `src` and report whether it contains checkout, routes, nested, and policies areas as compact JSON.',
        ].join('\n'),
    },
    grep_multi: {
        expectAll: [/PAYMENT_TIMEOUT_TARGET/i, /INVENTORY_MISS_TARGET/i],
        preferTools: ['grep'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'grep', pattern: /PAYMENT_TIMEOUT/ },
            { tool: 'grep', pattern: /INVENTORY_MISS/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: In `logs/events.log`, find both PAYMENT_TIMEOUT and INVENTORY_MISS markers. Use one `grep` call whose pattern array includes both patterns. Answer compact JSON with keys: case, payment_marker, inventory_marker.',
        ].join('\n'),
    },
    grep_context: {
        expectAll: [/STATUS_TARGET=amber|status["\s:]+amber/i, /platform-live-smoke/i],
        preferTools: ['grep'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'grep', pattern: /STATUS_TARGET/ },
            { tool: 'grep', pattern: /output_mode.*content|context|-A/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: In `logs/status.log`, find STATUS_TARGET and the owner on the following line. Prefer one `grep` content call with after/context lines. Answer compact JSON with keys: case, status, owner.',
        ].join('\n'),
    },
    grep_count: {
        expectAll: [/2|two/i, /ERROR/i],
        preferTools: ['grep'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'grep', pattern: /ERROR_/ },
            { tool: 'grep', pattern: /output_mode.*count|count/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: In `logs/events.log`, count lines with ERROR_ markers. Use one `grep` call in count mode. Answer compact JSON with keys: case, error_lines.',
        ].join('\n'),
    },
    list_find_size: {
        expectAll: [/LARGE_ARTIFACT_TARGET/i],
        preferTools: ['list', 'read'],
        maxTotalIterations: 3,
        requireToolArgMatches: [
            { tool: 'list', pattern: /mode.*find|min_size/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Under `artifacts`, use a filename/size filtered directory query to identify the JSON report larger than 1000 bytes, then read it and report its marker as compact JSON.',
        ].join('\n'),
    },
    list_find_mtime: {
        expectAll: [/release-2026-04-24\.json/i],
        preferTools: ['list'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'list', pattern: /mode.*find|modified_after/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Under `releases`, use one directory find query filtered to files modified after `2026-04-23T23:00:00Z`. Report the matching filename as compact JSON.',
        ].join('\n'),
    },
    code_graph_callers: {
        expectAll: [/runCheckoutSmoke|app\.mjs|GRAPH_CALLER_TARGET/i],
        preferTools: ['code_graph'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'code_graph', pattern: /callers/ },
            { tool: 'code_graph', pattern: /buildCheckoutPipeline/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Use exactly one `code_graph` call with mode `callers` and symbol `buildCheckoutPipeline`. Answer from its call-site output as compact JSON with keys: case, caller_file, caller_function, evidence. Do not use read or find_symbol.',
        ].join('\n'),
    },
    read_bookends: {
        expectAll: [/BOOKEND_HEAD=coral-start|coral-start/i, /BOOKEND_TAIL=indigo-finish|indigo-finish/i],
        preferTools: ['read'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: For the already-known file `docs/bookends.txt`, report the first marker and last marker. Use exactly one `multi_read` call with head and tail entries; do not send two separate `read` calls. Answer compact JSON.',
        ].join('\n'),
    },
    read_offset_window: {
        expectAll: [/MARK_TARGET=aurora-next-offset|aurora-next-offset/i],
        preferTools: ['read'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'read', pattern: /offset/ },
            { tool: 'read', pattern: /limit/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: In the already-known file `docs/paged.txt`, use one `read` call with offset 8 and limit 2 to report MARK_TARGET as compact JSON.',
        ].join('\n'),
    },
    explore_fast_symbol: {
        expectAll: [/smokeNeedleTarget|IO_SMOKE_NEEDLE|module-13/i],
        preferTools: ['explore'],
        maxTotalIterations: 3,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'explore', pattern: /IO_SMOKE_NEEDLE/ },
        ],
        avoidTools: ['bash', 'grep', 'read', 'glob'],
        prompt: [
            'You are a bridge worker running a live routing smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: This is a local filesystem lookup. Use exactly one `explore` call to find `IO_SMOKE_NEEDLE` and report the file and function as compact JSON. Do not call grep/read/glob directly.',
        ].join('\n'),
    },
    explore_fanout: {
        expectAll: [/order\.route\.mjs|profile\.route\.mjs/i, /refund\.policy\.json/i],
        preferTools: ['explore'],
        maxTotalIterations: 8,
        maxToolCalls: 5,
        requireToolArgMatches: [
            { tool: 'explore', pattern: /route|policy/ },
        ],
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live routing smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: This is a multi-angle local codebase lookup. Use one rich `explore` query to locate both route modules and policy JSON files under `src`. Answer compact JSON with keys: case, routes, policies.',
        ].join('\n'),
    },
    recall_single: {
        expectAll: [/fast path|session\/manager|ai-wrapped-dispatch|iter/i],
        preferTools: ['recall'],
        maxTotalIterations: 6,
        maxToolCalls: 3,
        requireToolArgMatches: [
            { tool: 'recall', pattern: /fast path|iter|게이트/ },
        ],
        avoidTools: ['bash', 'grep', 'read', 'search', 'explore'],
        prompt: [
            'You are a bridge worker running a live memory routing smoke benchmark.',
            'Do not modify files. Do not use bash.',
            'Task: This asks about past context. Use exactly one `recall` call for "fast path 게이트 보강 수정 iter 줄이기". Answer compact JSON with keys: case, remembered_change, evidence. Do not use search, explore, grep, or read.',
        ].join('\n'),
    },
    search_live_official: {
        expectAll: [/OpenAI|docs|platform\.openai\.com|models/i],
        preferTools: ['search'],
        maxTotalIterations: 6,
        maxToolCalls: 3,
        requireToolArgMatches: [
            { tool: 'search', pattern: /OpenAI|official|docs|models/ },
        ],
        avoidTools: ['bash', 'grep', 'read', 'explore', 'recall'],
        prompt: [
            'You are a bridge worker running a live external-search routing smoke benchmark.',
            'Do not modify files. Do not use bash.',
            'Task: This is an external web lookup. Use exactly one `search` call for "OpenAI official docs models API", then answer compact JSON with keys: case, source, title, url. Do not use explore, recall, grep, or read.',
        ].join('\n'),
    },
    search_config_guard: {
        expectAll: [/Search is not configured|not configured|search_unconfigured/i],
        preferTools: ['search'],
        maxTotalIterations: 2,
        maxToolCalls: 1,
        requireToolArgMatches: [
            { tool: 'search', pattern: /OpenAI|official|docs/ },
        ],
        avoidTools: ['bash', 'grep', 'read', 'explore', 'recall'],
        prompt: [
            'You are a bridge worker running a live external-search routing smoke benchmark.',
            'Do not modify files. Do not use bash.',
            'Task: This is an external web lookup. Use exactly one `search` call for "OpenAI official docs latest model", then report compact JSON. If the search tool says search is not configured, report {"case":"search_unconfigured","status":"not_configured"}. Do not use explore, recall, grep, or read.',
        ].join('\n'),
    },
    explore: {
        expectAll: [/smokeNeedleTarget|IO_SMOKE_NEEDLE|module-13/i],
        preferTools: ['explore'],
        maxTotalIterations: 12,
        avoidTools: ['bash'],
        prompt: [
            'You are a bridge worker running a live nested-agent IO smoke benchmark in the current working directory.',
            'Do not modify files. Do not use bash.',
            'Task: Use the `explore` tool to ask the internal explorer to locate `IO_SMOKE_NEEDLE` under this cwd. Then answer compact JSON.',
        ].join('\n'),
    },
};

function selectedCases(caseName) {
    if (caseName === 'all') return Object.entries(CASES);
    const names = String(caseName || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) return Object.entries(CASES);
    for (const name of names) {
        if (!CASES[name]) throw new Error(`unknown case: ${name}`);
    }
    return names.map((name) => [name, CASES[name]]);
}

function decodeToolText(result) {
    return (result?.content || []).map((c) => c?.type === 'text' ? c.text || '' : JSON.stringify(c)).join('\n');
}

function parseJsonObject(text) {
    try { return JSON.parse(text); } catch {}
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

function isTerminalNotification(text) {
    const s = String(text || '');
    return /\b\d+\s+loops?\b/.test(s) || /\berror:/.test(s) || /\bcancelled\b/.test(s);
}

function bridgeCall(args, { timeoutMs }) {
    if (!runtime) throw new Error('runtime not loaded');
    const notifications = [];
    let done = false;
    let resolveFinal;
    const finalPromise = new Promise((resolve) => { resolveFinal = resolve; });
    const notifyFn = (text, meta = {}) => {
        notifications.push({ text: String(text || ''), meta, ts: new Date().toISOString() });
        if (!meta?.silent_to_agent && isTerminalNotification(text) && !done) {
            done = true;
            resolveFinal(String(text || ''));
        }
    };
    const started = runtime.handleToolCall('bridge', args, {
        notifyFn,
        toolExecutor: runtime.handleToolCall,
        internalTools: runtime.TOOL_DEFS,
    });
    return started.then((result) => {
        const text = decodeToolText(result);
        const data = parseJsonObject(text);
        if (result?.isError) throw new Error(text);
        if (!data?.sessionId) throw new Error(`bridge did not return a sessionId: ${text}`);
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`bridge worker timed out after ${timeoutMs}ms: ${data.sessionId}`)), timeoutMs);
        });
        return Promise.race([finalPromise, timeout]).then((finalText) => ({
            bridgeResponse: data,
            finalText,
            notifications,
        }));
    });
}

function tracePath() {
    ensureLocalPluginEnv();
    return join(process.env.CLAUDE_PLUGIN_DATA, 'history', 'bridge-trace.jsonl');
}

function traceOffset() {
    try { return statSync(tracePath()).size; } catch { return 0; }
}

function readTraceSince(offset) {
    try {
        return readFileSync(tracePath(), 'utf8').slice(offset)
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function waitForTraceRows(offset, parentSessionId) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const rows = readTraceSince(offset);
        if (rows.some((r) => r.sessionId === parentSessionId && r.kind === 'loop')) return rows;
        await new Promise((r) => setTimeout(r, 200));
    }
    return readTraceSince(offset);
}

function sessionProcessPrefix(sessionId) {
    const m = String(sessionId || '').match(/^(sess_[^_]+_)/);
    return m ? m[1] : '';
}

function compactJson(value, max = 220) {
    let text = '';
    try { text = JSON.stringify(value); } catch { text = String(value); }
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatToolStep(row) {
    const args = row.tool_args ? ` ${compactJson(row.tool_args)}` : '';
    return `${row.iteration}:${row.tool_name}${args}`;
}

function summarizeTrace(rows, parentSessionId, parentScope, { allowPrefixFallback = false } = {}) {
    const parentPrefix = sessionProcessPrefix(parentSessionId);
    const sessions = new Map();
    function entry(sessionId) {
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, {
                sessionId,
                scope: null,
                model: null,
                provider: null,
                parentSessionId: null,
                iterations: 0,
                toolCalls: 0,
                toolChain: [],
                tools: [],
                durationMs: 0,
            });
        }
        return sessions.get(sessionId);
    }
    for (const row of rows) {
        const sessionId = row.sessionId;
        if (!sessionId || sessionId === 'no-session') continue;
        if (row.kind === 'preset_assign') {
            const e = entry(sessionId);
            e.scope = row.role || e.scope;
            e.model = row.model || e.model;
            e.provider = row.provider || e.provider;
            e.parentSessionId = row.parent_session_id || e.parentSessionId;
        } else if (row.kind === 'loop') {
            const e = entry(sessionId);
            e.iterations = Math.max(e.iterations, Number(row.iteration) || 0);
            if (typeof row.send_ms === 'number') e.durationMs += row.send_ms;
        } else if (row.kind === 'tool') {
            const e = entry(sessionId);
            e.toolCalls += 1;
            e.toolChain.push(formatToolStep(row));
            e.tools.push({ iteration: Number(row.iteration) || 0, name: row.tool_name, args: row.tool_args || null });
            if (typeof row.tool_ms === 'number') e.durationMs += row.tool_ms;
        } else if (row.kind === 'usage_raw') {
            const e = entry(sessionId);
            e.model = row.model || e.model;
            e.provider = row.provider || e.provider;
        }
    }
    const selectedIds = new Set([parentSessionId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const s of sessions.values()) {
            if (s.parentSessionId && selectedIds.has(s.parentSessionId) && !selectedIds.has(s.sessionId)) {
                selectedIds.add(s.sessionId);
                changed = true;
            }
        }
    }
    const selected = [...sessions.values()].filter((s) => {
        if (selectedIds.has(s.sessionId)) return true;
        if (!allowPrefixFallback) return false;
        if (!parentPrefix || !s.sessionId.startsWith(parentPrefix)) return false;
        return s.iterations > 0 || s.toolCalls > 0;
    });
    for (const s of selected) {
        if (s.sessionId === parentSessionId && !s.scope) s.scope = parentScope || 'worker';
        else if (!s.scope) s.scope = 'nested';
    }
    return {
        totalIterations: selected.reduce((n, r) => n + (Number(r.iterations) || 0), 0),
        totalToolCalls: selected.reduce((n, r) => n + (Number(r.toolCalls) || 0), 0),
        rows: selected.map((r) => ({
            sessionId: r.sessionId,
            scope: r.scope,
            model: r.model,
            parentSessionId: r.parentSessionId,
            iterations: Number(r.iterations) || 0,
            toolCalls: Number(r.toolCalls) || 0,
            toolChain: r.toolChain,
            tools: r.tools,
            durationMs: r.durationMs || 0,
        })),
    };
}

function evaluateToolFit(spec, totals) {
    const tools = totals.rows.flatMap((r) => (r.tools || []).map((t) => ({ ...t, scope: r.scope })));
    const toolNames = tools.map((t) => t.name).filter(Boolean);
    const used = new Set(toolNames);
    const hasTool = (name) => {
        if (used.has(name)) return true;
        if (name === 'read') return used.has('multi_read');
        return false;
    };
    const missingPreferred = (spec.preferTools || []).filter((name) => !hasTool(name));
    const avoidedUsed = (spec.avoidTools || []).filter((name) => used.has(name));
    const overBudget = spec.maxTotalIterations && totals.totalIterations > spec.maxTotalIterations;
    const overToolCalls = spec.maxToolCalls && totals.totalToolCalls > spec.maxToolCalls;
    const missingArgMatches = (spec.requireToolArgMatches || []).filter((req) => {
        const re = req.pattern instanceof RegExp ? req.pattern : new RegExp(String(req.pattern || ''), 'i');
        return !tools.some((tool) => tool.name === req.tool && re.test(compactJson(tool.args || {}, 2000)));
    }).map((req) => `${req.tool}:${req.pattern}`);
    const seenCalls = new Set();
    const duplicateToolCalls = [];
    if (spec.noDuplicateToolCalls) {
        for (const tool of tools) {
            const sig = `${tool.name}:${compactJson(tool.args || {}, 2000)}`;
            if (seenCalls.has(sig)) duplicateToolCalls.push(tool.name);
            else seenCalls.add(sig);
        }
    }
    return {
        ok: missingPreferred.length === 0 && avoidedUsed.length === 0 && !overBudget && !overToolCalls && missingArgMatches.length === 0 && duplicateToolCalls.length === 0,
        toolNames,
        missingPreferred,
        avoidedUsed,
        missingArgMatches,
        duplicateToolCalls,
        overBudget: overBudget ? { max: spec.maxTotalIterations, actual: totals.totalIterations } : null,
        overToolCalls: overToolCalls ? { max: spec.maxToolCalls, actual: totals.totalToolCalls } : null,
    };
}

function textMatchesSpec(spec, text) {
    const checks = spec.expectAll || (spec.expect ? [spec.expect] : []);
    return checks.every((re) => re.test(String(text || '')));
}

async function registerLiveSyntheticTools(rt) {
    if (syntheticToolsRegistered) return;
    syntheticToolsRegistered = true;
    const [{ setInternalToolsProvider, addInternalTools }, { SYNTHETIC_TOOL_DEFS }] = await Promise.all([
        import('../src/agent/orchestrator/internal-tools.mjs'),
        import('../src/agent/orchestrator/synthetic-tools.mjs'),
    ]);
    setInternalToolsProvider({ executor: rt.handleToolCall, tools: rt.TOOL_DEFS });
    addInternalTools(SYNTHETIC_TOOL_DEFS.map((def) => ({
        def,
        executor: def.name === 'memory_search'
            ? liveMemorySearch
            : def.name === 'web_search'
                ? liveWebSearch
                : null,
    })).filter((entry) => typeof entry.executor === 'function'));
}

function truncateLine(text, max = 420) {
    const single = String(text ?? '').replace(/\s+/g, ' ').trim();
    return single.length > max ? `${single.slice(0, max)}...` : single;
}

function ftsQueryFor(text) {
    const tokens = String(text || '')
        .match(/[A-Za-z0-9_.:-]{3,}|[\p{Script=Hangul}]{2,}/gu);
    const picked = [...new Set(tokens || [String(text || '').trim()].filter(Boolean))].slice(0, 8);
    return picked.map((token) => `"${String(token).replace(/"/g, '""')}"`).join(' OR ');
}

function openMemoryDbReadOnly() {
    ensureLocalPluginEnv();
    const dbPath = join(process.env.CLAUDE_PLUGIN_DATA, 'memory.sqlite');
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
            return db;
        } catch {
            try { db.close(); } catch {}
        }
    } catch {}
    return new DatabaseSync(`file:${dbPath}?mode=ro&immutable=1`, { readOnly: true });
}

function searchMemoryRows(db, query, limit) {
    const clean = String(query || '').trim();
    if (!clean) {
        return db.prepare(`
            SELECT id, ts, role, content, element, category, summary, status, score
            FROM entries
            ORDER BY ts DESC
            LIMIT ?
        `).all(limit);
    }
    const ftsQuery = ftsQueryFor(clean);
    if (ftsQuery) {
        try {
            const rows = db.prepare(`
                SELECT e.id, e.ts, e.role, e.content, e.element, e.category, e.summary, e.status, e.score,
                       bm25(entries_fts) AS bm25
                FROM entries_fts
                JOIN entries e ON e.id = entries_fts.rowid
                WHERE entries_fts MATCH ?
                ORDER BY bm25(entries_fts)
                LIMIT ?
            `).all(ftsQuery, limit);
            if (rows.length > 0) return rows;
        } catch {}
    }
    const tokens = String(clean).split(/\s+/).map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 8);
    if (tokens.length === 0) return [];
    const where = tokens.map(() => '(content LIKE ? OR summary LIKE ? OR element LIKE ?)').join(' OR ');
    return db.prepare(`
        SELECT id, ts, role, content, element, category, summary, status, score
        FROM entries
        WHERE ${where}
        ORDER BY ts DESC
        LIMIT ?
    `).all(...tokens.flatMap((token) => [`%${token}%`, `%${token}%`, `%${token}%`]), limit);
}

async function liveMemorySearch(args = {}) {
    const queries = Array.isArray(args.query) ? args.query : [args.query || ''];
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
    let db = null;
    try {
        db = openMemoryDbReadOnly();
        const sections = queries.map((query) => {
            const rows = searchMemoryRows(db, query, limit);
            const body = rows.length > 0
                ? rows.map((row, index) => [
                    `${index + 1}. id=${row.id} ts=${new Date(Number(row.ts) || 0).toISOString()} category=${row.category || 'unknown'} status=${row.status || 'unknown'}`,
                    row.element ? `   element: ${truncateLine(row.element, 240)}` : null,
                    row.summary ? `   summary: ${truncateLine(row.summary)}` : null,
                    `   content: ${truncateLine(row.content)}`,
                ].filter(Boolean).join('\n')).join('\n')
                : '(no memory hits)';
            return `### Query: ${query || '(latest)'}\n${body}`;
        });
        return { content: [{ type: 'text', text: sections.join('\n\n') }] };
    } catch (err) {
        return { content: [{ type: 'text', text: `memory_search failed: ${err?.message || err}` }], isError: true };
    } finally {
        try { db?.close(); } catch {}
    }
}

async function liveWebSearch(args = {}) {
    ensureLocalPluginEnv();
    const search = await import('../src/search/index.mjs');
    return search.handleToolCall('search', args || {});
}

async function seedRecallMemoryIfNeeded(cases) {
    if (!cases.some(([, spec]) => spec.seedRecall)) return [];
    ensureLocalPluginEnv();
    const dbPath = join(process.env.CLAUDE_PLUGIN_DATA, 'memory.sqlite');
    const db = new DatabaseSync(dbPath);
    const nowMs = Date.now();
    const sourceRef = `live-smoke:${nowMs}-${process.pid}`;
    const summary = 'Live smoke recall marker for routing benchmark; safe to forget after the run.';
    db.exec('BEGIN');
    try {
        const result = db.prepare(`
            INSERT INTO entries(ts, role, content, source_ref, session_id)
            VALUES (?, 'system', ?, ?, NULL)
        `).run(nowMs, `${RECALL_TARGET} - ${summary}`, sourceRef);
        const id = Number(result.lastInsertRowid);
        db.prepare(`
            UPDATE entries
            SET chunk_root = ?, is_root = 1, element = ?, category = 'fact', summary = ?,
                status = 'active', score = 1.6, last_seen_at = ?
            WHERE id = ?
        `).run(id, RECALL_TARGET, summary, nowMs, id);
        db.exec('COMMIT');
        db.close();
        return [id];
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        try { db.close(); } catch {}
        throw err;
    }
}

async function cleanupRecallSeeds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    ensureLocalPluginEnv();
    const dbPath = join(process.env.CLAUDE_PLUGIN_DATA, 'memory.sqlite');
    const db = new DatabaseSync(dbPath);
    for (const id of ids) {
        try {
            db.prepare(`UPDATE entries SET status = 'archived' WHERE id = ?`).run(id);
        } catch {
            // best-effort cleanup; benchmark result should not hinge on it
        }
    }
    try { db.close(); } catch {}
}

function classifyRunError(err) {
    const message = err instanceof Error ? err.message : String(err || '');
    if (/Invalid authentication credentials|authentication_error|Claude Code manages refresh|401\b/i.test(message)) {
        return { type: 'auth', infra: true };
    }
    if (/role ".*" not found in user-workflow\.json|preset ".*" not found|preset unresolved/i.test(message)) {
        return { type: 'config', infra: true };
    }
    if (/timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(message)) {
        return { type: 'network', infra: true };
    }
    return { type: 'case', infra: false };
}

async function runCase({ name, spec, opts, workspace, runIndex }) {
    const startOffset = traceOffset();
    const t0 = performance.now();
    const args = { role: opts.role, prompt: spec.prompt, cwd: workspace };
    if (opts.preset) args.preset = opts.preset;
    try {
        const bridge = await bridgeCall(args, { timeoutMs: opts.timeoutMs });
        const traceRows = await waitForTraceRows(startOffset, bridge.bridgeResponse.sessionId);
        const totals = summarizeTrace(traceRows, bridge.bridgeResponse.sessionId, opts.role, { allowPrefixFallback: !opts.parallel });
        const classification = classifyRunError(bridge.finalText);
        return {
            case: name,
            run: runIndex,
            ok: textMatchesSpec(spec, bridge.finalText),
            blocked: classification.infra,
            errorType: classification.infra ? classification.type : null,
            toolFit: evaluateToolFit(spec, totals),
            bridge: bridge.bridgeResponse,
            totalIterations: totals.totalIterations,
            totalToolCalls: totals.totalToolCalls,
            durationMs: Math.round(performance.now() - t0),
            agents: totals.rows,
            finalPreview: bridge.finalText.slice(0, 1200),
            notificationCount: bridge.notifications.length,
        };
    } catch (err) {
        const classification = classifyRunError(err);
        return {
            case: name,
            run: runIndex,
            ok: false,
            blocked: classification.infra,
            errorType: classification.type,
            totalIterations: 0,
            totalToolCalls: 0,
            durationMs: Math.round(performance.now() - t0),
            agents: [],
            toolFit: { ok: false, toolNames: [], missingPreferred: spec.preferTools || [], avoidedUsed: [], overBudget: null, overToolCalls: null },
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

function aggregate(results) {
    const passed = results.filter((r) => r.ok && r.toolFit?.ok !== false).length;
    const blocked = results.filter((r) => r.blocked).length;
    return {
        ok: passed === results.length,
        cases: results.length,
        passed,
        blocked,
        avgIterations: results.length ? results.reduce((n, r) => n + (r.totalIterations || 0), 0) / results.length : null,
        totalIterations: results.reduce((n, r) => n + (r.totalIterations || 0), 0),
        totalToolCalls: results.reduce((n, r) => n + (r.totalToolCalls || 0), 0),
        totalDurationMs: results.reduce((n, r) => n + (r.durationMs || 0), 0),
    };
}

function printHuman(summary, results, workspace) {
    console.log(`live-io-smoke bridge workspace: ${workspace}`);
    console.log(`status: ${summary.ok ? 'PASS' : 'FAIL'} (${summary.passed}/${summary.cases}${summary.blocked ? `, blocked=${summary.blocked}` : ''})`);
    if (summary.avgIterations !== null) console.log(`avg total iterations: ${summary.avgIterations.toFixed(2)}`);
    console.log(`total iterations: ${summary.totalIterations}`);
    console.log(`total tool calls: ${summary.totalToolCalls}`);
    console.log(`total duration: ${(summary.totalDurationMs / 1000).toFixed(1)}s`);
    for (const r of results) {
        const status = r.ok ? 'ok' : (r.blocked ? 'BLOCKED' : 'FAIL');
        console.log(`${status}\t${r.case}#${r.run}\ttotal_iter=${r.totalIterations}\tcalls=${r.totalToolCalls}\t${(r.durationMs / 1000).toFixed(1)}s\tsession=${r.bridge?.sessionId || '?'}`);
        for (const a of r.agents || []) {
            console.log(`  ${a.scope}\titer=${a.iterations}\tcalls=${a.toolCalls}\t${a.toolChain.join(' > ')}`);
        }
        if (r.toolFit && !r.toolFit.ok && !r.blocked) {
            const notes = [];
            if (r.toolFit.missingPreferred?.length) notes.push(`missing preferred: ${r.toolFit.missingPreferred.join(',')}`);
            if (r.toolFit.missingArgMatches?.length) notes.push(`missing tool-arg evidence: ${r.toolFit.missingArgMatches.join(',')}`);
            if (r.toolFit.duplicateToolCalls?.length) notes.push(`duplicate calls: ${[...new Set(r.toolFit.duplicateToolCalls)].join(',')}`);
            if (r.toolFit.avoidedUsed?.length) notes.push(`avoid used: ${r.toolFit.avoidedUsed.join(',')}`);
            if (r.toolFit.overBudget) notes.push(`iter budget ${r.toolFit.overBudget.actual}/${r.toolFit.overBudget.max}`);
            if (r.toolFit.overToolCalls) notes.push(`tool-call budget ${r.toolFit.overToolCalls.actual}/${r.toolFit.overToolCalls.max}`);
            console.log(`  tool-fit: watch (${notes.join('; ')})`);
        }
        if (r.error) console.log(`  error${r.errorType ? `(${r.errorType})` : ''}: ${r.error}`);
        if (!r.ok && r.finalPreview) console.log(`  final: ${r.finalPreview.replace(/\s+/g, ' ').slice(0, 500)}`);
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const workspace = opts.workspace || mkdtempSync(join(tmpdir(), 'mixdog-live-io-smoke-'));
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
    createFixture(workspace);

    const cases = selectedCases(opts.caseName);
    const results = [];
    const rt = await loadRuntime();
    let recallSeedIds = [];
    await rt.init();
    await registerLiveSyntheticTools(rt);
    try {
        recallSeedIds = await seedRecallMemoryIfNeeded(cases);
        for (let run = 1; run <= opts.runs; run++) {
            if (opts.parallel) {
                results.push(...await Promise.all(cases.map(([name, spec]) => runCase({ name, spec, opts, workspace, runIndex: run }))));
            } else {
                for (const [name, spec] of cases) {
                    results.push(await runCase({ name, spec, opts, workspace, runIndex: run }));
                }
            }
        }
    } finally {
        await cleanupRecallSeeds(recallSeedIds);
        try { await rt.stop(); } catch {}
        if (!opts.keepWorkspace && !opts.workspace) rmSync(workspace, { recursive: true, force: true });
    }

    const summary = aggregate(results);
    const payload = { summary, role: opts.role, preset: opts.preset || null, workspace, results };
    if (opts.json) console.log(JSON.stringify(payload, null, 2));
    else printHuman(summary, results, workspace);
    process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
    console.error(`live-io-smoke failed: ${err?.message || err}`);
    process.exit(1);
});
