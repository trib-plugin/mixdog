/**
 * OpenAI ChatGPT OAuth (Codex) provider.
 *
 * Dispatches over the WebSocket upgrade of chatgpt.com/backend-api/codex/
 * responses (responses_websockets=2026-02-06 beta). Authenticates via PKCE
 * OAuth or reuses ~/.codex/auth.json. Streaming/framing lives in
 * openai-oauth-ws.mjs; this file owns auth, model catalog, and request-body
 * shape.
 */
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getPluginData } from '../config.mjs';
import { enrichModels } from './model-catalog.mjs';

import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import { warnBridgeOnce } from '../bridge-trace.mjs';
// --- Constants ---
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const CALLBACK_PORT = 1455;
// Version string baked into the models endpoint query — Codex rejects the
// request without it. Keep close to the latest published Codex CLI because
// older versions trigger a visibility-filtered catalog (e.g. only rollout
// models). Bump when the real CLI bumps.
const CODEX_CLIENT_VERSION = '0.107.0';
const CODEX_MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;

function _codexModelCachePath() {
    return join(getPluginData(), 'openai-oauth-models.json');
}

async function _loadCodexModelCache() {
    const path = _codexModelCachePath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw?.fetchedAt || !Array.isArray(raw.models)) return null;
        if (Date.now() - raw.fetchedAt > CODEX_MODEL_CACHE_TTL_MS) return null;
        return raw.models;
    } catch { return null; }
}

async function _saveCodexModelCache(models) {
    try {
        writeFileSync(_codexModelCachePath(), JSON.stringify({
            fetchedAt: Date.now(),
            models,
        }, null, 2));
        _inMemoryCodexCatalog = Array.isArray(models) ? models.slice() : null;
    } catch { /* best-effort */ }
}

// In-memory mirror of the on-disk catalog, same pattern as anthropic-oauth.
// Populated on first listModels() and after every _saveCodexModelCache.
let _inMemoryCodexCatalog = null;
let _codexRefreshInFlight = null;

function _codexCatalogHas(id) {
    if (!id || !Array.isArray(_inMemoryCodexCatalog)) return false;
    return _inMemoryCodexCatalog.some(m => m.id === id);
}

// Codex returns dated ids (gpt-5.4-mini-2026-03-17). Strip the trailing
// -YYYY-MM-DD to get the version alias (gpt-5.4-mini). Unknown shapes pass
// through unchanged.
function _displayCodexModel(id) {
    if (!id || typeof id !== 'string') return id;
    return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function _normalizeCodexModel(m) {
    const id = m?.slug || m?.id;
    const family = _codexFamily(id);
    // Codex doesn't use dated ids — everything is effectively a version alias.
    return {
        id,
        name: m?.display_name || id,
        display: m?.display_name || id,
        family,
        provider: 'openai-oauth',
        contextWindow: m?.context_window || 1000000,
        outputTokens: m?.auto_compact_token_limit || 32768,
        tier: 'version',
        latest: false,
        description: m?.description || '',
        reasoningLevels: (m?.supported_reasoning_levels || []).map(r => r.effort),
    };
}

function _codexFamily(id) {
    const s = String(id || '').toLowerCase();
    if (s.includes('nano')) return 'gpt-nano';
    if (s.includes('mini')) return 'gpt-mini';
    if (s.includes('codex')) return 'gpt-codex';
    if (s.startsWith('gpt-5.5')) return 'gpt-5.5';
    if (s.startsWith('gpt-5.4')) return 'gpt-5.4';
    if (s.startsWith('gpt-5.2')) return 'gpt-5.2';
    if (s.startsWith('gpt-5')) return 'gpt-5';
    return 'gpt';
}
function getOwnTokenPath() {
    const dir = getPluginData();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return join(dir, 'openai-oauth.json');
}
function loadTokens() {
    // Try own token store first (has accurate expires_at from refresh)
    const ownPath = getOwnTokenPath();
    if (existsSync(ownPath)) {
        try {
            const own = JSON.parse(readFileSync(ownPath, 'utf-8'));
            if (own.access_token && own.refresh_token) return own;
        }
        catch { /* fall through */ }
    }
    // Otherwise read Codex CLI auth.json (initial bootstrap only)
    const codexPath = join(homedir(), '.codex', 'auth.json');
    if (existsSync(codexPath)) {
        try {
            const data = JSON.parse(readFileSync(codexPath, 'utf-8'));
            const tokens = data.tokens || data;
            if (tokens.access_token && tokens.refresh_token) {
                const expiresAt = typeof data.expires_at === 'number'
                    ? (data.expires_at < 1e12 ? data.expires_at * 1000 : data.expires_at)
                    : (data.last_refresh ? new Date(data.last_refresh).getTime() + 3600_000 : 0);
                return {
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    expires_at: expiresAt,
                    account_id: tokens.account_id || extractAccountId(tokens.access_token),
                };
            }
        }
        catch { /* fall through */ }
    }
    return null;
}
function saveTokens(tokens) {
    writeFileSync(getOwnTokenPath(), JSON.stringify(tokens, null, 2));
}
function extractAccountId(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        return payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    }
    catch {
        return undefined;
    }
}
// --- Token refresh ---
async function refreshTokens(refreshToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            }),
            signal: controller.signal,
        });
        if (!res.ok)
            return null;
        const json = await res.json();
        if (!json.access_token || !json.refresh_token || !json.expires_in)
            return null;
        const tokens = {
            access_token: json.access_token,
            refresh_token: json.refresh_token,
            expires_at: Date.now() + json.expires_in * 1000,
            account_id: extractAccountId(json.access_token),
        };
        saveTokens(tokens);
        return tokens;
    } catch (err) {
        if (err?.name === 'AbortError')
            throw new Error('OpenAI OAuth token refresh timed out after 30000ms');
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}
// --- Build Responses API request ---
/**
 * Convert a message slice to Responses API input items.
 */
