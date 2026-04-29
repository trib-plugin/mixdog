import { loadConfig, saveConfig } from './config.mjs'

function mask(key) {
  if (!key) return '  not set'
  return '  ****' + key.slice(-4)
}

function icon(key) {
  return key ? '●' : '○'
}

function statusBlock(config) {
  const c = config.rawSearch?.credentials || {}
  const providers = ['serper', 'brave', 'perplexity', 'tavily', 'firecrawl', 'xai']

  const lines = [
    '',
    '  ╭───────────────────────────────────────╮',
    '  │  mixdog-search config                   │',
    '  ╰───────────────────────────────────────╯',
    '',
    '  Search Providers',
    '  ────────────────────────────────────────',
  ]
  for (const p of providers) {
    const key = c[p]?.apiKey
    lines.push(`    ${icon(key)} ${p.padEnd(12)}${mask(key)}`)
  }
  lines.push('')
  lines.push('  Options')
  lines.push('  ────────────────────────────────────────')
  lines.push(`    priority    ${(config.rawSearch?.priority || []).join(' > ')}`)
  lines.push(`    max results ${config.rawSearch?.maxResults || 10}`)
  lines.push(`    crawl       ${config.crawl?.maxPages || 10} pages / depth ${config.crawl?.maxDepth || 1}`)
  lines.push('')
  return lines.join('\n')
}

function sectionHeader(config) {
  const c = config.rawSearch?.credentials || {}
  const total = Object.values(c).filter(x => x?.apiKey).length
  return [
    '  ╭───────────────────────────────────────╮',
    '  │  mixdog-search setup                    │',
    '  ╰───────────────────────────────────────╯',
    '',
    `    ${total > 0 ? '●' : '○'} ${total} key(s) configured`,
    '',
  ].join('\n')
}

function keysHeader(title, entries) {
  const lines = [
    '  ╭───────────────────────────────────────╮',
    `  │  ${title.padEnd(37)}│`,
    '  ╰───────────────────────────────────────╯',
    '',
    '    empty = keep current / "clear" = remove',
    '',
  ]
  for (const [name, key] of entries) {
    lines.push(`    ${icon(key)} ${name.padEnd(12)}${mask(key)}`)
  }
  return lines.join('\n')
}

function applyKeys(config, section, data) {
  const target = section === 'rawSearch' ? 'credentials' : 'profiles'
  for (const [provider, value] of Object.entries(data)) {
    if (!value || value === '') continue
    if (!config[section]) config[section] = {}
    if (!config[section][target]) config[section][target] = {}
    if (!config[section][target][provider]) config[section][target][provider] = {}
    config[section][target][provider].apiKey = value === 'clear' ? '' : value
  }
}

function save(config) {
  saveConfig(config)
}

export async function handleSetup(server) {
  const config = loadConfig()

  const step1 = await server.elicitInput({
    message: sectionHeader(config),
    requestedSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          title: 'Section',
          enum: ['search-keys', 'options', 'status'],
        },
      },
      required: ['section'],
    },
  })

  if (step1.action !== 'accept') {
    return { content: [{ type: 'text', text: statusBlock(config) }] }
  }

  const section = step1.content.section

  if (section === 'status') {
    return { content: [{ type: 'text', text: statusBlock(config) }] }
  }

  if (section === 'search-keys') {
    const c = config.rawSearch?.credentials || {}
    const result = await server.elicitInput({
      message: keysHeader('Search Provider Keys', [
        ['serper', c.serper?.apiKey], ['brave', c.brave?.apiKey],
        ['perplexity', c.perplexity?.apiKey], ['tavily', c.tavily?.apiKey],
        ['firecrawl', c.firecrawl?.apiKey], ['xai', c.xai?.apiKey],
      ]),
      requestedSchema: {
        type: 'object',
        properties: {
          serper: { type: 'string', title: 'Serper' },
          brave: { type: 'string', title: 'Brave' },
          perplexity: { type: 'string', title: 'Perplexity' },
          tavily: { type: 'string', title: 'Tavily' },
          firecrawl: { type: 'string', title: 'Firecrawl' },
          xai: { type: 'string', title: 'xAI / Grok' },
        },
      },
    })

    if (result.action === 'accept' && result.content) {
      applyKeys(config, 'rawSearch', result.content)
      save(config)
      return { content: [{ type: 'text', text: '  ✓ Search keys saved.\n' + statusBlock(loadConfig()) }] }
    }
    return { content: [{ type: 'text', text: '  ⏎ Cancelled.' }] }
  }

  if (section === 'options') {
    const result = await server.elicitInput({
      message: [
        '  ╭───────────────────────────────────────╮',
        '  │  Search Options                       │',
        '  ╰───────────────────────────────────────╯',
        '',
        `    max results  ${config.rawSearch?.maxResults || 10}`,
        `    crawl pages  ${config.crawl?.maxPages || 10}`,
        `    crawl depth  ${config.crawl?.maxDepth || 1}`,
        `    same domain  ${config.crawl?.sameDomainOnly ?? true}`,
      ].join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          maxResults: { type: 'integer', title: 'Max search results' },
          crawlMaxPages: { type: 'integer', title: 'Crawl max pages' },
          crawlMaxDepth: { type: 'integer', title: 'Crawl max depth' },
          sameDomainOnly: { type: 'boolean', title: 'Same domain only' },
        },
      },
    })

    if (result.action === 'accept' && result.content) {
      const d = result.content
      if (d.maxResults != null) { if (!config.rawSearch) config.rawSearch = {}; config.rawSearch.maxResults = d.maxResults }
      if (d.crawlMaxPages != null) { if (!config.crawl) config.crawl = {}; config.crawl.maxPages = d.crawlMaxPages }
      if (d.crawlMaxDepth != null) { if (!config.crawl) config.crawl = {}; config.crawl.maxDepth = d.crawlMaxDepth }
      if (d.sameDomainOnly != null) { if (!config.crawl) config.crawl = {}; config.crawl.sameDomainOnly = d.sameDomainOnly }
      save(config)
      return { content: [{ type: 'text', text: '  ✓ Options saved.\n' + statusBlock(loadConfig()) }] }
    }
    return { content: [{ type: 'text', text: '  ⏎ Cancelled.' }] }
  }
}
