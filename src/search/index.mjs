#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import fs from 'fs'
import path from 'path'
import {
  ensureDataDir,
  getFirecrawlApiKey,
  getRequestTimeoutMs,
  getRawSearchMaxResults,
  getRawProviderCredentialSource,
  getRawProviderApiKey,
  getRawSearchPriority,
  getSiteRule,
  loadConfig,
  PLUGIN_ROOT,
} from './lib/config.mjs'

function readPluginVersion() {
  try {
    const manifestPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || '0.0.1'
  } catch { return '0.0.1' }
}
const PLUGIN_VERSION = readPluginVersion()
import {
  buildCacheKey,
  buildCacheMeta,
  flushCacheState,
  getCachedEntry,
  loadCacheState,
  setCachedEntry,
} from './lib/cache.mjs'
import { fetchProviderUsageSnapshot } from './lib/provider-usage.mjs'
import {
  flushUsageState,
  loadUsageState,
  noteProviderFailure,
  noteProviderSuccess,
  rankProviders,
  rememberPreferredRawProviders,
  saveUsageState,
  updateProviderState,
} from './lib/state.mjs'
import {
  getAvailableRawProviders,
  RAW_PROVIDER_CAPABILITIES,
  runRawSearch,
} from './lib/providers.mjs'
import { crawlSite, getScrapeCapabilities, mapSite, scrapeUrls } from './lib/web-tools.mjs'
import { formatResponse } from './lib/formatter.mjs'
import { handleSetup } from './lib/setup-handler.mjs'


ensureDataDir()

const searchArgsSchema = z.object({
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional().describe('Search query string or array of queries. Required for non-GitHub-read operations.'),
  site: z.string().optional().describe('Restrict results to a specific domain (e.g. "github.com").'),
  type: z.enum(['web', 'news', 'images']).optional().describe('Search type. Default: web.'),
  github_type: z.enum(['repositories', 'code', 'issues', 'file', 'repo', 'issue', 'pulls']).optional().describe('GitHub type. Search: repositories/code/issues. Read: file (read file contents), repo (repo info), issue (issue/PR detail), pulls (PR list).'),
  owner: z.string().optional().describe('GitHub owner (org or user). Required for github_type: file, repo, issue, pulls.'),
  repo: z.string().optional().describe('GitHub repository name. Required for github_type: file, repo, issue, pulls.'),
  path: z.string().optional().describe('File path within repo. Required for github_type: file.'),
  number: z.number().int().optional().describe('Issue or PR number. Required for github_type: issue.'),
  ref: z.string().optional().describe('Git ref (branch, tag, SHA). Optional for github_type: file.'),
  state: z.enum(['open', 'closed', 'all']).optional().describe('Filter state for github_type: pulls. Default: open.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Maximum number of results to return (1-20).'),
}).refine(
  data => {
    const isGithubRead = ['file', 'repo', 'issue', 'pulls'].includes(data.github_type)
    if (isGithubRead) return true
    return !!data.keywords
  },
  { message: 'keywords is required for non-GitHub-read operations' },
)

const scrapeArgsSchema = z.object({
  urls: z.array(z.string().url()).min(1).describe('List of URLs to scrape.'),
})

const mapArgsSchema = z.object({
  url: z.string().url().describe('The page URL to discover links from.'),
  limit: z.number().int().min(1).max(200).optional().describe('Maximum number of links to return (1-200).'),
  sameDomainOnly: z.boolean().optional().describe('If true, only return links on the same domain.'),
  search: z.string().optional().describe('Filter discovered links by a search term.'),
})

const crawlArgsSchema = z.object({
  url: z.string().url().describe('Starting URL to begin crawling from.'),
  maxPages: z.number().int().min(1).max(200).optional().describe('Maximum number of pages to visit (1-200).'),
  maxDepth: z.number().int().min(0).max(5).optional().describe('Maximum link depth to follow (0-5).'),
  sameDomainOnly: z.boolean().optional().describe('If true, only follow links on the same domain.'),
})

const batchItemSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search'),
    keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    site: z.string().optional(),
    type: z.enum(['web', 'news', 'images']).optional(),
    github_type: z.enum(['repositories', 'code', 'issues', 'file', 'repo', 'issue', 'pulls']).optional(),
    owner: z.string().optional(),
    repo: z.string().optional(),
    path: z.string().optional(),
    number: z.number().int().optional(),
    ref: z.string().optional(),
    state: z.enum(['open', 'closed', 'all']).optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  z.object({
    action: z.literal('firecrawl_scrape'),
    urls: z.array(z.string().url()).min(1),
  }),
  z.object({
    action: z.literal('firecrawl_map'),
    url: z.string().url(),
    limit: z.number().int().min(1).max(200).optional(),
    sameDomainOnly: z.boolean().optional(),
    search: z.string().optional(),
  }),
])

const batchArgsSchema = z.object({
  batch: z.array(batchItemSchema).min(1).max(10),
})

function jsonText(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}

function formattedText(tool, payload) {
  const text = formatResponse(tool, payload)
  return {
    content: [{ type: 'text', text }],
  }
}

function buildInputSchema(zodSchema) {
  const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' })
  delete jsonSchema.$schema
  return jsonSchema
}

const GITHUB_CODE_KEYWORDS = /\b(function|class|import|require|package|module|npm|pip|cargo|crate|library|lib|sdk|api|source\s*code|implementation|snippet|middleware|decorator|hook)\b/
const GITHUB_REPO_KEYWORDS = /\b(repo|repository|github|project|framework|boilerplate|starter|template|toolkit|open\s*source|oss)\b/
const GITHUB_ISSUE_KEYWORDS = /\b(bug|issue|error|fix|patch|regression|crash|pr\b|pull\s*request|changelog|breaking\s*change|deprecat)/

// slug: word-chars, dots, hyphens / same again. Guard: no file extension.
// File paths like "src/foo.mjs" should NOT be treated as slugs.
const SLUG_RE = /^[\w.-]+\/[\w.-]+$/
const FILE_EXT_RE = /\.[a-z0-9]{1,6}$/i

function looksLikeGithubSlug(query) {
  const trimmed = (query || '').trim()
  if (!SLUG_RE.test(trimmed)) return false
  if (FILE_EXT_RE.test(trimmed.split('/').pop())) return false
  const [owner, repo] = trimmed.split('/')
  return owner.length > 0 && repo.length > 0
}

function inferGithubType(query) {
  if (looksLikeGithubSlug(query)) return 'repositories'
  if (GITHUB_ISSUE_KEYWORDS.test(query)) return 'issues'
  if (GITHUB_CODE_KEYWORDS.test(query)) return 'code'
  if (GITHUB_REPO_KEYWORDS.test(query)) return 'repositories'
  return null
}

function getSearchCacheTtlMs(type = 'web') {
  switch (type) {
    case 'news':
      return 20 * 60 * 1000
    case 'images':
      return 60 * 60 * 1000
    case 'web':
    default:
      return 30 * 60 * 1000
  }
}

function getScrapeCacheTtlMs(isXRoute = false) {
  return isXRoute ? 10 * 60 * 1000 : 60 * 60 * 1000
}

function buildRuntimeEnv(config) {
  return {
    ...process.env,
    ...(getRawProviderApiKey(config, 'serper')
      ? { SERPER_API_KEY: getRawProviderApiKey(config, 'serper') }
      : {}),
    ...(getRawProviderApiKey(config, 'brave')
      ? { BRAVE_API_KEY: getRawProviderApiKey(config, 'brave') }
      : {}),
    ...(getRawProviderApiKey(config, 'perplexity')
      ? { PERPLEXITY_API_KEY: getRawProviderApiKey(config, 'perplexity') }
      : {}),
    ...(getFirecrawlApiKey(config)
      ? { FIRECRAWL_API_KEY: getFirecrawlApiKey(config) }
      : {}),
    ...(getRawProviderApiKey(config, 'tavily')
      ? { TAVILY_API_KEY: getRawProviderApiKey(config, 'tavily') }
      : {}),
    ...(getRawProviderApiKey(config, 'github')
      ? { GITHUB_TOKEN: getRawProviderApiKey(config, 'github') }
      : {}),
    ...(getRawProviderApiKey(config, 'xai')
      ? { XAI_API_KEY: process.env.XAI_API_KEY || getRawProviderApiKey(config, 'xai'), GROK_API_KEY: process.env.GROK_API_KEY || getRawProviderApiKey(config, 'xai') }
      : {}),
  }
}

