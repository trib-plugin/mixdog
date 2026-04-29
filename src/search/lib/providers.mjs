const SERPER_ENDPOINTS = {
  web: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  images: 'https://google.serper.dev/images',
}

export const RAW_PROVIDER_IDS = ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily', 'xai']

export const RAW_PROVIDER_CAPABILITIES = {
  serper: {
    searchTypes: ['web', 'news', 'images'],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false,
    },
  },
  brave: {
    searchTypes: ['web'],
    documentedResultKinds: ['web', 'news', 'images'],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false,
    },
  },
  perplexity: {
    searchTypes: ['web'],
    extendedModes: ['academic', 'sec'],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: false,
    },
  },
  firecrawl: {
    searchTypes: ['web', 'news', 'images'],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: true,
    },
  },
  tavily: {
    searchTypes: ['web', 'news'],
    siteSearch: true,
    xContentSearch: false,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: false,
      quota: true,
    },
  },
  xai: {
    searchTypes: ['web', 'x-posts'],
    siteSearch: true,
    xContentSearch: true,
    usageSupport: {
      available: true,
      timestamps: true,
      cost: true,
      quota: false,
    },
  },
}

function normalizeKeywords(keywords) {
  if (Array.isArray(keywords)) {
    return keywords.filter(Boolean).join(' ').trim()
  }
  return String(keywords || '').trim()
}

function buildQuery(keywords, site) {
  const query = normalizeKeywords(keywords)
  if (!site) return query
  return `${query} site:${site}`.trim()
}

export function getAvailableRawProviders(env = process.env) {
  const providers = []
  if (env.SERPER_API_KEY) providers.push('serper')
  if (env.BRAVE_API_KEY) providers.push('brave')
  if (env.PERPLEXITY_API_KEY) providers.push('perplexity')
  if (env.FIRECRAWL_API_KEY) providers.push('firecrawl')
  if (env.TAVILY_API_KEY) providers.push('tavily')
  if (env.XAI_API_KEY || env.GROK_API_KEY) providers.push('xai')
  return providers
}

function inferLocale(query) {
  const hasKorean = /[가-힣]/.test(query)
  return hasKorean
    ? { country: 'KR', language: 'ko' }
    : { country: 'US', language: 'en' }
}

async function runSerperSearch({ query, type, maxResults }) {
  const endpoint = SERPER_ENDPOINTS[type] || SERPER_ENDPOINTS.web
  const locale = inferLocale(query)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.SERPER_API_KEY,
    },
    body: JSON.stringify({
      q: query,
      num: maxResults,
      gl: locale.country.toLowerCase(),
      hl: locale.language,
    }),
  })

  if (!response.ok) {
    throw new Error(`Serper request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.organic || payload?.news || payload?.images || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || item.source || '',
    url: item.link || item.imageUrl || item.url || '',
    snippet: item.snippet || item.description || '',
    source: item.source || 'serper',
    publishedDate: item.date || null,
    provider: 'serper',
  }))
}

async function runBraveSearch({ query, maxResults }) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(maxResults))

  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_API_KEY,
    },
  })

  if (!response.ok) {
    throw new Error(`Brave request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.web?.results || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || '',
    source: item.profile?.name || 'brave',
    publishedDate: item.age || null,
    provider: 'brave',
  }))
}

async function runPerplexitySearch({ query, maxResults }) {
  const locale = inferLocale(query)
  const response = await fetch('https://api.perplexity.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      max_tokens_per_page: 1024,
      country: locale.country,
    }),
  })

  if (!response.ok) {
    throw new Error(`Perplexity request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.results || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.snippet || '',
    source: 'perplexity',
    publishedDate: item.date || null,
    provider: 'perplexity',
  }))
}

async function runFirecrawlSearch({ query, type, maxResults }) {
  const locale = inferLocale(query)
  const source = type === 'images' ? 'images' : type === 'news' ? 'news' : 'web'
  const response = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      limit: maxResults,
      sources: [source],
      country: locale.country,
    }),
  })

  if (!response.ok) {
    throw new Error(`Firecrawl request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.data?.[source] || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.description || '',
    source: 'firecrawl',
    publishedDate: item.publishedDate || null,
    provider: 'firecrawl',
  }))
}