function convertMessagesToResponsesInput(messages) {
    const out = [];
    for (const m of messages) {
        if (!m || m.role === 'system') continue;
        if (m.role === 'tool') {
            out.push({
                type: 'function_call_output',
                call_id: m.toolCallId || '',
                output: m.content,
            });
            continue;
        }
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            if (m.content) out.push({ role: 'assistant', content: m.content });
            for (const tc of m.toolCalls) {
                out.push({
                    type: 'function_call',
                    call_id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                });
            }
            continue;
        }
        out.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
        });
    }
    return out;
}
function buildRequestBody(messages, model, tools, sendOpts) {
    // Extract system/instructions
    const systemMsgs = messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.map(m => m.content).join('\n\n') || 'You are a helpful assistant.';
    const opts = sendOpts || {};
    const input = convertMessagesToResponsesInput(messages);
    // Match the body shape pi-mono and the official Codex CLI ship so the
    // server-side auto-cache routes correctly. text.verbosity / include /
    // tool_choice / parallel_tool_calls are all inert without side effects
    // for most callers but their presence affects how Codex classifies the
    // request (and therefore whether the prompt cache is consulted).
    const body = {
        model,
        instructions,
        input,
        store: false,
        stream: true,
        reasoning: { effort: opts.effort || 'medium' },
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
        tool_choice: opts.toolChoice || 'auto',
        parallel_tool_calls: true,
    };
    const cacheKey = opts.promptCacheKey || opts.sessionId;
    if (cacheKey) {
        body.prompt_cache_key = String(cacheKey);
    } else {
        // No stable cache key → Codex server prefix-cache cannot match,
        // every call is uncached. Bridge dispatch always supplies one;
        // log a one-shot warn for raw callers so the silent miss is visible.
        warnBridgeOnce('codex-no-cache-key', '[bridge-cache] openai-oauth: no promptCacheKey/sessionId — request will be uncached');
    }
    // NOTE: prompt_cache_retention is a public OpenAI Responses API parameter —
    // the Codex endpoint (chatgpt.com/backend-api/codex/responses) returns
    // 400 "Unsupported parameter" when it's included. Re-verified 2026-04-19.
    // Leave cache behavior to the Codex server-side default (in-memory, 5-10
    // min). Callers who want extended retention should use the public OpenAI
    // API provider instead of OAuth.
    if (opts.fast === true) {
        body.service_tier = 'priority';
    }
    // Add tools
    if (tools?.length) {
        body.tools = tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        }));
    }
    return body;
}
// --- Provider ---
export class OpenAIOAuthProvider {
    name = 'openai-oauth';
    tokens = null;
    _refreshPromise = null;
    _refreshFallbackUntil = 0;
    config;
    constructor(config) {
        this.config = config || {};
        this.tokens = loadTokens();
    }
    async ensureAuth() {
        if (!this.tokens)
            throw new Error('OpenAI OAuth not authenticated. Run codex login first.');
        if (this._refreshFallbackUntil > Date.now() && this.tokens?.access_token) {
            return this.tokens;
        }
        // Always refresh if expired or close to expiring (5min buffer)
        if (this.tokens.expires_at < Date.now() + 300_000) {
            process.stderr.write(`[openai-oauth] Token expired/expiring, refreshing...\n`);
            try {
                if (!this._refreshPromise) {
                    this._refreshPromise = refreshTokens(this.tokens.refresh_token)
                        .finally(() => { this._refreshPromise = null; });
                }
                const refreshed = await this._refreshPromise;
                if (refreshed) {
                    this.tokens = refreshed;
                    process.stderr.write(`[openai-oauth] Token refreshed, expires in ${Math.round((refreshed.expires_at - Date.now()) / 1000)}s\n`);
                }
                else {
                    throw new Error('refresh returned null');
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[openai-oauth] Refresh failed: ${msg}, re-reading auth files...\n`);
                // Re-read auth files in case user ran codex login
                const reloaded = loadTokens();
                if (reloaded && reloaded.access_token !== this.tokens?.access_token) {
                    this.tokens = reloaded;
                    process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
                    // Retry refresh with new tokens
                    try {
                        const refreshed2 = await refreshTokens(this.tokens.refresh_token);
                        if (refreshed2) { this.tokens = refreshed2; return this.tokens; }
                    } catch { /* fall through */ }
                }
                // Some Codex auth.json states carry a still-valid access token
                // alongside a refresh token that has already been rotated.
                // In that case, using the current access token is better than
                // failing closed up front — the subsequent request will surface
                // a real 401 if the token is truly dead, and send() already
                // retries once on that path.
                if (this.tokens?.access_token) {
                    this._refreshFallbackUntil = Date.now() + 5 * 60_000;
                    process.stderr.write(`[openai-oauth] Falling back to existing access token after refresh failure\n`);
                    return this.tokens;
                }
                throw new Error('OpenAI OAuth token refresh failed. Run codex login to re-authenticate.');
            }
        }
        return this.tokens;
    }
    async send(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const externalSignal = opts.signal || null;
        let auth = await this.ensureAuth();
        const useModel = model || 'gpt-5.5';
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        // Split into two keys to satisfy both constraints simultaneously:
        //   - poolKey:  per-call unique, so parallel bridge invocations get
        //               independent WS sockets (prevents mid-turn socket
        //               collision that triggers Codex "No tool output found
        //               for function call ...").
        //   - cacheKey: provider-scoped unified (e.g. 'mixdog-codex'), fed
        //               from session.promptCacheKey via manager.mjs. The
        //               Codex handshake `session_id` header/URL +
        //               body.prompt_cache_key all carry this shared key
        //               so every role/source dispatched to this provider
        //               lands in the same server-side cache shard. Codex
        //               dedupes server-side prompt cache by the handshake
        //               session_id, so cross-session reuse requires this
        //               to be stable across invocations — role or task
        //               context must ride in the message tail, not here.
        const poolKey  = opts.sessionId || opts.promptCacheKey || null;
        const cacheKey = opts.promptCacheKey || opts.sessionId || null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        // WebSocket is the only dispatch path. Catalog refresh + 401 retry +
        // unknown-model catalog invalidation are layered around the WS call.
        try {
            const result = await sendViaWebSocket({
                auth,
                body,
                sendOpts: opts,
                onStreamDelta,
                onToolCall,
                onStageChange,
                externalSignal,
                poolKey,
                cacheKey,
                iteration,
                useModel,
                displayModel: _displayCodexModel,
            });
            // Background catalog refresh when a live response surfaces a model
            // id that isn't in our cached catalog (silent rotation guard).
            if (result?.model && !_codexCatalogHas(result.model)) {
                void this._refreshModelCache();
            }
            return result;
        } catch (err) {
            const status = err?.httpStatus;
            if (status === 401) {
                process.stderr.write(`[openai-oauth-ws] 401 — forcing refresh and retrying once over WS\n`);
                this.tokens.expires_at = 0;
                this._refreshFallbackUntil = 0;
                auth = await this.ensureAuth();
                const result = await sendViaWebSocket({
                    auth,
                    body,
                    sendOpts: opts,
                    onStreamDelta,
                    onToolCall,
                    onStageChange,
                    externalSignal,
                    poolKey,
                    cacheKey,
                    iteration,
                    useModel,
                    displayModel: _displayCodexModel,
                });
                if (result?.model && !_codexCatalogHas(result.model)) {
                    void this._refreshModelCache();
                }
                return result;
            }
            const msg = err?.message || '';
            const isUnknownModel = status === 404
                || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(msg);
            if (isUnknownModel && !opts._modelRetry) {
                process.stderr.write(`[openai-oauth-ws] unknown model — refreshing catalog + 1 retry\n`);
                await this._refreshModelCache();
                return this.send(messages, model, tools, { ...opts, _modelRetry: true });
            }
            throw err;
        }
    }
    async listModels() {
        // Dynamic lookup via Codex /backend-api/codex/models. Cached 24h.
        // Endpoint returns rich metadata (context_window, reasoning levels,
        // visibility) that is more detailed than /v1/models.
        const cached = await _loadCodexModelCache();
        if (cached) {
            _inMemoryCodexCatalog = cached.slice();
            return cached;
        }
        try {
            const auth = await this.ensureAuth();
            const url = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
            const res = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${auth.access_token}`,
                    'OpenAI-Beta': 'responses=experimental',
                    'originator': 'codex_cli_rs',
                    'chatgpt-account-id': auth.account_id || '',
                },
            });
            if (!res.ok) throw new Error(`codex list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.models) ? data.models : [];
            const normalized = items.map(m => _normalizeCodexModel(m));
            const enriched = await enrichModels(normalized);
            await _saveCodexModelCache(enriched);
            return enriched;
        } catch (err) {
            process.stderr.write(`[openai-oauth] listModels fetch failed (${err.message})\n`);
            // No fallback catalog — empty list signals the UI to show a
            // "catalog unavailable, retry" state. Codex has no equivalent to
            // Anthropic's family tokens so there's no meaningful minimal list.
            return [];
        }
    }
    // Force a catalog refresh (ignores 24h TTL). De-duped via
    // _codexRefreshInFlight so concurrent callers share one HTTP round-trip.
    async _refreshModelCache() {
        if (_codexRefreshInFlight) return _codexRefreshInFlight;
        _codexRefreshInFlight = (async () => {
            try {
                const auth = await this.ensureAuth();
                const url = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`;
                const res = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${auth.access_token}`,
                        'OpenAI-Beta': 'responses=experimental',
                        'originator': 'codex_cli_rs',
                        'chatgpt-account-id': auth.account_id || '',
                    },
                });
                if (!res.ok) throw new Error(`codex list_models ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data?.models) ? data.models : [];
                const normalized = items.map(m => _normalizeCodexModel(m));
                const enriched = await enrichModels(normalized);
                await _saveCodexModelCache(enriched);
                process.stderr.write(`[openai-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                process.stderr.write(`[openai-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _codexRefreshInFlight = null;
            }
        })();
        return _codexRefreshInFlight;
    }

    async isAvailable() {
        return this.tokens !== null;
    }
}
// --- Login flow (export for CLI use) ---
function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}
export async function loginOAuth() {
    const pkce = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', 'codex_cli_rs');
    process.stderr.write(`\n[openai-oauth] Open this URL to log in:\n${url.toString()}\n\n`);
    try {
        const { exec } = await import('child_process');
        const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${opener} "${url.toString()}"`);
    }
    catch { /* user opens manually */ }
    return new Promise((resolve) => {
        const timeout = setTimeout(() => { server.close(); resolve(null); }, 120_000);
        const server = createServer(async (req, res) => {
            const u = new URL(req.url || '/', `http://localhost:${CALLBACK_PORT}`);
            if (u.pathname !== '/auth/callback') {
                res.writeHead(404);
                res.end();
                return;
            }
            const code = u.searchParams.get('code');
            if (!code || u.searchParams.get('state') !== state) {
                res.writeHead(400);
                res.end('Invalid');
                clearTimeout(timeout);
                server.close();
                resolve(null);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Login successful!</h2></body></html>');
            clearTimeout(timeout);
            server.close();
            // Exchange code for tokens
            const tokenRes = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'authorization_code', client_id: CLIENT_ID,
                    code, code_verifier: pkce.verifier, redirect_uri: REDIRECT_URI,
                }),
            });
            if (!tokenRes.ok) {
                resolve(null);
                return;
            }
            const json = await tokenRes.json();
            if (!json.access_token || !json.refresh_token) {
                resolve(null);
                return;
            }
            const tokens = {
                access_token: json.access_token, refresh_token: json.refresh_token,
                expires_at: Date.now() + (json.expires_in || 3600) * 1000,
                account_id: extractAccountId(json.access_token),
            };
            saveTokens(tokens);
            resolve(tokens);
        });
        server.listen(CALLBACK_PORT, '127.0.0.1');
        server.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
}