function normalizeCacheUrl(url) {
  try {
    return new URL(url).toString()
  } catch {
    return String(url)
  }
}

async function writeStartupSnapshot() {
  const config = loadConfig()
  const usageState = loadUsageState()
  const runtimeEnv = buildRuntimeEnv(config)
  const rawProviders = getAvailableRawProviders(runtimeEnv)
  const scrapeCapabilities = getScrapeCapabilities()

  for (const provider of rawProviders) {
    let usagePatch = null
    try {
      usagePatch = await fetchProviderUsageSnapshot(provider, runtimeEnv)
    } catch {
      usagePatch = null
    }

    updateProviderState(usageState, provider, {
      available: true,
      connection: 'api',
      source: getRawProviderCredentialSource(config, provider, process.env) || 'env',
      usageSupport: RAW_PROVIDER_CAPABILITIES[provider]?.usageSupport || null,
      ...(usagePatch || {}),
    })
  }

  updateProviderState(usageState, 'readability', {
    available: scrapeCapabilities.readability,
    connection: 'builtin',
    source: 'local',
  })

  updateProviderState(usageState, 'puppeteer', {
    available: scrapeCapabilities.puppeteer,
    connection: 'local-browser',
    source: 'local',
  })

  updateProviderState(usageState, 'firecrawl', {
    available: scrapeCapabilities.firecrawl,
    connection: 'api',
    source: getRawProviderCredentialSource(config, 'firecrawl', process.env) || 'env',
  })
}

// ── Core action implementations (shared by individual and batch handlers) ──

async function _searchCore(args, { config, usageState, cacheState }) {
  const isGithubReadType = ['file', 'repo', 'issue', 'pulls'].includes(args.github_type)
  if (isGithubReadType) {
    const response = await runRawSearch({
      ...args,
      keywords: args.keywords || '',
      providers: ['github'],
      maxResults: args.maxResults || getRawSearchMaxResults(config),
    })
    return { tool: 'search', provider: 'github', github_type: args.github_type, response }
  }

  if (!args.github_type && !args.site && args.keywords) {
    const queryLower = (Array.isArray(args.keywords) ? args.keywords.join(' ') : args.keywords).toLowerCase()
    const autoGithubType = inferGithubType(queryLower)
    if (autoGithubType) {
      try {
        const response = await runRawSearch({
          ...args,
          providers: ['github'],
          github_type: autoGithubType,
          maxResults: args.maxResults || getRawSearchMaxResults(config),
        })
        return { tool: 'search', provider: 'github', github_type: autoGithubType, autoRouted: true, response }
      } catch {
        // GitHub auto-route failed, fall through to normal search
      }
    }
  }

  const siteRule = args.site ? getSiteRule(config, args.site) : null
  if (siteRule?.search === 'xai.x_search') {
    try {
      const response = await runRawSearch({
        keywords: Array.isArray(args.keywords) ? args.keywords.join(' ') : args.keywords,
        providers: ['xai'],
        site: args.site,
        type: 'web',
        maxResults: args.maxResults || getRawSearchMaxResults(config),
      })
      noteProviderSuccess(usageState, 'xai', {
        lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
      })
      return { tool: 'search', site: 'x.com', provider: 'xai', response }
    } catch (error) {
      noteProviderFailure(usageState, 'xai', error instanceof Error ? error.message : String(error), 60000)
      const err = error instanceof Error ? error : new Error(String(error))
      err.details = { tool: 'search', site: 'x.com', provider: 'xai' }
      throw err
    }
  }

  const runtimeEnv = buildRuntimeEnv(config)
  const available = getAvailableRawProviders(runtimeEnv)
  const providers = rankProviders(
    getRawSearchPriority(config).filter(provider => available.includes(provider)),
    usageState,
    args.site,
  )

  if (!providers.length) {
    const err = new Error('No search provider available. Configure a rawSearch key.')
    err.details = { availableProviders: available }
    throw err
  }

  const searchCacheKey = buildCacheKey('search', {
    keywords: Array.isArray(args.keywords) ? [...args.keywords] : args.keywords,
    providers,
    site: args.site || null,
    type: args.type || 'web',
    github_type: args.github_type || null,
    maxResults: args.maxResults || getRawSearchMaxResults(config),
  })
  const cachedSearch = getCachedEntry(cacheState, searchCacheKey)
  if (cachedSearch) {
    return { ...cachedSearch.payload, cache: buildCacheMeta(cachedSearch, true) }
  }

  try {
    const response = await runRawSearch({
      ...args,
      providers,
      maxResults: args.maxResults || getRawSearchMaxResults(config),
    })

    noteProviderSuccess(usageState, response.usedProvider, {
      lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
    })
    for (const failure of response.failures || []) {
      noteProviderFailure(usageState, failure.provider, failure.error, 60000)
    }
    if (args.site) {
      rememberPreferredRawProviders(usageState, args.site, [response.usedProvider, ...providers.filter(item => item !== response.usedProvider)])
    }

    const cachedEntry = setCachedEntry(
      cacheState,
      searchCacheKey,
      { tool: 'search', providers, response },
      getSearchCacheTtlMs(args.type || 'web'),
    )
    return { tool: 'search', providers, response, cache: buildCacheMeta(cachedEntry, false) }
  } catch (error) {
    for (const provider of providers) {
      noteProviderFailure(usageState, provider, error instanceof Error ? error.message : String(error), 60000)
    }

    const err = error instanceof Error ? error : new Error(String(error))
    err.details = { tool: 'search', providers }
    throw err
  }
}

