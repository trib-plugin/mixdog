/**
 * Smart Bridge — Cache Registry (Phase D-2: provider × profile matrix)
 *
 * Each provider caches independently (Anthropic workspace+model shard,
 * OpenAI prompt_cache_key, Gemini cachedContents). Tracking a single entry
 * per profile-id — as v1 did — means a profile used across two providers
 * silently overwrites the warm state of the other. v2 indexes by
 * (profileId, provider), preserving per-shard hit/miss/TTL independently.
 *
 * Persistence: <plugin-data>/cache-registry.json. v1 files auto-migrate
 * on load.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { getPluginData } from '../config.mjs';

const REGISTRY_VERSION = 2;

function registryPath() {
    return join(getPluginData(), 'cache-registry.json');
}

function emptyRegistry() {
    return {
        version: REGISTRY_VERSION,
        // profiles: profileId → provider → entry
        //   entry = { prefixHash, createdAt, expiresAt, hitCount, missCount, systemHash }
        profiles: {},
        openaiKeys: {}, // cacheKey → { retention, lastUsedAt }
        updatedAt: new Date().toISOString(),
    };
}

// shape: profiles[profileId][provider] = { prefixHash, createdAt, ... }
function migrateV1ToV2(raw) {
    const migrated = emptyRegistry();
    migrated.openaiKeys = raw.openaiKeys || {};
    for (const [profileId, entry] of Object.entries(raw.profiles || {})) {
        if (!entry || typeof entry !== 'object') continue;
        const provider = entry.provider || 'unknown';
        const { provider: _p, ...rest } = entry;
        migrated.profiles[profileId] = { [provider]: rest };
    }
    return migrated;
}

export class CacheRegistry {
    constructor() {
        this.data = emptyRegistry();
        this.loaded = false;
        this.dirty = false;
    }

    load() {
        const path = registryPath();
        if (!existsSync(path)) {
            this.data = emptyRegistry();
            this.loaded = true;
            return;
        }
        try {
            const raw = JSON.parse(readFileSync(path, 'utf8'));
            if (raw.version === REGISTRY_VERSION) {
                this.data = {
                    version: REGISTRY_VERSION,
                    profiles: raw.profiles || {},
                    openaiKeys: raw.openaiKeys || {},
                    updatedAt: raw.updatedAt || new Date().toISOString(),
                };
            } else if (raw.version === 1 || raw.version === undefined) {
                process.stderr.write(`[cache-registry] migrating v${raw.version || '?'} → v${REGISTRY_VERSION}\n`);
                this.data = migrateV1ToV2(raw);
                this.dirty = true;
            } else {
                process.stderr.write(`[cache-registry] unknown version ${raw.version}, resetting\n`);
                this.data = emptyRegistry();
            }
        } catch (err) {
            process.stderr.write(`[cache-registry] load failed: ${err.message}\n`);
            this.data = emptyRegistry();
        }
        this.cleanupExpired();
        this.loaded = true;
    }

    save() {
        if (!this.loaded) return;
        const path = registryPath();
        try {
            mkdirSync(dirname(path), { recursive: true });
            this.data.updatedAt = new Date().toISOString();
            const tmp = path + '.tmp';
            writeFileSync(tmp, JSON.stringify(this.data, null, 2));
            renameSync(tmp, path);
            this.dirty = false;
        } catch (err) {
            process.stderr.write(`[cache-registry] save failed: ${err.message}\n`);
        }
    }

    _getEntry(profileId, provider) {
        return this.data.profiles[profileId]?.[provider] || null;
    }

    _setEntry(profileId, provider, entry) {
        if (!this.data.profiles[profileId]) this.data.profiles[profileId] = {};
        this.data.profiles[profileId][provider] = entry;
    }

    // --- Profile × provider cache warm state ---

    /**
     * Record that a (profile, provider) shard was just written to provider
     * cache. prefixContent should be deterministic (system + tools + context
     * chunks) so re-hashing produces the same hash on next run. TTL seconds
     * is provider-specific and decided by the caller.
     */
    markWarm(profileId, provider, prefixContent, ttlSeconds) {
        if (!this.loaded) this.load();
        if (!profileId || !provider) return;
        const now = Date.now();
        const prefixHash = hashContent(prefixContent);
        const existing = this._getEntry(profileId, provider);
        const samePrefix = existing && existing.prefixHash === prefixHash;
        this._setEntry(profileId, provider, {
            prefixHash,
            createdAt: samePrefix ? (existing.createdAt || now) : now,
            expiresAt: now + ttlSeconds * 1000,
            hitCount: samePrefix ? (existing.hitCount || 0) : 0,
            missCount: existing?.missCount || 0,
        });
        this.dirty = true;
    }

    /**
     * Check whether a (profile, provider) shard is still warm for the given
     * prefix content. warm=true means the caller can reuse exact prefix for
     * guaranteed cache hit on that provider.
     */
    checkWarm(profileId, provider, prefixContent) {
        if (!this.loaded) this.load();
        const entry = this._getEntry(profileId, provider);
        if (!entry) return { warm: false, expiresIn: 0, reason: 'no-entry' };
        const now = Date.now();
        if ((entry.expiresAt || 0) < now) return { warm: false, expiresIn: 0, reason: 'expired' };
        const currentHash = hashContent(prefixContent);
        if (currentHash !== entry.prefixHash) {
            return { warm: false, expiresIn: 0, reason: 'hash-mismatch' };
        }
        return { warm: true, expiresIn: entry.expiresAt - now, reason: 'warm' };
    }

    recordHit(profileId, provider) {
        const entry = this._getEntry(profileId, provider);
        if (entry) {
            entry.hitCount = (entry.hitCount || 0) + 1;
            this.dirty = true;
        }
    }

    recordMiss(profileId, provider) {
        const entry = this._getEntry(profileId, provider);
        if (entry) {
            entry.missCount = (entry.missCount || 0) + 1;
            this.dirty = true;
        }
    }

    /**
     * Invalidate a single provider shard when `provider` is given, or every
     * provider shard under that profile when omitted.
     */
    invalidate(profileId, provider) {
        if (!profileId || !this.data.profiles[profileId]) return;
        if (provider) {
            if (this.data.profiles[profileId][provider]) {
                delete this.data.profiles[profileId][provider];
                if (Object.keys(this.data.profiles[profileId]).length === 0) {
                    delete this.data.profiles[profileId];
                }
                this.dirty = true;
            }
        } else {
            delete this.data.profiles[profileId];
            this.dirty = true;
        }
    }

    // --- OpenAI cache_key tracking ---

    trackOpenAIKey(cacheKey, retention) {
        if (!this.loaded) this.load();
        this.data.openaiKeys[cacheKey] = {
            retention,
            lastUsedAt: new Date().toISOString(),
        };
        this.dirty = true;
    }

    // --- Stats & maintenance ---

    cleanupExpired() {
        if (!this.loaded) return;
        const now = Date.now();
        let removed = 0;
        for (const [profileId, providers] of Object.entries(this.data.profiles)) {
            for (const [provider, entry] of Object.entries(providers)) {
                if ((entry?.expiresAt || 0) < now) {
                    delete providers[provider];
                    removed += 1;
                }
            }
            if (Object.keys(providers).length === 0) {
                delete this.data.profiles[profileId];
            }
        }
        if (removed > 0) this.dirty = true;
    }

    /**
     * Matrix-shaped stats. profiles[profileId][provider] = { hitCount,
     * missCount, hitRate, expiresIn, prefixHash }. shardCount totals every
     * (profile, provider) pair; profileCount counts distinct profiles.
     */
    getStats() {
        if (!this.loaded) this.load();
        const now = Date.now();
        const profiles = {};
        let shardCount = 0;
        for (const [profileId, providers] of Object.entries(this.data.profiles)) {
            profiles[profileId] = {};
            for (const [provider, entry] of Object.entries(providers)) {
                const total = (entry.hitCount || 0) + (entry.missCount || 0);
                profiles[profileId][provider] = {
                    prefixHash: entry.prefixHash || null,
                    hitCount: entry.hitCount || 0,
                    missCount: entry.missCount || 0,
                    hitRate: total > 0 ? (entry.hitCount || 0) / total : 0,
                    expiresIn: Math.max(0, (entry.expiresAt || 0) - now),
                    createdAt: entry.createdAt || null,
                };
                shardCount += 1;
            }
        }
        return {
            profileCount: Object.keys(this.data.profiles).length,
            shardCount,
            profiles,
            openaiKeyCount: Object.keys(this.data.openaiKeys).length,
        };
    }

    // --- Singleton-style access (callers import a shared instance) ---

    static _shared = null;
    static shared() {
        if (!this._shared) {
            this._shared = new CacheRegistry();
            this._shared.load();
        }
        return this._shared;
    }
}

// --- Helpers ---

/**
 * Stable content hash — deterministic across runs as long as structure is identical.
 * Used to detect when a profile's prefix content has drifted.
 */
export function hashContent(content) {
    const canonical = typeof content === 'string'
        ? content
        : JSON.stringify(content, Object.keys(content || {}).sort());
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Default TTL (seconds) per cache layer. Providers pick their own; callers
 * that don't specify land on the shortest safe default.
 */
export const DEFAULT_TTL_SECONDS = {
    '1h': 3600,
    '5m': 300,
    '24h': 86400,
    in_memory: 600, // optimistic estimate
    none: 0,
};
