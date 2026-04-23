/**
 * Response formatter — strips metadata, returns human-readable text.
 */

function formatSearchResults(data) {
  // data may be the full jsonText payload: { tool, providers, response, cache, ... }
  // response.results is the array we care about
  const response = data.response || data
  const results = response.results || response?.results || []

  if (!results.length) {
    return '(no search results)'
  }

  return results
    .map((r, i) => {
      const num = i + 1
      const title = r.title || '(no title)'
      const url = r.url || ''
      const date = r.publishedDate || ''
      const snippet = (r.snippet || '').trim()
      const meta = r.meta && typeof r.meta === 'object' ? r.meta : null

      const urlPart = [url, date].filter(Boolean).join(' — ')
      const lines = [`${num}. ${title}`]
      if (urlPart) lines.push(`   ${urlPart}`)
      if (snippet) lines.push(`   ${snippet}`)
      if (meta && r.provider === 'github') {
        const bits = [
          meta.number != null ? `number ${meta.number}` : null,
          meta.state ? `state ${meta.state}` : null,
          meta.user ? `author ${meta.user}` : null,
          meta.language ? `language ${meta.language}` : null,
          meta.stars != null ? `stars ${meta.stars}` : null,
          meta.forks != null ? `forks ${meta.forks}` : null,
          meta.default_branch ? `default ${meta.default_branch}` : null,
          meta.license ? `license ${meta.license}` : null,
          Array.isArray(meta.topics) && meta.topics.length ? `topics ${meta.topics.slice(0, 6).join(', ')}` : null,
          meta.head ? `head ${meta.head}` : null,
          meta.base ? `base ${meta.base}` : null,
          meta.draft === true ? 'draft' : null,
          meta.archived === true ? 'archived' : null,
          meta.is_pull_request === true ? 'pull request' : null,
          meta.comments != null ? `comments ${meta.comments}` : null,
        ].filter(Boolean)
        if (bits.length) lines.push(`   ${bits.join(' · ')}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

function formatAiSearch(data) {
  // data: { tool, provider, model, response: { answer, ... }, cache, ... }
  // or cached: { tool, site, provider, model, response: { answer, ... } }
  const response = data.response || data
  const answer = response.answer || response.stdout || ''

  // fallback case: ai_search fell back to raw search
  if (data.fallbackSource === 'search' && response.results) {
    return formatSearchResults(data)
  }

  return answer.trim() || '(no answer)'
}

function formatScrape(data) {
  // data: { tool, pages: [...] } or single-url xai variant
  const pages = data.pages || []

  // Single-url xai route: { tool, url, provider, response }
  if (data.provider === 'xai' && data.response) {
    const response = data.response
    const results = response.results || []
    if (results.length) {
      return results.map(r => (r.snippet || '').trim()).filter(Boolean).join('\n\n') || '(no content)'
    }
    return response.answer || response.stdout || '(no content)'
  }

  if (!pages.length) {
    return '(no scrape results)'
  }

  return pages
    .map(page => {
      const url = page.url || ''
      const title = page.title || ''
      const content = (page.content || page.excerpt || '').trim()
      const error = page.error

      if (error) {
        return `[${url}]\n(failed)`
      }

      const header = title ? `[${title}] ${url}` : `[${url}]`
      return `${header}\n${content || '(no content)'}`
    })
    .join('\n\n---\n\n')
}

function formatMap(data) {
  // data: { tool, links: [{ url, text }] }
  const links = data.links || []

  if (!links.length) {
    return '(no links)'
  }

  return links
    .map((link, i) => {
      const text = (link.text || '').trim()
      const url = link.url || ''
      return text ? `${i + 1}. ${text} — ${url}` : `${i + 1}. ${url}`
    })
    .join('\n')
}

function formatCrawl(data) {
  // data: { tool, pages: [{ url, depth, title, excerpt, extractor } | { url, depth, error }] }
  const pages = data.pages || []

  if (!pages.length) {
    return '(no crawl results)'
  }

  return pages
    .map(page => {
      const url = page.url || ''
      const title = page.title || ''
      const excerpt = (page.excerpt || '').trim()
      const error = page.error

      if (error) {
        return `[${url}]\n(failed)`
      }

      const header = title ? `[${title}] ${url}` : `[${url}]`
      return `${header}\n${excerpt || '(no content)'}`
    })
    .join('\n\n---\n\n')
}

function formatBatchItem(item) {
  switch (item.action) {
    case 'search':
      if (item.mode === 'ai_first' || item.mode === 'ai_only') {
        return formatAiSearch(item)
      }
      return formatSearchResults(item)
    case 'firecrawl_scrape':
      return formatScrape(item)
    case 'firecrawl_map':
      return formatMap(item)
    default:
      if (item.error) return `(error: ${item.error})`
      return JSON.stringify(item, null, 2)
  }
}

function formatBatch(data) {
  // data: { tool, results: [...] }
  const results = data.results || []

  if (!results.length) {
    return '(no batch results)'
  }

  return results
    .map((item, i) => {
      const header = `[${i + 1}] ${item.action || 'unknown'}${item.status === 'error' ? ' (error)' : ''}`
      if (item.status === 'error') {
        return `${header}\n${item.error || 'unknown error'}`
      }
      return `${header}\n${formatBatchItem(item)}`
    })
    .join('\n\n---\n\n')
}

/**
 * Format a tool response into human-readable text.
 * @param {string} tool - Tool name (search, ai_search, scrape, map, crawl, batch)
 * @param {object} rawResult - The raw result object that was previously passed to jsonText()
 * @returns {string} Formatted text
 */
export function formatResponse(tool, rawResult) {
  switch (tool) {
    case 'search':
      return formatSearchResults(rawResult)
    case 'ai_search':
      return formatAiSearch(rawResult)
    case 'scrape':
      return formatScrape(rawResult)
    case 'map':
      return formatMap(rawResult)
    case 'crawl':
      return formatCrawl(rawResult)
    case 'batch':
      return formatBatch(rawResult)
    default:
      return JSON.stringify(rawResult, null, 2)
  }
}