async function _scrapeCore(args, { config, usageState, cacheState, timeoutMs }) {
  const normalizedUrls = args.urls.map(u => normalizeCacheUrl(u))

  if (args.urls.length === 1) {
    const host = new URL(args.urls[0]).host
    const siteRule = getSiteRule(config, host)
    if (siteRule?.scrape === 'xai.x_search') {
      try {
        const xScrapeCacheKey = buildCacheKey('scrape:x', { url: normalizedUrls[0] })
        const cachedXRoute = getCachedEntry(cacheState, xScrapeCacheKey)
        if (cachedXRoute) {
          return { ...cachedXRoute.payload, cache: buildCacheMeta(cachedXRoute, true) }
        }
        const response = await runRawSearch({
          keywords: `Summarize the X post at ${args.urls[0]} and include the link.`,
          providers: ['xai'],
          site: 'x.com',
          type: 'web',
          maxResults: 3,
        })
        noteProviderSuccess(usageState, 'xai', {
          lastCostUsdTicks: response.usage?.cost_in_usd_ticks || null,
        })
        const cachedEntry = setCachedEntry(
          cacheState,
          xScrapeCacheKey,
          { tool: 'scrape', url: args.urls[0], provider: 'xai', response },
          getScrapeCacheTtlMs(true),
        )
        return { tool: 'scrape', url: args.urls[0], provider: 'xai', response, cache: buildCacheMeta(cachedEntry, false) }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        err.details = { tool: 'scrape', url: args.urls[0], provider: 'xai' }
        throw err
      }
    }
  }

  const pageByUrl = new Map()
  const cacheByUrl = new Map()
  const missingUrls = []

  for (let index = 0; index < args.urls.length; index += 1) {
    const url = args.urls[index]
    const normalizedUrl = normalizedUrls[index]
    const scrapeCacheKey = buildCacheKey('scrape:url', { url: normalizedUrl })
    const cachedPage = getCachedEntry(cacheState, scrapeCacheKey)
    if (cachedPage) {
      pageByUrl.set(normalizedUrl, cachedPage.payload.page)
      cacheByUrl.set(normalizedUrl, buildCacheMeta(cachedPage, true))
      continue
    }
    missingUrls.push({ url, normalizedUrl, scrapeCacheKey })
  }

  if (missingUrls.length > 0) {
    const fetchedPages = await scrapeUrls(
      missingUrls.map(item => item.url),
      timeoutMs,
      usageState,
    )

    fetchedPages.forEach((page, index) => {
      const target = missingUrls[index]
      if (page.error) {
        pageByUrl.set(target.normalizedUrl, page)
        return
      }
      const cachedEntry = setCachedEntry(
        cacheState,
        target.scrapeCacheKey,
        { page },
        getScrapeCacheTtlMs(false),
      )
      pageByUrl.set(target.normalizedUrl, page)
      cacheByUrl.set(target.normalizedUrl, buildCacheMeta(cachedEntry, false))
    })
  }

  const pages = normalizedUrls.map(normalizedUrl => ({
    ...pageByUrl.get(normalizedUrl),
    cache: cacheByUrl.get(normalizedUrl) || null,
  }))
  updateProviderState(usageState, 'firecrawl', {
    lastUsedAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
  })
  return { tool: 'scrape', pages }
}

