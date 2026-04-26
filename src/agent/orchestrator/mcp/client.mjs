import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { DEFAULT_MARKETPLACE } from '../../../shared/plugin-paths.mjs';
// --- Types ---
/** Known auto-detect targets: port file path relative to tmpdir.
 *  Note: `mixdog` used to self-loopback via active-instance.json's
 *  httpPort, but that path went through channels' owner HTTP server which
 *  only exposes a subset of tools. The plugin's own tools are now injected
 *  in-process through agent's toolExecutor (see orchestrator/internal-tools),
 *  so this registry is for genuinely external port-based MCP targets only. */
const AUTO_DETECT_PORTS = {
    'mixdog-memory': { dir: 'mixdog-memory', file: 'memory-port', endpoint: '/mcp' },
};
// --- State ---
const servers = new Map();
// --- Public API ---
/**
 * Connect to MCP servers defined in config.
 * Supports stdio (child process) and http (Streamable HTTP) transports.
 */
export async function connectMcpServers(config) {
    const failures = [];
    for (const [name, cfg] of Object.entries(config)) {
        try {
            await connectServer(name, cfg);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[mcp-client] Failed to connect "${name}": ${msg}\n`);
            failures.push({ name, msg });
        }
    }
    if (failures.length > 0) {
        const detail = failures.map(f => `${f.name}: ${f.msg}`).join('; ');
        throw new Error(`[mcp-client] ${failures.length} MCP server(s) failed to connect — ${detail}`);
    }
}
/**
 * Get all tool definitions from connected MCP servers.
 * Tool names are prefixed: `mcp__{serverName}__{toolName}`
 */
export function getMcpTools() {
    const tools = [];
    for (const server of servers.values()) {
        tools.push(...server.tools);
    }
    return tools;
}
/**
 * Execute an MCP tool call.
 * Name format: `mcp__{serverName}__{toolName}`
 */
export async function executeMcpTool(name, args) {
    // Parse: mcp__{server}__{tool}
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match)
        throw new Error(`Not an MCP tool name: ${name}`);
    const [, serverName, toolName] = match;
    const server = servers.get(serverName);
    if (!server)
        throw new Error(`MCP server "${serverName}" not connected`);
    let result;
    try {
        result = await server.client.callTool({ name: toolName, arguments: args });
    } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        process.stderr.write(`[mcp-client] Tool call failed, attempting reconnect...\n`);
        await new Promise(r => setTimeout(r, 500));
        try {
            await server.client.close();
        } catch { /* ignore close error */ }
        try {
            await connectServer(serverName, server.cfg);
        } catch (reconnectErr) {
            const reconnectMsg = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
            throw new Error(`Tool call failed: ${firstMsg}; reconnect also failed: ${reconnectMsg}`);
        }
        const retryServer = servers.get(serverName);
        try {
            result = await retryServer.client.callTool({ name: toolName, arguments: args });
        } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new Error(`Tool call failed: ${firstMsg}; retry after reconnect also failed: ${retryMsg}`);
        }
    }
    const content = result.content;
    let text;
    if (Array.isArray(content)) {
        text = content
            .map((c) => (c.type === 'text' ? c.text || '' : JSON.stringify(c)))
            .join('\n');
    } else {
        text = typeof content === 'string' ? content : JSON.stringify(content);
    }
    return capMcpOutput(text);
}

// Matches Claude Code's DEFAULT_MAX_MCP_OUTPUT_TOKENS (25_000 tokens) at the
// ~4-chars-per-token rule of thumb used elsewhere in this orchestrator. MCP
// tools (search/recall/fetch/etc.) can return arbitrarily large text and were
// the unchecked path that spiked iter 9 context to 218k input tokens on
// 2026-04-19. Claude Code lets the model request the full content via a
// separate fetch on token-count breaches; we do not yet have that, so the
// head slice is what the model sees.
const MCP_OUTPUT_MAX_CHARS = 100_000;

function capMcpOutput(content) {
    const s = typeof content === 'string' ? content : String(content ?? '');
    if (s.length <= MCP_OUTPUT_MAX_CHARS) return s;
    const head = s.slice(0, MCP_OUTPUT_MAX_CHARS);
    const tail = s.slice(MCP_OUTPUT_MAX_CHARS);
    const remainingLines = (tail.match(/\n/g) || []).length + 1;
    return `${head}\n\n... [${remainingLines} lines truncated] ...`;
}
/**
 * Check if a tool name is an MCP tool.
 */
export function isMcpTool(name) {
    return name.startsWith('mcp__');
}
/**
 * Check whether the inputSchema for an MCP tool declares the given top-level
 * property. Used to decide if the orchestrator should auto-inject context
 * (e.g. cwd) into the args before dispatch — schemas that don't declare the
 * field would reject the unknown argument.
 */
export function mcpToolHasField(name, field) {
    const match = name.match(/^mcp__(.+?)__(.+)$/);
    if (!match) return false;
    const [, serverName] = match;
    const server = servers.get(serverName);
    if (!server) return false;
    const tool = server.tools.find((t) => t.name === name);
    if (!tool) return false;
    const props = tool.inputSchema?.properties;
    return Boolean(props && Object.prototype.hasOwnProperty.call(props, field));
}
/**
 * Disconnect all MCP servers.
 */
export async function disconnectAll() {
    for (const [name, server] of servers) {
        try {
            await server.client.close();
        }
        catch { /* ignore */ }
        servers.delete(name);
    }
}
/**
 * Load MCP server configs from a JSON file.
 * Supports both `{ mcpServers: { ... } }` and flat `{ name: { ... } }` format.
 */
export function loadMcpConfig(configPath) {
    if (!existsSync(configPath))
        return {};
    try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        const mcpServers = raw.mcpServers || raw;
        const result = {};
        for (const [name, cfg] of Object.entries(mcpServers)) {
            const c = cfg;
            if (typeof c.pluginCache === 'string') {
                result[name] = { pluginCache: c.pluginCache, script: c.script };
            }
            else if (typeof c.autoDetect === 'string') {
                result[name] = { autoDetect: c.autoDetect };
            }
            else if (c.transport === 'http' && typeof c.url === 'string') {
                result[name] = { transport: 'http', url: c.url };
            }
            else if (typeof c.command === 'string') {
                const transport = c.transport === 'http' ? 'http' : 'stdio';
                result[name] = {
                    transport,
                    command: c.command,
                    args: Array.isArray(c.args) ? c.args : undefined,
                    cwd: typeof c.cwd === 'string' ? c.cwd : undefined,
                    env: typeof c.env === 'object' && c.env !== null ? c.env : undefined,
                };
            }
        }
        return result;
    }
    catch {
        return {};
    }
}
// --- Internal ---
function resolvePluginCacheScript(pluginName, script) {
    const cacheBase = join(homedir(), '.claude', 'plugins', 'cache', DEFAULT_MARKETPLACE, pluginName);
    if (existsSync(cacheBase)) {
        const versions = readdirSync(cacheBase).filter(d => /^\d+\.\d+\.\d+/.test(d)).sort((a, b) => {
            const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
            return (pa[0] - pb[0]) || (pa[1] - pb[1]) || (pa[2] - pb[2]);
        });
        for (let i = versions.length - 1; i >= 0; i--) {
            const version = versions[i];
            const dir = join(cacheBase, version);
            const scriptPath = join(dir, script);
            if (existsSync(scriptPath)) {
                return { dir, scriptPath, source: `pluginCache:${pluginName}@${version}` };
            }
        }
    }
    const marketplaceDir = join(homedir(), '.claude', 'plugins', 'marketplaces', DEFAULT_MARKETPLACE, 'external_plugins', pluginName);
    const marketplaceScript = join(marketplaceDir, script);
    if (existsSync(marketplaceScript)) {
        return { dir: marketplaceDir, scriptPath: marketplaceScript, source: `marketplace:${pluginName}` };
    }
    return null;
}

async function connectServer(name, cfg) {
    const client = new Client({ name: `mixdog-agent/${name}`, version: '1.0.0' });
    let transport;
    // pluginCache: resolve latest cached plugin version as stdio transport
    if (cfg.pluginCache) {
        const script = cfg.script || 'scripts/run-mcp.mjs';
        const resolved = resolvePluginCacheScript(cfg.pluginCache, script);
        if (!resolved) throw new Error(`Script not found for pluginCache "${cfg.pluginCache}" (${script})`);
        transport = new StdioClientTransport({
            command: 'node',
            args: [resolved.scriptPath],
            cwd: resolved.dir,
            env: {
                ...process.env,
                CLAUDE_PLUGIN_ROOT: resolved.dir,
                CLAUDE_PLUGIN_DATA: join(homedir(), '.claude', 'plugins', 'data', `${pluginName}-${DEFAULT_MARKETPLACE}`),
            },
        });
        process.stderr.write(`[mcp-client] Connecting "${name}" via ${resolved.source}\n`);
    }
    // Auto-detect: read port from a running service's port file
    else if (cfg.autoDetect) {
        const spec = AUTO_DETECT_PORTS[cfg.autoDetect];
        if (!spec)
            throw new Error(`Unknown autoDetect target: "${cfg.autoDetect}"`);
        const portFile = join(tmpdir(), spec.dir, spec.file);
        if (!existsSync(portFile)) {
            process.stderr.write(`[mcp-client] "${name}" autoDetect: port file not found (${portFile}), skipping\n`);
            return;
        }
        let port;
        const raw = readFileSync(portFile, 'utf-8').trim();
        if (spec.portField) {
            try {
                const json = JSON.parse(raw);
                port = json[spec.portField];
            }
            catch {
                process.stderr.write(`[mcp-client] "${name}" autoDetect: failed to parse JSON in ${portFile}, skipping\n`);
                return;
            }
        }
        else {
            port = parseInt(raw, 10);
        }
        if (!port || port < 1 || port > 65535) {
            process.stderr.write(`[mcp-client] "${name}" autoDetect: invalid port in ${portFile}, skipping\n`);
            return;
        }
        const url = `http://127.0.0.1:${port}${spec.endpoint}`;
        transport = new StreamableHTTPClientTransport(new URL(url));
        process.stderr.write(`[mcp-client] Connecting "${name}" via autoDetect HTTP: ${url}\n`);
    }
    else if (cfg.transport === 'http' && cfg.url) {
        transport = new StreamableHTTPClientTransport(new URL(cfg.url));
        process.stderr.write(`[mcp-client] Connecting "${name}" via HTTP: ${cfg.url}\n`);
    }
    else if (cfg.command) {
        transport = new StdioClientTransport({
            command: cfg.command,
            args: cfg.args,
            cwd: cfg.cwd,
            env: { ...process.env, ...cfg.env },
        });
    }
    else {
        throw new Error(`Invalid config for "${name}": need autoDetect, url (http), or command (stdio)`);
    }
    await client.connect(transport);
    const toolsResult = await client.listTools();
    const tools = (toolsResult.tools || []).map((t) => ({
        name: `mcp__${name}__${t.name}`,
        description: t.description ? t.description.slice(0, 2048) : '',
        inputSchema: (t.inputSchema || { type: 'object', properties: {} }),
    }));
    const mode = cfg.pluginCache ? `pluginCache(${cfg.pluginCache})` : cfg.autoDetect ? `autoDetect(${cfg.autoDetect})` : cfg.transport || 'stdio';
    const toolNames = tools.map(t => t.name);
    servers.set(name, { name, client, transport, tools, cfg });
    process.stderr.write(`[mcp] connected: ${tools.length} tools — ${toolNames.join(', ')}\n`);
}
