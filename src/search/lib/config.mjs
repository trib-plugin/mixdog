import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { resolvePluginData } from '../../shared/plugin-paths.mjs'
import { readSection, updateSection, stripGeneratedMarker, CONFIG_PATH as MIXDOG_CONFIG_PATH } from '../../shared/config.mjs'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(currentDir, '..')

// Unified mode: search shares the plugin data dir with the rest of mixdog.
const SHARED_DATA_DIR = resolvePluginData()
export const DATA_DIR = fs.existsSync(SHARED_DATA_DIR) ? SHARED_DATA_DIR
  : path.join(PLUGIN_ROOT, '.mixdog-search-data')
export const CONFIG_PATH = path.join(DATA_DIR, 'search-config.json')
export const USAGE_PATH = path.join(DATA_DIR, 'usage.local.json')
export const CACHE_PATH = path.join(DATA_DIR, 'cache.local.json')
export const DEFAULT_CONFIG = {
  rawSearch: {
    priority: ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily', 'xai'],
    maxResults: 10,
    credentials: {
      serper: {
        apiKey: '',
      },
      brave: {
        apiKey: '',
      },
      perplexity: {
        apiKey: '',
      },
      firecrawl: {
        apiKey: '',
      },
      tavily: {
        apiKey: '',
      },
      xai: {
        apiKey: '',
      },
    },
  },
  requestTimeoutMs: 15000,
  crawl: {
    maxPages: 10,
    maxDepth: 2,
    sameDomainOnly: true,
  },
  siteRules: {
    'x.com': {
      search: 'xai.x_search',
      scrape: 'xai.x_search',
    },
  },
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

export function ensureDataDir() {
  ensureDir(DATA_DIR)
}

export function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    // If the file exists but parse failed, back it up before returning fallback
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, filePath + '.corrupt.' + Date.now())
        process.stderr.write(`[search-config] corrupt JSON backed up: ${filePath}\n`)
      }
    } catch {}
    return fallback
  }
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  const tmp = filePath + '.tmp.' + process.pid
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
    try {
      const fd = fs.openSync(tmp, 'r')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
    } catch {}
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

function hasKeys(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

export function saveConfig(config) {
  updateSection('search', () => stripGeneratedMarker(config) || {})
}

export function loadConfig() {
  ensureDataDir()
  let config = readSection('search')
  if (!hasKeys(config)) {
    saveConfig(DEFAULT_CONFIG)
    config = DEFAULT_CONFIG
    process.stderr.write(
      `mixdog-search: default config created in ${MIXDOG_CONFIG_PATH} (section: search)\n` +
      '  use /setup to change provider priority and crawl defaults.\n',
    )
  }
  return {
    ...DEFAULT_CONFIG,
    ...config,
    rawSearch: {
      ...DEFAULT_CONFIG.rawSearch,
      ...(config?.rawSearch || {}),
      credentials: {
        ...DEFAULT_CONFIG.rawSearch.credentials,
        ...(config?.rawSearch?.credentials || {}),
      },
    },
    crawl: {
      ...DEFAULT_CONFIG.crawl,
      ...(config?.crawl || {}),
    },
    siteRules: {
      ...DEFAULT_CONFIG.siteRules,
      ...(config?.siteRules || {}),
    },
  }
}

export function getRawSearchPriority(config) {
  return config.rawSearch?.priority || DEFAULT_CONFIG.rawSearch.priority
}

export function getRawSearchMaxResults(config) {
  return config.rawSearch?.maxResults || DEFAULT_CONFIG.rawSearch.maxResults
}

export function getRawProviderApiKey(config, provider) {
  const cred = config.rawSearch?.credentials?.[provider]
  return cred?.apiKey || ''
}

export function getRawProviderCredentialSource(config, provider, env = process.env) {
  if (getRawProviderApiKey(config, provider)) {
    return 'config'
  }

  const envKeyByProvider = {
    serper: 'SERPER_API_KEY',
    brave: 'BRAVE_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
    firecrawl: 'FIRECRAWL_API_KEY',
    tavily: 'TAVILY_API_KEY',
    xai: ['XAI_API_KEY', 'GROK_API_KEY'],
  }

  const envKey = envKeyByProvider[provider]
  if (envKey) {
    const keys = Array.isArray(envKey) ? envKey : [envKey]
    if (keys.some(k => env?.[k])) {
      return 'env'
    }
  }

  return null
}

export function getSiteRule(config, site) {
  return config.siteRules?.[site] || null
}

export function getRequestTimeoutMs(config) {
  return config.requestTimeoutMs || DEFAULT_CONFIG.requestTimeoutMs
}

export function getFirecrawlApiKey(config) {
  return getRawProviderApiKey(config, 'firecrawl') || ''
}
