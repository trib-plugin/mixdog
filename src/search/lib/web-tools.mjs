import fs, { readFileSync } from 'fs'
import dns from 'dns'

import { JSDOM } from 'jsdom'
import puppeteer from 'puppeteer-core'
import { Readability } from '@mozilla/readability'


const PKG_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version } catch { return '0.0.1' } })()
import {
  noteProviderFailure,
  noteProviderSuccess,
  rankScrapeExtractors,
  rememberPreferredScrapeExtractor,
} from './state.mjs'

const DEFAULT_EXTRACTORS = ['readability', 'puppeteer', 'firecrawl']

const COMMON_BROWSER_PATHS = (() => {
  const platform = process.platform
  if (platform === 'win32') {
    return [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ]
  }
  if (platform === 'linux') {
    return [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ]
  }
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
})()

export function getScrapeCapabilities() {
  const browserAvailable = Boolean(
    (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) ||
    COMMON_BROWSER_PATHS.some(item => fs.existsSync(item)),
  )

  return {
    readability: true,
    puppeteer: browserAvailable,
    firecrawl: Boolean(process.env.FIRECRAWL_API_KEY),
  }
}

function normalizeUrl(url) {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

function assertPrivateIpv4(hostname) {
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4Match) return
  const [, a, b] = ipv4Match.map(Number)
  if (a === 127 || a === 10 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }
}

function assertPublicUrl(url) {
  const parsed = new URL(url)

  // Block dangerous protocols
  const blockedProtocols = ['file:', 'ftp:', 'data:', 'javascript:']
  if (blockedProtocols.includes(parsed.protocol)) {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTP protocol: ${parsed.protocol}`)
  }

  const hostname = parsed.hostname.toLowerCase()

  // Reject userinfo (user:pass@host) — credential-injection / SSRF vector
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked URL with userinfo credentials: ${hostname}`)
  }

  // Localhost
  if (hostname === 'localhost') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv4 private/reserved ranges
  assertPrivateIpv4(hostname)

  // Strip brackets for IPv6 analysis (URL parser stores IPv6 without brackets in .hostname)
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname

  // IPv6 loopback
  if (bare === '::1') {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv4-mapped IPv6 — ::ffff:a.b.c.d
  const mappedMatch = bare.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  if (mappedMatch) {
    assertPrivateIpv4(mappedMatch[1])
  }

  // IPv6 private (fc00::/7 — starts with fc or fd)
  if (/^f[cd]/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }

  // IPv6 link-local (fe80::/10 — starts with fe8, fe9, fea, feb)
  if (/^fe[89ab]/i.test(bare)) {
    throw new Error(`Blocked request to private address: ${hostname}`)
  }
}

async function assertResolvedIps(hostname) {
  const privatev4 = (ip) => {
    assertPrivateIpv4(ip)
  }
  const privatev6 = (ip) => {
    const lower = ip.toLowerCase()
    if (lower === '::1') {
      throw new Error(`Blocked request to private address: ${ip}`)
    }
    if (/^f[cd]/i.test(lower)) {
      throw new Error(`Blocked request to private address: ${ip}`)
    }
    if (/^fe[89ab]/i.test(lower)) {
      throw new Error(`Blocked request to private address: ${ip}`)
    }
    const mappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
    if (mappedMatch) {
      assertPrivateIpv4(mappedMatch[1])
    }
  }

  let v4Addrs = []
  try {
    v4Addrs = await dns.promises.resolve4(hostname)
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const ip of v4Addrs) {
    privatev4(ip)
  }

  let v6Addrs = []
  try {
    v6Addrs = await dns.promises.resolve6(hostname)
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const ip of v6Addrs) {
    privatev6(ip)
  }

  // Also check via OS resolver (dns.lookup) to catch cases like localhost variants,
  // numeric IP literals, and other entries the OS resolver handles differently.
  let lookupAddrs = []
  try {
    lookupAddrs = await dns.promises.lookup(hostname, { all: true })
  } catch (err) {
    if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') throw err
  }
  for (const entry of lookupAddrs) {
    if (entry.family === 4) {
      privatev4(entry.address)
    } else {
      privatev6(entry.address)
    }
  }
}

function withTimeout(controller, timeoutMs) {
  return setTimeout(() => controller.abort(), timeoutMs)
}