async function _mapCore(args, { timeoutMs }) {
  const links = await mapSite(
    args.url,
    {
      limit: args.limit || 50,
      sameDomainOnly: args.sameDomainOnly ?? true,
      search: args.search,
    },
    timeoutMs,
  )
  return { tool: 'map', links }
}

// `search` is the single public surface — wrapped by the async search
// agent (aiWrapped) so it lines up with recall / explore. The remaining
// five (firecrawl_scrape / firecrawl_map / crawl / batch / setup) are
// `public: false`: still reachable via the module's handleToolCall and
// advertised when this module runs as a standalone MCP server, but
// excluded from the unified build-tools-manifest output so the Lead
// only sees the agent-wrapped entry point.
const toolDefinitions = [
  {
    name: 'search',
    title: 'Search',
    aiWrapped: true,
    description: 'External web search, URL scrape, GitHub code/issues/repos. `query`: single rich NL query (default — one internal agent judges multi-angle probes & synthesizes; URL → scrape, `owner/repo` → GitHub) or array of strings (N independent agents, mechanical merge, no cross-synthesis — only for genuinely unrelated asks). Lead: async (merged answer auto-pushed via channel). Role sessions: sync in-turn. Use `background:true/false` to override. Past context → `recall`, codebase → `explore`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }], description: 'Single rich NL query (default — one internal agent judges multi-angle probes & synthesizes) or array of strings (N independent agents, mechanical merge, no cross-synthesis — only for genuinely unrelated asks).' },
        cwd: { type: 'string', description: 'Optional workspace hint. Rarely needed.' },
        background: { type: 'boolean', description: 'Default: true for Lead (async + channel push), false for role sessions (sync, merged answer returned in-turn). Explicit value wins.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'firecrawl_scrape',
    title: 'Scrape',
    public: false,
    description: 'Fetch a single URL and extract its readable content as clean text or markdown. Use for known URLs when you need page content.',
    inputSchema: buildInputSchema(scrapeArgsSchema),
    annotations: { title: 'Scrape', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'firecrawl_map',
    title: 'Map',
    public: false,
    description: 'Discover all links on a given page. Returns a list of URLs found. Use to explore site structure before scraping specific pages.',
    inputSchema: buildInputSchema(mapArgsSchema),
    annotations: { title: 'Map', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'crawl',
    title: 'Crawl',
    public: false,
    description: 'Crawl a website starting from a URL, following links up to a configured depth. Collects page summaries from each visited page. Not supported in batch mode.',
    inputSchema: buildInputSchema(crawlArgsSchema),
    annotations: { title: 'Crawl', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'batch',
    title: 'Search',
    public: false,
    description: 'Execute multiple search, firecrawl_scrape, and firecrawl_map actions in a single request. Each item runs in parallel. Crawl is not supported in batch.',
    inputSchema: buildInputSchema(batchArgsSchema),
    annotations: { title: 'Search', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'setup',
    public: false,
    description: 'Open interactive setup form to configure search providers, API keys, and options.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Setup' },
  },
]

const SEARCH_INSTRUCTIONS = (() => {
  try {
    return fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'shared', '03-search.md'), 'utf8').trim();
  } catch (e) {
    process.stderr.write(`[search] rules/shared/03-search.md load failed: ${e.message}\n`);
    return '';
  }
})();

const server = new Server(
  {
    name: 'mixdog-search',
    version: PLUGIN_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SEARCH_INSTRUCTIONS,
  },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}))

