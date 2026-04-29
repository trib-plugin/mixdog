#!/usr/bin/env bun

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
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).describe('Search query string or array of queries.'),
  site: z.string().optional().describe('Restrict results to a specific domain.'),
  type: z.enum(['web', 'news', 'images']).optional().describe('Search type. Default: web.'),
  maxResults: z.number().int().min(1).max(20).optional().describe('Maximum number of results to return (1-20).'),
})

const SEARCH_EMPTY_STRING_FIELDS = ['keywords', 'site', 'type']

function normalizeSearchArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs
  const args = { ...rawArgs }
  for (const key of SEARCH_EMPTY_STRING_FIELDS) {
    const value = args[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) delete args[key]
      else args[key] = trimmed
    }
  }
  if (Array.isArray(args.keywords)) {
    const keywords = args.keywords
      .map(value => typeof value === 'string' ? value.trim() : value)
      .filter(value => typeof value === 'string' ? value.length > 0 : Boolean(value))
    if (keywords.length > 0) args.keywords = keywords
    else delete args.keywords
  }
  return args
}

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
    keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    site: z.string().optional(),
    type: z.enum(['web', 'news', 'images']).optional(),
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
  const text = formatResponse(tool, tool === 'search' ? dropInvalidSearchResults(payload) : payload)
  return {
    content: [{ type: 'text', text }],
  }
}

function isInvalidSearchResult(result) {
  const title = String(result?.title || '').trim()
  return /\bpage not found\b|\b404\b.*\bnot found\b/i.test(title)
}

function dropInvalidSearchResults(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const response = payload.response
  if (!response || typeof response !== 'object' || !Array.isArray(response.results)) return payload
  const results = response.results.filter(result => !isInvalidSearchResult(result))
  if (results.length === response.results.length) return payload
  return {
    ...payload,
    response: {
      ...response,
      results,
      droppedInvalidResults: (response.droppedInvalidResults || 0) + (response.results.length - results.length),
    },
  }
}

function buildInputSchema(zodSchema) {
  const jsonSchema = zodToJsonSchema(zodSchema, { target: 'openApi3' })
  delete jsonSchema.$schema
  return jsonSchema
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

const DOC_INDEX_MAX_BYTES = 2 * 1024 * 1024
const DOC_INDEX_MAX_FETCHES = 8
const DOC_INDEX_COMMON_PATHS = ['docs', 'api', 'reference', 'api/reference']
const DOC_INDEX_STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'can', 'com', 'doc', 'docs',
  'documentation', 'for', 'from', 'how', 'http', 'https', 'into', 'official',
  'page', 'pages', 'site', 'the', 'this', 'title', 'url', 'use', 'using', 'what',
  'when', 'where', 'which', 'with', 'www',
])

function keywordsText(keywords) {
  return Array.isArray(keywords) ? keywords.join(' ') : String(keywords || '')
}

function queryTokens(keywords) {
  const tokens = keywordsText(keywords)
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}._-]{1,}/gu) || []
  return [...new Set(tokens
    .map(token => token.replace(/^[-_.]+|[-_.]+$/g, ''))
    .filter(token => token.length >= 3 && !DOC_INDEX_STOPWORDS.has(token)))]
}

function docIndexUrlCandidates(site, keywords) {
  if (!site) return []
  let parsed
  try {
    parsed = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`)
  } catch {
    return []
  }
  const candidates = []
  const add = (url) => {
    try {
      const normalized = new URL(url).toString()
      if (!candidates.includes(normalized)) candidates.push(normalized)
    } catch {}
  }
  const pathParts = parsed.pathname.split('/').filter(Boolean)
  for (let i = pathParts.length; i >= 0; i -= 1) {
    const prefix = pathParts.slice(0, i).join('/')
    add(`${parsed.origin}${prefix ? `/${prefix}` : ''}/llms.txt`)
  }
  const docsIntent = /\b(?:api|docs?|documentation|reference)\b/i.test(keywordsText(keywords))
  if (docsIntent && pathParts.length === 0) {
    for (const prefix of DOC_INDEX_COMMON_PATHS) {
      add(`${parsed.origin}/${prefix}/llms.txt`)
    }
  }
  return candidates
}

async function fetchDocIndex(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: 'text/markdown,text/plain,text/*,*/*' },
    signal: AbortSignal.timeout(Math.min(Math.max(Number(timeoutMs) || 10_000, 1000), 10_000)),
  })
  if (!response.ok) throw new Error(`docs index fetch failed: ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > DOC_INDEX_MAX_BYTES) throw new Error(`docs index too large: ${contentLength}`)
  const text = await response.text()
  return {
    text: text.length > DOC_INDEX_MAX_BYTES ? text.slice(0, DOC_INDEX_MAX_BYTES) : text,
    url: response.url || url,
  }
}