function buildHeaders() {
  return {
    'User-Agent': `mixdog-search/${PKG_VERSION}`,
    'Accept-Language': 'ko,en;q=0.8',
  }
}

function buildContentPayload(url, title, content, extractor, extra = {}) {
  const normalized = (content || '').trim()
  if (!normalized) {
    throw new Error(`${extractor} returned empty content`)
  }
  return {
    url,
    title: (title || '').trim(),
    content: normalized,
    excerpt: normalized.slice(0, 240),
    extractor,
    ...extra,
  }
}

function extractReadableArticle(url, html) {
  const dom = new JSDOM(html, { url })
  try {
    const reader = new Readability(dom.window.document)
    const article = reader.parse()
    if (article?.textContent?.trim()) {
      return buildContentPayload(
        url,
        article.title || dom.window.document.title || '',
        article.textContent,
        'readability',
      )
    }

    const bodyText = dom.window.document.body?.textContent?.trim() || ''
    if (!bodyText) {
      throw new Error('readability returned no readable body')
    }

    return buildContentPayload(
      url,
      dom.window.document.title || '',
      bodyText,
      'dom-text',
    )
  } finally {
    dom.window.close()
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
// Hard cap on response body size (10 MB) to prevent memory DoS from a
// hostile / misconfigured URL returning a huge body. Applied in two places:
//   1. Content-Length pre-check (cheap reject before reading bytes).
//   2. Streaming byte counter (covers chunked transfer / missing header).
const MAX_BODY_BYTES = 10 * 1024 * 1024

async function readBodyWithCap(response, maxBytes) {
  // Reject non-text content-types early; decode by content-type charset.
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType) {
    const isText = contentType.includes('text/') || contentType.includes('/html') ||
      contentType.includes('/xml') || contentType.includes('/json') ||
      contentType.includes('javascript') || contentType.includes('application/x-www-form-urlencoded')
    if (!isText) {
      throw new Error(`Blocked non-text content-type: ${contentType.split(';')[0].trim()}`)
    }
  }
  const charsetMatch = contentType.match(/charset=([\w-]+)/i)
  const charset = charsetMatch ? charsetMatch[1] : 'utf-8'

  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > maxBytes) {
    throw new Error(`response body too large: Content-Length=${contentLength} > cap=${maxBytes}`)
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    // Fallback for environments without a readable stream — post-check length.
    const text = await response.text()
    if (text.length > maxBytes) {
      throw new Error(`response body too large: ${text.length} bytes > cap=${maxBytes}`)
    }
    return text
  }
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new Error(`response body too large: received ${total}+ bytes > cap=${maxBytes}`)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
  const decoder = new TextDecoder(charset, { fatal: false })
  let text = ''
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  text += decoder.decode()
  return text
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController()
  const timer = withTimeout(controller, timeoutMs)
  const originalHost = new URL(url).hostname.replace(/^www\./, '')
  try {
    let currentUrl = url
    for (let hops = 0; ; hops++) {
      await assertResolvedIps(new URL(currentUrl).hostname)
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: buildHeaders(),
        redirect: 'manual',
      })
      if (REDIRECT_STATUSES.has(response.status)) {
        if (hops >= MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`)
        }
        const location = response.headers.get('location')
        if (!location) {
          throw new Error(`Redirect ${response.status} without Location header`)
        }
        const nextUrl = new URL(location, currentUrl).toString()
        assertPublicUrl(nextUrl)
        const nextHost = new URL(nextUrl).hostname.replace(/^www\./, '')
        if (nextHost !== originalHost) {
          throw new Error(`cross-host redirect blocked (redirected_to: ${nextUrl})`)
        }
        currentUrl = nextUrl
        continue
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      return await readBodyWithCap(response, MAX_BODY_BYTES)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function scrapeWithReadability(url, timeoutMs) {
  const html = await fetchHtml(url, timeoutMs)
  return extractReadableArticle(url, html)
}

function resolveBrowserLaunchOptions() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
  }

  for (const executablePath of COMMON_BROWSER_PATHS) {
    if (fs.existsSync(executablePath)) {
      return { executablePath }
    }
  }

  return { channel: 'chrome' }
}

// SSRF: Puppeteer follows redirects through its own network stack, so the
// initial assertPublicUrl() check is insufficient — a redirect to a private
// address (10.x, 169.254.169.254 metadata IMDS, etc.) would land before we
// re-validated finalUrl. Use request interception to validate every nav
// request URL up-front and abort before the browser issues the connection.
async function scrapeWithPuppeteer(url, timeoutMs) {
  let browser
  try {
    browser = await puppeteer.launch({
      headless: true,
      ...resolveBrowserLaunchOptions(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
  } catch (error) {
    throw new Error(`puppeteer launch failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const page = await browser.newPage()
    // Per-request SSRF gate: validate every navigation/sub-resource URL
    // before the network call goes out. assertPublicUrl throws on private
    // / blocked protocols; we abort the request on throw so the browser
    // never opens a socket to the private address.
    try {
      await page.setRequestInterception(true)
      page.on('request', async (req) => {
        try {
          const reqUrl = req.url()
          assertPublicUrl(reqUrl)
          if (req.isNavigationRequest()) {
            await assertResolvedIps(new URL(reqUrl).hostname)
          }
          req.continue()
        } catch {
          try { req.abort() } catch {}
        }
      })
    } catch {
      // If interception isn't available on this puppeteer build, fall back
      // to the post-nav assert below — strictly worse but still gated.
    }
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ko,en;q=0.8',
    })
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs,
    })
    const finalUrl = page.url()
    assertPublicUrl(finalUrl)
    await assertResolvedIps(new URL(finalUrl).hostname)
    const html = await page.content()
    if (html.length > MAX_BODY_BYTES) {
      throw new Error(`puppeteer page content too large: ${html.length} bytes > cap=${MAX_BODY_BYTES}`)
    }
    try {
      return {
        ...extractReadableArticle(url, html),
        extractor: 'puppeteer',
      }
    } catch {
      const bodyText = await page.evaluate(() => document.body?.innerText || '')
      return buildContentPayload(url, await page.title(), bodyText, 'puppeteer')
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

async function scrapeWithFirecrawl(url, timeoutMs) {
  if (!process.env.FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY is not configured')
  }

  const controller = new AbortController()
  const timer = withTimeout(controller, timeoutMs)
  try {
    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: timeoutMs,
      }),
    })

    if (!response.ok) {
      throw new Error(`Firecrawl scrape failed: ${response.status}`)
    }

    const payload = await response.json()
    let markdown = payload?.data?.markdown || payload?.markdown || ''
    const title = payload?.data?.metadata?.title || payload?.metadata?.title || ''
    // Local size cap: Firecrawl can return arbitrarily large markdown that
    // bypasses MAX_BODY_BYTES (which only gates raw fetch responses).
    // Truncate so a hostile or huge page can't flood the agent context.
    if (typeof markdown === 'string' && markdown.length > MAX_BODY_BYTES) {
      markdown = markdown.slice(0, MAX_BODY_BYTES)
        + `\n\n[firecrawl: truncated at ${MAX_BODY_BYTES} bytes]`
    }
    return buildContentPayload(url, title, markdown, 'firecrawl')
  } finally {
    clearTimeout(timer)
  }
}