async function runTavilySearch({ query, type, maxResults }) {
  const locale = inferLocale(query)
  const topic = type === 'news' ? 'news' : 'general'
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      topic,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      country: locale.country === 'KR' ? 'south korea' : 'united states',
    }),
  })

  if (!response.ok) {
    throw new Error(`Tavily request failed: ${response.status}`)
  }

  const payload = await response.json()
  const rows = payload?.results || []
  return rows.slice(0, maxResults).map(item => ({
    title: item.title || '',
    url: item.url || '',
    snippet: item.content || '',
    source: 'tavily',
    publishedDate: item.published_date || null,
    provider: 'tavily',
  }))
}

function extractXaiSearchAnswer(payload) {
  const message = payload?.output?.find(item => item?.type === 'message')
  const text = message?.content?.find(item => item?.type === 'output_text')?.text || ''
  return text.trim()
}

function extractXaiSearchCitations(payload) {
  const citations = Array.isArray(payload?.citations) ? payload.citations : []
  return citations.map(item => ({
    title: item?.title || item?.source || 'xai',
    url: item?.url || '',
    snippet: item?.text || item?.snippet || '',
    source: item?.source || 'xai',
    publishedDate: item?.published_date || item?.date || null,
    provider: 'xai',
  }))
}

async function runXaiSearch({ query, maxResults }) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY
  if (!apiKey) {
    throw new Error('XAI_API_KEY or GROK_API_KEY is required for xai search')
  }

  const response = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-4-1-fast-reasoning',
      input: [
        {
          role: 'user',
          content: query,
        },
      ],
      tools: [{ type: 'x_search' }],
      max_turns: 2,
      tool_choice: 'required',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`xAI search failed: ${response.status} ${body}`)
  }

  const payload = await response.json()
  const citations = extractXaiSearchCitations(payload)
  if (citations.length > 0) {
    return {
      results: citations.slice(0, maxResults),
      usage: payload.usage || null,
    }
  }

  const answer = extractXaiSearchAnswer(payload)
  if (!answer) {
    throw new Error('xAI search returned no citations and no text answer')
  }

  return {
    results: [
      {
        title: 'xAI x_search summary',
        url: '',
        snippet: answer,
        source: 'xai',
        publishedDate: null,
        provider: 'xai',
      },
    ],
    usage: payload.usage || null,
  }
}

async function searchWithProvider(provider, args) {
  switch (provider) {
    case 'serper':
      return { results: await runSerperSearch(args), usage: null }
    case 'brave':
      return { results: await runBraveSearch(args), usage: null }
    case 'perplexity':
      return { results: await runPerplexitySearch(args), usage: null }
    case 'firecrawl':
      return { results: await runFirecrawlSearch(args), usage: null }
    case 'tavily':
      return { results: await runTavilySearch(args), usage: null }
    case 'xai':
      return runXaiSearch(args)
    default:
      throw new Error(`Unsupported raw provider: ${provider}`)
  }
}

export async function runRawSearch({
  keywords,
  providers,
  site,
  type = 'web',
  maxResults = 10,
  minResults = 1,
}) {
  const query = buildQuery(keywords, site)
  if (!query) {
    throw new Error('keywords is required')
  }

  if (!providers?.length) {
    throw new Error('No raw providers are available')
  }

  const failures = []
  // Track the last empty-but-successful result so we can return it if every
  // provider comes up dry (user's query legitimately has no matches).
  let lastEmpty = null
  const enforceMin = minResults > 0
  for (const provider of providers) {
    try {
      const searchResult = await searchWithProvider(provider, { query, type, maxResults })
      const resultCount = Array.isArray(searchResult.results) ? searchResult.results.length : (searchResult.results ? 1 : 0)
      if (enforceMin && resultCount < minResults) {
        failures.push({
          provider,
          error: `empty result (got ${resultCount}, minResults=${minResults})`,
        })
        lastEmpty = {
          mode: 'fallback',
          usedProvider: provider,
          query,
          results: searchResult.results,
          usage: searchResult.usage || null,
          failures: [...failures],
        }
        continue
      }
      return {
        mode: 'fallback',
        usedProvider: provider,
        query,
        results: searchResult.results,
        usage: searchResult.usage || null,
        failures,
      }
    } catch (error) {
      failures.push({
        provider,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  // If at least one provider succeeded but returned empty, don't throw —
  // hand back the last empty result. Only throw when every provider errored.
  if (lastEmpty) {
    return { ...lastEmpty, failures }
  }
  throw new Error(`All raw providers failed: ${failures.map(item => `${item.provider}: ${item.error}`).join(' | ')}`)
}