function parseDocIndexLinks(text, sourceUrl) {
  const links = []
  const seen = new Set()
  const add = (title, rawUrl, snippet = '') => {
    if (!title || !rawUrl) return
    let url
    try {
      url = new URL(rawUrl, sourceUrl).toString()
    } catch {
      return
    }
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return
    seen.add(url)
    links.push({
      title: String(title).trim(),
      url,
      snippet: String(snippet || '').trim(),
      sourceUrl,
    })
  }

  for (const line of String(text || '').split(/\r?\n/)) {
    const item = line.match(/^\s*[-*]\s+\[([^\]]{1,180})\]\(([^)\s]+)\)\s*:?\s*(.*)$/)
    if (item) add(item[1], item[2], item[3])
  }
  const inlineRe = /\[([^\]]{1,180})\]\((https?:\/\/[^)\s]+)\)/g
  let match
  while ((match = inlineRe.exec(String(text || '')))) {
    add(match[1], match[2])
  }
  return links
}

function docLinkScore(link, tokens) {
  if (!tokens.length) return 0
  const title = String(link.title || '').toLowerCase()
  const url = String(link.url || '').toLowerCase()
  const snippet = String(link.snippet || '').toLowerCase()
  let pathname = ''
  try {
    pathname = new URL(link.url).pathname.toLowerCase()
  } catch {}
  const segments = pathname.split('/').filter(Boolean).map(part => part.replace(/\.md$/i, ''))
  let score = 0
  for (const token of tokens) {
    if (title === token || title === `${token}s` || `${title}s` === token) score += 8
    if (title.includes(token)) score += 4
    if (segments.includes(token)) score += 5
    if (segments.at(-1) === token) score += 3 + Math.max(0, 7 - segments.length)
    if (url.includes(token)) score += 2
    if (snippet.includes(token)) score += 1
  }
  if (/\.md$/i.test(pathname)) score -= 2
  return score
}

function isDocIndexLink(url) {
  try {
    return /\/llms(?:-full)?\.txt$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function hostFromUrl(url) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isBaseHost(host) {
  return host.split('.').filter(Boolean).length <= 2
}

function hostMatchesScope(host, scopedHost) {
  if (!host || !scopedHost) return false
  if (host === scopedHost) return true
  return isBaseHost(scopedHost) && host.endsWith(`.${scopedHost}`)
}

function sameDocIndexScope(url, site, fetchedIndexUrl, requestedIndexUrl) {
  const linkHost = hostFromUrl(url)
  if (!linkHost) return false
  const scopes = [
    hostFromUrl(site),
    hostFromUrl(fetchedIndexUrl),
    hostFromUrl(requestedIndexUrl),
  ].filter(Boolean)
  return scopes.some(scope => hostMatchesScope(linkHost, scope))
}

async function discoverDocsIndexResults(args, timeoutMs) {
  if (!args?.site || (args.type && args.type !== 'web')) return []
  const tokens = queryTokens(args.keywords)
  if (!tokens.length) return []

  const queue = docIndexUrlCandidates(args.site, args.keywords)
  const seenIndexes = new Set()
  const candidates = []

  while (queue.length > 0 && seenIndexes.size < DOC_INDEX_MAX_FETCHES) {
    const indexUrl = queue.shift()
    if (!indexUrl || seenIndexes.has(indexUrl)) continue
    seenIndexes.add(indexUrl)
    let index = null
    try {
      index = await fetchDocIndex(indexUrl, timeoutMs)
    } catch {
      continue
    }
    const sourceUrl = index.url || indexUrl
    const links = parseDocIndexLinks(index.text, sourceUrl)
    for (const link of links) {
      if (isDocIndexLink(link.url)) {
        if (!seenIndexes.has(link.url) && queue.length + seenIndexes.size < DOC_INDEX_MAX_FETCHES) queue.push(link.url)
        continue
      }
      if (!sameDocIndexScope(link.url, args.site, sourceUrl, indexUrl)) continue
      const score = docLinkScore(link, tokens)
      if (score <= 0) continue
      candidates.push({
        ...link,
        score,
      })
    }
  }

  const seenUrls = new Set()
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((item) => {
      if (seenUrls.has(item.url)) return false
      seenUrls.add(item.url)
      return true
    })
    .slice(0, Math.min(Number(args.maxResults) || 5, 5))
    .map(item => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet || `Matched docs index: ${item.sourceUrl}`,
      source: 'docs-index',
      provider: 'docs-index',
      publishedDate: null,
      meta: { score: item.score, sourceUrl: item.sourceUrl },
    }))
}