async function tryExtractor(extractor, url, timeoutMs) {
  switch (extractor) {
    case 'readability':
      return scrapeWithReadability(url, timeoutMs)
    case 'puppeteer':
      return scrapeWithPuppeteer(url, timeoutMs)
    case 'firecrawl':
      return scrapeWithFirecrawl(url, timeoutMs)
    default:
      throw new Error(`Unknown extractor: ${extractor}`)
  }
}

function filterLinks(rawLinks, baseUrl, { limit = 50, sameDomainOnly = true, search }) {
  const originHost = new URL(baseUrl).host
  const items = []
  const seen = new Set()

  for (const rawLink of rawLinks) {
    const href = rawLink?.href
    if (!href) continue

    let absolute
    try {
      absolute = normalizeUrl(new URL(href, baseUrl).toString())
    } catch {
      continue
    }

    if (sameDomainOnly && new URL(absolute).host !== originHost) {
      continue
    }

    const text = (rawLink.text || '').trim()
    if (search && !absolute.includes(search) && !text.includes(search)) {
      continue
    }

    if (seen.has(absolute)) continue
    seen.add(absolute)
    items.push({ url: absolute, text })
    if (items.length >= limit) break
  }

  return items
}

function extractLinksFromHtml(baseUrl, html, options) {
  const dom = new JSDOM(html, { url: baseUrl })
  try {
    const links = Array.from(dom.window.document.querySelectorAll('a[href]')).map(link => ({
      href: link.getAttribute('href'),
      text: link.textContent || '',
    }))
    return filterLinks(links, baseUrl, options)
  } finally {
    dom.window.close()
  }
}