async function handleToolCall(name, rawArgs) {
  const config = loadConfig()
  Object.assign(process.env, buildRuntimeEnv(config))
  const usageState = loadUsageState()
  const cacheState = loadCacheState()
  const timeoutMs = getRequestTimeoutMs(config)

  switch (name) {
    case 'search': {
      let args
      try {
        args = searchArgsSchema.parse(rawArgs || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      try {
        const result = await _searchCore(args, { config, usageState, cacheState })
        saveUsageState(usageState)
        return formattedText('search', result)
      } catch (error) {
        saveUsageState(usageState)
        const details = error.details || { tool: 'search' }
        return { ...jsonText({ ...details, error: error instanceof Error ? error.message : String(error) }), isError: true }
      }
    }

    case 'firecrawl_scrape': {
      let args
      try {
        args = scrapeArgsSchema.parse(rawArgs || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      try {
        const result = await _scrapeCore(args, { config, usageState, cacheState, timeoutMs })
        saveUsageState(usageState)
        return formattedText('scrape', result)
      } catch (error) {
        saveUsageState(usageState)
        return { ...jsonText({ tool: 'scrape', error: error instanceof Error ? error.message : String(error) }), isError: true }
      }
    }

    case 'firecrawl_map': {
      let args
      try {
        args = mapArgsSchema.parse(rawArgs || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      try {
        const result = await _mapCore(args, { timeoutMs })
        return formattedText('map', result)
      } catch (error) {
        return { ...jsonText({ tool: 'map', url: args.url, error: error instanceof Error ? error.message : String(error) }), isError: true }
      }
    }

    case 'crawl': {
      let args
      try {
        args = crawlArgsSchema.parse(rawArgs || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      try {
        const pages = await crawlSite(
          args.url,
          {
            maxPages: args.maxPages || config.crawl?.maxPages || 10,
            maxDepth: args.maxDepth ?? config.crawl?.maxDepth ?? 1,
            sameDomainOnly: args.sameDomainOnly ?? config.crawl?.sameDomainOnly ?? true,
          },
          timeoutMs,
          usageState,
        )
        saveUsageState(usageState)
        return formattedText('crawl', {
          tool: 'crawl',
          pages,
        })
      } catch (error) {
        saveUsageState(usageState)
        return { ...jsonText({
          tool: 'crawl',
          url: args.url,
          error: error instanceof Error ? error.message : String(error),
        }), isError: true }
      }
    }

    case 'batch': {
      let args
      try {
        args = batchArgsSchema.parse(rawArgs || {})
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }

      const ctx = { config, usageState, cacheState, timeoutMs }

      const batchPromises = args.batch.map(async (item, idx) => {
        try {
          switch (item.action) {
            case 'search': {
              const result = await _searchCore(item, ctx)
              return { index: idx + 1, action: 'search', status: 'success', ...result }
            }
            case 'firecrawl_scrape': {
              const result = await _scrapeCore(item, ctx)
              return { index: idx + 1, action: 'firecrawl_scrape', status: 'success', ...result }
            }
            case 'firecrawl_map': {
              const result = await _mapCore(item, ctx)
              return { index: idx + 1, action: 'firecrawl_map', status: 'success', ...result }
            }
            default:
              return { index: idx + 1, action: item.action, status: 'error', error: `Unknown action: ${item.action}` }
          }
        } catch (error) {
          return { index: idx + 1, action: item.action, status: 'error', error: error instanceof Error ? error.message : String(error) }
        }
      })

      const settled = await Promise.allSettled(batchPromises)
      const results = settled.map((outcome, idx) => {
        if (outcome.status === 'fulfilled') return outcome.value
        return { index: idx + 1, action: args.batch[idx].action, status: 'error', error: outcome.reason?.message || String(outcome.reason) }
      })

      saveUsageState(usageState)
      return formattedText('batch', { tool: 'batch', results })
    }

    case 'setup': {
      return await handleSetup(server)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

server.setRequestHandler(CallToolRequestSchema, async request => {
  return handleToolCall(request.params.name, request.params.arguments)
})

/* ── Module exports (used when imported by mixdog-unified) ── */
export { toolDefinitions as TOOL_DEFS }
export { SEARCH_INSTRUCTIONS as instructions }

export { handleToolCall }
export async function start() { await writeStartupSnapshot() }
export function stop() { flushUsageState(); flushCacheState() }
