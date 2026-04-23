const SERPER_ENDPOINTS = {
  web: 'https://google.serper.dev/search',
  news: 'https://google.serper.dev/news',
  images: 'https://google.serper.dev/images',
}

export const RAW_PROVIDER_IDS = ['serper', 'brave', 'perplexity', 'firecrawl', 'tavily', 'xai', 'github']

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
  github: {
    searchTypes: ['repositories', 'code', 'issues'],
    readTypes: ['file', 'repo', 'issue', 'pulls'],
    siteSearch: false,
    xContentSearch: false,
    usageSupport: {
      available: false,
      timestamps: false,
      cost: false,
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
  providers.push('github')
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

function getGithubHeaders() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'mixdog-search',
  }
  const token = process.env.GITHUB_TOKEN
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

function formatGithubReset(reset) {
  if (!reset) return 'unknown'
  const n = Number(reset)
  if (!Number.isFinite(n) || n <= 0) return 'unknown'
  try {
    return new Date(n * 1000).toISOString()
  } catch {
    return 'unknown'
  }
}

async function handleGithubError(response, context) {
  if (response.ok) return
  if (response.status === 401) {
    throw new Error(`GitHub ${context} requires authentication. Set GITHUB_TOKEN in config or environment.`)
  }
  if (response.status === 404) {
    throw new Error(`GitHub ${context}: not found (404).`)
  }
  if (response.status === 403 || response.status === 429) {
    const body = await response.text().catch(() => '')
    const headers = response.headers
    const remaining = Number(headers.get('x-ratelimit-remaining') ?? -1)
    const reset = headers.get('x-ratelimit-reset')
    const retryAfter = headers.get('retry-after')
    const bodySnippet = body.slice(0, 200)

    if (/abuse|secondary/i.test(body)) {
      const retryHint = retryAfter ? ` Retry-After: ${retryAfter}s.` : ' Back off and retry in a few minutes.'
      throw new Error(`GitHub ${context}: secondary rate limit (abuse detection).${retryHint}`)
    }
    if (remaining === 0) {
      throw new Error(`GitHub ${context}: rate limit exhausted (resets at ${formatGithubReset(reset)}). Set GITHUB_TOKEN for higher limits.`)
    }
    if (response.status === 429) {
      const retryHint = retryAfter ? ` Retry-After: ${retryAfter}s.` : ''
      throw new Error(`GitHub ${context}: 429 too many requests.${retryHint} ${bodySnippet}`)
    }
    if (/resource not accessible/i.test(body) || /must authenticate/i.test(body)) {
      throw new Error(`GitHub ${context}: 403 ${bodySnippet} — token may lack scope or repo is private.`)
    }
    throw new Error(`GitHub ${context}: 403 (unclassified) ${bodySnippet}`)
  }
  throw new Error(`GitHub ${context} failed: ${response.status}`)
}

async function runGithubRead({ owner, repo, path, ref }) {
  if (!owner || !repo || !path) {
    throw new Error('owner, repo, and path are required for GitHub file read.')
  }
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(s => encodeURIComponent(s)).join('/')}`)
  if (ref) url.searchParams.set('ref', ref)

  const response = await fetch(url, { headers: getGithubHeaders() })
  await handleGithubError(response, 'file read')

  const payload = await response.json()
  if (Array.isArray(payload)) {
    // Directory listing
    return {
      results: payload.map(item => ({
        title: item.name,
        url: item.html_url || '',
        snippet: `${item.type} — ${item.path}${item.size ? ` (${item.size} bytes)` : ''}`,
        source: 'github',
        publishedDate: null,
        provider: 'github',
      })),
      usage: null,
    }
  }
  if (payload.size > 1048576) {
    throw new Error(`File too large (${payload.size} bytes). GitHub contents API does not support files over 1 MB.`)
  }
  const content = Buffer.from(payload.content || '', 'base64').toString('utf8')
  return {
    results: [{
      title: `${payload.name} (${owner}/${repo})`,
      url: payload.html_url || '',
      snippet: content,
      source: 'github',
      publishedDate: null,
      provider: 'github',
      meta: { sha: payload.sha, size: payload.size, path: payload.path, encoding: payload.encoding },
    }],
    usage: null,
  }
}

async function runGithubRepoInfo({ owner, repo }) {
  if (!owner || !repo) {
    throw new Error('owner and repo are required for GitHub repo info.')
  }
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: getGithubHeaders(),
  })
  await handleGithubError(response, 'repo info')

  const r = await response.json()
  const metaBits = [
    Number.isFinite(Number(r.stargazers_count)) ? `stars ${r.stargazers_count}` : null,
    Number.isFinite(Number(r.forks_count)) ? `forks ${r.forks_count}` : null,
    r.language ? `language ${r.language}` : null,
    r.default_branch ? `default ${r.default_branch}` : null,
    r.license?.spdx_id ? `license ${r.license.spdx_id}` : null,
    Array.isArray(r.topics) && r.topics.length ? `topics ${r.topics.slice(0, 6).join(', ')}` : null,
    r.archived ? 'archived' : null,
  ].filter(Boolean)
  return {
    results: [{
      title: r.full_name || `${owner}/${repo}`,
      url: r.html_url || '',
      snippet: [r.description || '', metaBits.join(' · ')].filter(Boolean).join('\n'),
      source: 'github',
      publishedDate: r.updated_at || null,
      provider: 'github',
      meta: {
        stars: r.stargazers_count,
        forks: r.forks_count,
        language: r.language,
        default_branch: r.default_branch,
        open_issues: r.open_issues_count,
        license: r.license?.spdx_id || null,
        topics: r.topics || [],
        archived: r.archived,
        created_at: r.created_at,
      },
    }],
    usage: null,
  }
}

async function runGithubIssueDetail({ owner, repo, number }) {
  if (!owner || !repo || !number) {
    throw new Error('owner, repo, and number are required for GitHub issue detail.')
  }
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, {
    headers: getGithubHeaders(),
  })
  await handleGithubError(response, 'issue detail')

  const issue = await response.json()
  const metaBits = [
    issue.state ? `state ${issue.state}` : null,
    Number.isFinite(Number(issue.comments)) ? `comments ${issue.comments}` : null,
    issue.user?.login ? `author ${issue.user.login}` : null,
    issue.closed_at ? `closed ${issue.closed_at}` : null,
    Array.isArray(issue.labels) && issue.labels.length ? `labels ${(issue.labels || []).map(l => l.name || l).slice(0, 6).join(', ')}` : null,
    issue.pull_request ? 'pull request' : 'issue',
  ].filter(Boolean)
  return {
    results: [{
      title: issue.title || '',
      url: issue.html_url || '',
      snippet: [metaBits.join(' · '), issue.body || ''].filter(Boolean).join('\n'),
      source: 'github',
      publishedDate: issue.created_at || null,
      provider: 'github',
      meta: {
        state: issue.state,
        labels: (issue.labels || []).map(l => l.name || l),
        comments: issue.comments,
        user: issue.user?.login,
        is_pull_request: !!issue.pull_request,
        closed_at: issue.closed_at,
      },
    }],
    usage: null,
  }
}

async function runGithubPulls({ owner, repo, state = 'open' }) {
  if (!owner || !repo) {
    throw new Error('owner and repo are required for GitHub pulls list.')
  }
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`)
  url.searchParams.set('state', state)
  url.searchParams.set('per_page', '10')

  const response = await fetch(url, { headers: getGithubHeaders() })
  await handleGithubError(response, 'pulls list')

  const pulls = await response.json()
  return {
    results: pulls.map(pr => ({
      title: pr.title || '',
      url: pr.html_url || '',
      snippet: [
        [
          Number.isFinite(Number(pr.number)) ? `#${pr.number}` : null,
          pr.state ? `state ${pr.state}` : null,
          pr.user?.login ? `author ${pr.user.login}` : null,
          pr.head?.ref ? `head ${pr.head.ref}` : null,
          pr.base?.ref ? `base ${pr.base.ref}` : null,
          pr.draft ? 'draft' : null,
          pr.merged_at ? `merged ${pr.merged_at}` : null,
        ].filter(Boolean).join(' · '),
        (pr.body || '').slice(0, 200),
      ].filter(Boolean).join('\n'),
      source: 'github',
      publishedDate: pr.created_at || null,
      provider: 'github',
      meta: {
        number: pr.number,
        state: pr.state,
        user: pr.user?.login,
        head: pr.head?.ref,
        base: pr.base?.ref,
        draft: pr.draft,
        merged_at: pr.merged_at,
      },
    })),
    usage: null,
  }
}