async function augmentSearchPayloadWithDocsIndex(payload, args, timeoutMs) {
  if (!payload || typeof payload !== 'object') return payload
  const response = payload.response
  if (!response || typeof response !== 'object' || !Array.isArray(response.results)) return payload
  const indexResults = await discoverDocsIndexResults(args, timeoutMs)
  if (!indexResults.length) return payload
  const seen = new Set()
  const results = []
  for (const result of [...indexResults, ...response.results]) {
    const url = String(result?.url || '')
    const key = url || `${result?.title || ''}\n${result?.snippet || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push(result)
  }
  return {
    ...payload,
    response: {
      ...response,
      results: results.slice(0, Math.max(Number(args.maxResults) || results.length, indexResults.length)),
      docsIndexAugmented: {
        added: indexResults.length,
        sources: [...new Set(indexResults.map(item => item.meta?.sourceUrl).filter(Boolean))],
      },
    },
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

async function _searchCore(args, { config, usageState, cacheState, timeoutMs }) {
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
    docs_index: args.site && (args.type || 'web') === 'web' ? 4 : null,
    maxResults: args.maxResults || getRawSearchMaxResults(config),
  })
  const cachedSearch = getCachedEntry(cacheState, searchCacheKey)
  if (cachedSearch) {
    return augmentSearchPayloadWithDocsIndex(
      { ...cachedSearch.payload, cache: buildCacheMeta(cachedSearch, true) },
      args,
      timeoutMs,
    )
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

    const payload = await augmentSearchPayloadWithDocsIndex(
      { tool: 'search', providers, response },
      args,
      timeoutMs,
    )
    const cachedEntry = setCachedEntry(
      cacheState,
      searchCacheKey,
      payload,
      getSearchCacheTtlMs(args.type || 'web'),
    )
    return { ...payload, cache: buildCacheMeta(cachedEntry, false) }
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
    description: 'External web / URL scrape. `query`: single NL string for one synthesized answer, or array of strings for unrelated multi-question. URL → scrape. Past memory → recall, codebase → explore.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 }], description: 'Single NL string, or array of strings for unrelated multi-question.' },
        cwd: { type: 'string', description: 'Optional workspace hint. Rarely needed.' },
        background: { type: 'boolean', description: 'Default false (sync). Set true for heavy queries to dispatch async and receive answer via channel.' },
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
        args = searchArgsSchema.parse(normalizeSearchArgs(rawArgs || {}))
      } catch (e) {
        if (e instanceof z.ZodError) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid arguments', details: e.errors }) }], isError: true }
        }
        throw e
      }
      // Fan-out: array `keywords` -> N parallel single-keyword calls,
      // grouped per-query with `### Query:` headers (mirrors memory_search).
      if (Array.isArray(args.keywords) && args.keywords.length > 1) {
        const dedupedKeywords = [...new Set(args.keywords.map(kw => String(kw || '').trim()).filter(Boolean))]
        const settled = await Promise.allSettled(
          dedupedKeywords.map(async (kw) => {
            const sub = await handleToolCall('search', { ...rawArgs, keywords: kw })
            const text = (sub.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n')
            return `### Query: ${kw}\n\n${text}`
          })
        )
        const sections = settled.map((r, i) =>
          r.status === 'fulfilled'
            ? r.value
            : `### Query: ${dedupedKeywords[i]}\n\n[error] ${r.reason?.message || r.reason}`
        )
        return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }] }
      }
      try {
        const result = await _searchCore(args, { config, usageState, cacheState, timeoutMs })
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