async function mapWithHttp(url, options, timeoutMs) {
  const html = await fetchHtml(url, timeoutMs)
  return extractLinksFromHtml(url, html, options)
}

// SSRF note: Puppeteer manages its own network stack; redirect interception
// is not practical. assertPublicUrl() on the original URL is the primary defense.
async function mapWithPuppeteer(url, options, timeoutMs) {
  let browser
  try {
    browser = await puppeteer.launch({
      headless: true,
      ...resolveBrowserLaunchOptions(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs,
    })
    const finalUrl = page.url()
    assertPublicUrl(finalUrl)
    await assertResolvedIps(new URL(finalUrl).hostname)
    const links = await page.$$eval('a[href]', nodes => nodes.map(node => ({
      href: node.getAttribute('href'),
      text: node.textContent || '',
    })))
    return filterLinks(links, url, options)
  } finally {
    await browser?.close().catch(() => {})
  }
}

export async function scrapeUrl(url, timeoutMs, usageState) {
  const normalizedUrl = normalizeUrl(url)
  const host = new URL(normalizedUrl).host
  if (host === 'x.com' || host === 'www.x.com') {
    throw new Error('x.com is not a reliable scrape target. Use ai_search with x_search instead.')
  }
  const extractors = rankScrapeExtractors(host, usageState, DEFAULT_EXTRACTORS)
  const failures = []

  for (const extractor of extractors) {
    try {
      const page = await tryExtractor(extractor, normalizedUrl, timeoutMs)
      rememberPreferredScrapeExtractor(usageState, host, extractor)
      noteProviderSuccess(usageState, extractor)
      return {
        ...page,
        triedExtractors: extractors,
        failures,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ extractor, error: message })
      noteProviderFailure(usageState, extractor, message, 60000)
    }
  }

  throw new Error(`All extractors failed for ${normalizedUrl}: ${failures.map(item => `${item.extractor}: ${item.error}`).join(' | ')}`)
}

export async function scrapeUrls(urls, timeoutMs, usageState) {
  for (const url of urls) assertPublicUrl(url)
  const settled = await Promise.allSettled(urls.map(url => scrapeUrl(url, timeoutMs, usageState)))
  return settled.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    }
    return {
      url: urls[index],
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    }
  })
}

export async function mapSite(url, { limit = 50, sameDomainOnly = true, search }, timeoutMs) {
  assertPublicUrl(url)
  const options = { limit, sameDomainOnly, search }
  try {
    const links = await mapWithHttp(url, options, timeoutMs)
    if (links.length > 0) {
      return links
    }
  } catch {
    // fall through to puppeteer
  }

  return mapWithPuppeteer(url, options, timeoutMs)
}

export async function crawlSite(
  startUrl,
  { maxPages = 10, maxDepth = 1, sameDomainOnly = true },
  timeoutMs,
  usageState,
) {
  assertPublicUrl(startUrl)
  const visited = new Set()
  const queue = [{ url: normalizeUrl(startUrl), depth: 0 }]
  const pages = []

  while (queue.length > 0 && pages.length < maxPages) {
    const current = queue.shift()
    if (!current || visited.has(current.url)) continue
    visited.add(current.url)

    try {
      const page = await scrapeUrl(current.url, timeoutMs, usageState)
      pages.push({
        url: current.url,
        depth: current.depth,
        title: page.title,
        excerpt: page.excerpt,
        extractor: page.extractor,
      })
    } catch (error) {
      pages.push({
        url: current.url,
        depth: current.depth,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    if (current.depth >= maxDepth) {
      continue
    }

    let links = []
    try {
      links = await mapSite(
        current.url,
        {
          limit: maxPages,
          sameDomainOnly,
        },
        timeoutMs,
      )
    } catch {
      links = []
    }

    for (const link of links) {
      if (!visited.has(link.url)) {
        try {
          assertPublicUrl(link.url)
        } catch {
          continue
        }
        queue.push({
          url: link.url,
          depth: current.depth + 1,
        })
      }
    }
  }

  return pages
}