async function runGithubSearch({ query, maxResults, github_type = 'repositories' }) {
  const endpoint = `https://api.github.com/search/${github_type}?q=${encodeURIComponent(query)}&per_page=${maxResults}`
  const response = await fetch(endpoint, { headers: getGithubHeaders() })

  if (response.status === 422) {
    throw new Error(`GitHub API validation error for query: ${query}`)
  }
  await handleGithubError(response, `${github_type} search`)

  const payload = await response.json()
  const items = payload?.items || []

  return items.slice(0, maxResults).map(item => {
    switch (github_type) {
      case 'code':
        return {
          title: `${item.name} in ${item.repository?.full_name || ''}`,
          url: item.html_url || '',
          snippet: item.path || '',
          source: 'github',
          publishedDate: null,
          provider: 'github',
        }
      case 'issues':
        return {
          title: item.title || '',
          url: item.html_url || '',
          snippet: (item.body || '').slice(0, 200),
          source: 'github',
          publishedDate: item.created_at || null,
          provider: 'github',
        }
      case 'repositories':
      default:
        return {
          title: item.full_name || '',
          url: item.html_url || '',
          snippet: item.description || '',
          source: 'github',
          publishedDate: item.updated_at || null,
          provider: 'github',
        }
    }
  })
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
    case 'github': {
      const ghType = args.github_type
      if (ghType === 'file') return runGithubRead(args)
      if (ghType === 'repo') return runGithubRepoInfo(args)
      if (ghType === 'issue') return runGithubIssueDetail(args)
      if (ghType === 'pulls') return runGithubPulls(args)
      return { results: await runGithubSearch(args), usage: null }
    }
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
  github_type,
  owner,
  repo,
  path,
  number,
  ref,
  state,
  minResults = 1,
}) {
  // GitHub read types don't need a search query
  const isGithubReadType = ['file', 'repo', 'issue', 'pulls'].includes(github_type)
  const query = isGithubReadType ? (keywords ? buildQuery(keywords, site) : '') : buildQuery(keywords, site)
  if (!query && !isGithubReadType) {
    throw new Error('keywords is required')
  }

  if (!providers?.length) {
    throw new Error('No raw providers are available')
  }

  const failures = []
  // Track the last empty-but-successful result so we can return it if every
  // provider comes up dry (user's query legitimately has no matches).
  let lastEmpty = null
  // GitHub read types return a single object, not a list — skip empty check.
  const enforceMin = !isGithubReadType && minResults > 0
  for (const provider of providers) {
    try {
      const searchResult = await searchWithProvider(provider, { query, type, maxResults, github_type, owner, repo, path, number, ref, state })
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
