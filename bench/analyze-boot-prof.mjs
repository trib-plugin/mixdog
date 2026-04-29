#!/usr/bin/env bun
// bench/analyze-boot-prof.mjs — V8 cpuprofile cold-boot analyzer.
//
// Usage:
//   node bench/analyze-boot-prof.mjs bench/results/boot-cpu-prof/CPU....cpuprofile
//   node bench/analyze-boot-prof.mjs <profile> --out=bench/results/boot-prof-analysis-<ISO>.md
//
// The report focuses on import-heavy cold-start profiles:
//   A. Top self-time frames
//   B. Top file/package grouped self-time
//   C. Import/require-driving call sites
//   D. server.mjs-entry main flame
//   E. Lazy-import candidates (heuristic, data-driven)

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = process.cwd()
const args = parseArgs(process.argv.slice(2))
const profilePath = args._[0]
if (!profilePath) die('usage: node bench/analyze-boot-prof.mjs <cpuprofile> [--out=<markdown>] [--server=server.mjs]')
if (!existsSync(profilePath)) die(`profile not found: ${profilePath}`)

const outPath = args.out ? String(args.out) : null
const serverNeedle = String(args.server || 'server.mjs').replace(/\\/g, '/')
const topN = Number(args.top || 20)
const fileTopN = Number(args.fileTop || 15)
const importTopN = Number(args.importTop || 10)
const candidateTopN = Number(args.candidates || 5)
const minTreeUs = Number(args.minTreeMs || 1) * 1000
const bootContextPath = args.context ? String(args.context) : null

const profileStat = statSync(profilePath)
const profile = readJson(profilePath)
validateProfile(profile)

const sampleCount = Array.isArray(profile.samples) ? profile.samples.length : 0
const sampleUs = makeSampleDurations(profile)
const totalSampledUs = sampleUs.reduce((a, b) => a + b, 0)

const nodes = new Map()
const parent = new Map()
for (const n of profile.nodes) {
  nodes.set(n.id, {
    id: n.id,
    callFrame: normalizeCallFrame(n.callFrame || {}),
    children: Array.isArray(n.children) ? n.children.slice() : [],
    hitCount: n.hitCount || 0,
  })
}
for (const n of nodes.values()) {
  for (const childId of n.children) {
    if (!parent.has(childId)) parent.set(childId, n.id)
  }
}

const selfUsByNode = new Map()
for (let i = 0; i < sampleCount; i++) {
  const id = profile.samples[i]
  selfUsByNode.set(id, (selfUsByNode.get(id) || 0) + sampleUs[i])
}
for (const id of nodes.keys()) {
  if (!selfUsByNode.has(id)) selfUsByNode.set(id, 0)
}

const subtreeMemo = new Map()
function subtreeUs(id) {
  if (subtreeMemo.has(id)) return subtreeMemo.get(id)
  const n = nodes.get(id)
  if (!n) return 0
  let us = selfUsByNode.get(id) || 0
  for (const c of n.children) us += subtreeUs(c)
  subtreeMemo.set(id, us)
  return us
}

const stackMemo = new Map()
function stackForNode(id) {
  if (stackMemo.has(id)) return stackMemo.get(id)
  const stack = []
  let cur = id
  const seen = new Set()
  while (cur != null && nodes.has(cur) && !seen.has(cur)) {
    seen.add(cur)
    stack.push(nodes.get(cur))
    cur = parent.get(cur)
  }
  stack.reverse()
  stackMemo.set(id, stack)
  return stack
}

const frameAgg = aggregateFrames()
const fileAgg = aggregateFiles()
const importSites = aggregateImportSites()
const mainFlame = buildMainFlame()
const sourceGraph = buildSourceGraph('server.mjs')
const candidates = buildLazyCandidates()
const bootContext = bootContextPath && existsSync(bootContextPath) ? safeReadJson(bootContextPath) : null
const profileWarnings = buildProfileWarnings()

const markdown = renderMarkdown()
console.log(renderConsole(markdown))
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, markdown, 'utf8')
  console.error(`\n[analyze-boot-prof] wrote ${outPath}`)
}

function aggregateFrames() {
  const m = new Map()
  for (const n of nodes.values()) {
    const us = selfUsByNode.get(n.id) || 0
    if (us <= 0) continue
    const f = n.callFrame
    const key = `${f.functionName}\t${f.url}\t${f.lineNumber}`
    let row = m.get(key)
    if (!row) {
      row = { key, functionName: f.functionName, url: f.url, lineNumber: f.lineNumber, columnNumber: f.columnNumber, selfUs: 0, nodes: 0, samples: 0 }
      m.set(key, row)
    }
    row.selfUs += us
    row.nodes++
  }
  for (let i = 0; i < sampleCount; i++) {
    const n = nodes.get(profile.samples[i])
    if (!n) continue
    const f = n.callFrame
    const key = `${f.functionName}\t${f.url}\t${f.lineNumber}`
    const row = m.get(key)
    if (row) row.samples++
  }
  return [...m.values()].sort((a, b) => b.selfUs - a.selfUs)
}

function aggregateFiles() {
  const m = new Map()
  for (const n of nodes.values()) {
    const us = selfUsByNode.get(n.id) || 0
    if (us <= 0) continue
    const g = fileGroup(n.callFrame.url)
    let row = m.get(g.key)
    if (!row) {
      row = { ...g, selfUs: 0, frames: 0, topFrames: new Map() }
      m.set(g.key, row)
    }
    row.selfUs += us
    row.frames++
    const label = frameLabel(n.callFrame)
    row.topFrames.set(label, (row.topFrames.get(label) || 0) + us)
  }
  return [...m.values()].sort((a, b) => b.selfUs - a.selfUs)
}

function aggregateImportSites() {
  const sites = new Map()
  let importUs = 0
  let importSamples = 0

  for (let i = 0; i < sampleCount; i++) {
    const leaf = profile.samples[i]
    const delta = sampleUs[i]
    const stack = stackForNode(leaf)
    const hit = findImportTransition(stack)
    if (!hit) continue
    importUs += delta
    importSamples++
    const parentFrame = hit.parent.callFrame
    const key = frameKey(parentFrame)
    let row = sites.get(key)
    if (!row) {
      row = {
        key,
        frame: parentFrame,
        selfUs: 0,
        samples: 0,
        loaderChildren: new Map(),
        examples: [],
      }
      sites.set(key, row)
    }
    row.selfUs += delta
    row.samples++
    const childLabel = shortFunction(hit.child.callFrame)
    row.loaderChildren.set(childLabel, (row.loaderChildren.get(childLabel) || 0) + delta)
    if (row.examples.length < 3) row.examples.push(stack.map(s => compactFrameLabel(s.callFrame)).join(' → '))
  }

  const rows = [...sites.values()].sort((a, b) => b.selfUs - a.selfUs)
  rows.totalImportUs = importUs
  rows.totalImportSamples = importSamples
  return rows
}

function findImportTransition(stack) {
  // Prefer the outermost transition from non-loader code into the loader. For
  // CommonJS this is usually <caller module> → require; for ESM dynamic import
  // it is <caller module> → ModuleLoader.import/loadESM. Static ESM imports may
  // legitimately point at Node's internal ModuleJob frame because V8 does not
  // preserve the source import statement as a JavaScript caller frame.
  for (let i = 1; i < stack.length; i++) {
    const child = stack[i]
    const par = stack[i - 1]
    if (isModuleLoaderFrame(child.callFrame) && !isModuleLoaderFrame(par.callFrame)) {
      return { parent: par, child }
    }
  }
  return null
}

function buildMainFlame() {
  let first = -1
  let last = -1
  for (let i = 0; i < sampleCount; i++) {
    const stack = stackForNode(profile.samples[i])
    if (stack.some(n => isServerFrame(n.callFrame))) {
      if (first < 0) first = i
      last = i
    }
  }
  if (first < 0) return { first, last, totalUs: 0, root: null }

  const root = makeTreeNode('(server.mjs entry window)')
  let totalUs = 0
  let clippedSamples = 0
  let outsideSamples = 0
  for (let i = first; i <= last; i++) {
    const delta = sampleUs[i]
    totalUs += delta
    const stack = stackForNode(profile.samples[i])
    const idx = stack.findIndex(n => isServerFrame(n.callFrame))
    let segment
    if (idx >= 0) {
      segment = stack.slice(idx).map(n => compactFrameLabel(n.callFrame))
      clippedSamples++
    } else {
      segment = ['(post-entry outside server.mjs)', ...stack.map(n => compactFrameLabel(n.callFrame))]
      outsideSamples++
    }
    addStackToTree(root, segment, delta)
  }
  return { first, last, totalUs, root, clippedSamples, outsideSamples }
}

function makeTreeNode(label) {
  return { label, totalUs: 0, selfUs: 0, children: new Map() }
}
function addStackToTree(root, labels, us) {
  root.totalUs += us
  let cur = root
  for (const label of labels) {
    let child = cur.children.get(label)
    if (!child) {
      child = makeTreeNode(label)
      cur.children.set(label, child)
    }
    child.totalUs += us
    cur = child
  }
  cur.selfUs += us
}

function buildLazyCandidates() {
  const excluded = /^(\(no url|\(program|node:|internal\/|native\/|server\.mjs$)/
  const rows = []
  for (const g of fileAgg) {
    if (rows.length >= candidateTopN * 3) break
    if (!g.selfUs || excluded.test(g.key)) continue
    if (g.kind === 'local' && /(^|\/)bench\//.test(g.key)) continue
    const trace = traceImportForGroup(g)
    rows.push({
      group: g,
      estimatedUs: g.selfUs,
      trace,
      risk: lazyRisk(g, trace),
    })
  }
  return rows.slice(0, candidateTopN)
}

function buildSourceGraph(entryRel) {
  const entryAbs = resolve(cwd, entryRel)
  const files = new Map()
  const packageSites = new Map()
  const maxFiles = 1500
  const queue = [entryAbs]
  const seen = new Set()

  while (queue.length && seen.size < maxFiles) {
    const abs = queue.shift()
    if (!abs || seen.has(abs) || !existsSync(abs)) continue
    if (!isInsideCwd(abs) || /[\\/]node_modules[\\/]/.test(abs)) continue
    seen.add(abs)
    let text
    try { text = readFileSync(abs, 'utf8') } catch { continue }
    const rel = toRel(abs)
    const imports = parseImports(text, abs)
    files.set(rel, imports)
    for (const edge of imports) {
      if (edge.kind === 'package') {
        if (!packageSites.has(edge.packageName)) packageSites.set(edge.packageName, [])
        packageSites.get(edge.packageName).push({ file: rel, line: edge.line, spec: edge.spec, via: edge.via })
      } else if (edge.kind === 'local' && edge.abs && !seen.has(edge.abs)) {
        queue.push(edge.abs)
      }
    }
  }

  return { files, packageSites, entry: toRel(entryAbs) }
}

function parseImports(text, abs) {
  const out = []
  const pushSpec = (spec, index, via) => {
    if (!spec || spec.startsWith('node:')) return
    const line = lineAt(text, index)
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('file:')) {
      const resolved = resolveLocalSpecifier(spec, abs)
      if (resolved) out.push({ kind: 'local', spec, line, via, abs: resolved, rel: toRel(resolved) })
    } else {
      out.push({ kind: 'package', spec, packageName: packageName(spec), line, via })
    }
  }

  const patterns = [
    { rx: /(?:^|[^\w$])import\s+(?:[^'"()]+?\s+from\s+)?["']([^"']+)["']/g, via: 'static import' },
    { rx: /(?:^|[^\w$])export\s+[^'"()]+?\s+from\s+["']([^"']+)["']/g, via: 're-export' },
    { rx: /(?:^|[^\w$])import\s*\(\s*["']([^"']+)["']\s*\)/g, via: 'dynamic import' },
    { rx: /(?:^|[^\w$])require\s*\(\s*["']([^"']+)["']\s*\)/g, via: 'require' },
  ]
  for (const { rx, via } of patterns) {
    for (const m of text.matchAll(rx)) pushSpec(m[1], m.index || 0, via)
  }

  // Project convention in server.mjs: loadModule('search') imports
  // src/search/index.mjs through pathToFileURL(join(PLUGIN_ROOT,...)).
  for (const m of text.matchAll(/loadModule\(\s*["']([A-Za-z0-9_-]+)["']\s*\)/g)) {
    const modName = m[1]
    const target = resolve(cwd, 'src', modName, 'index.mjs')
    if (existsSync(target)) out.push({ kind: 'local', spec: `src/${modName}/index.mjs`, line: lineAt(text, m.index || 0), via: `loadModule('${modName}')`, abs: target, rel: toRel(target) })
  }

  // Common dynamic-import idiom in this repo:
  // import(pathToFileURL(join(PLUGIN_ROOT, 'src', 'agent', ...)).href)
  for (const m of text.matchAll(/import\s*\(\s*pathToFileURL\s*\(\s*join\s*\(([^)]*?)\)\s*\)\.href\s*,?\s*\)/gs)) {
    const segments = [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1])
    if (!segments.length) continue
    const start = segments[0] === 'src' ? 0 : segments.findIndex(s => s === 'src')
    if (start < 0) continue
    const target = resolve(cwd, ...segments.slice(start))
    if (existsSync(target)) out.push({ kind: 'local', spec: segments.slice(start).join('/'), line: lineAt(text, m.index || 0), via: 'pathToFileURL dynamic import', abs: target, rel: toRel(target) })
  }

  return dedupeEdges(out)
}

function traceImportForGroup(group) {
  if (!sourceGraph || !sourceGraph.files.size) return null

  if (group.kind === 'package') {
    const sites = sourceGraph.packageSites.get(group.packageName) || []
    const best = sites[0]
    if (!best) return { found: false, note: `no local import site for package ${group.packageName} found by regex graph` }
    const chain = traceFile(best.file)
    return { found: true, packageName: group.packageName, importSite: best, chain }
  }

  if (group.kind === 'local') {
    const rel = group.key
    const chain = traceFile(rel)
    if (chain) return { found: true, importSite: { file: rel, line: null, spec: rel, via: 'local module self-time' }, chain }
    return { found: false, note: `local file ${rel} was not reached from server.mjs by the regex import graph` }
  }

  return { found: false, note: `group kind ${group.kind} is not a lazy-import target` }
}

function traceFile(targetRel) {
  const entry = sourceGraph.entry
  if (targetRel === entry) return [{ file: entry, line: 1, via: 'entry' }]
  const q = [{ file: entry, chain: [{ file: entry, line: 1, via: 'entry' }] }]
  const seen = new Set([entry])
  while (q.length) {
    const cur = q.shift()
    const edges = sourceGraph.files.get(cur.file) || []
    for (const e of edges) {
      if (e.kind !== 'local' || !e.rel) continue
      const nextChain = cur.chain.concat({ file: cur.file, line: e.line, via: e.via, spec: e.spec, target: e.rel })
      if (e.rel === targetRel) return nextChain.concat({ file: e.rel, line: 1, via: 'module' })
      if (!seen.has(e.rel)) {
        seen.add(e.rel)
        q.push({ file: e.rel, chain: nextChain.concat({ file: e.rel, line: 1, via: 'module' }) })
      }
    }
  }
  return null
}

function lazyRisk(group, trace) {
  const chainText = trace?.chain ? trace.chain.map(x => x.file).join(' → ') : ''
  const name = group.packageName || group.key
  if (/src\/agent\//.test(chainText) || /agent/.test(name)) {
    return { level: 'high', reason: 'agent load is awaited before MCP connect to seed bridge/internal tools; delaying it may change first-call availability.' }
  }
  if (/src\/search\//.test(chainText) || ['jsdom', '@mozilla/readability', 'puppeteer-core'].includes(name)) {
    return { level: 'low-medium', reason: 'search is prewarmed at boot; lazying parser/browser dependencies likely shifts cost to first search/web-read call.' }
  }
  if (/zod|@modelcontextprotocol/.test(name)) {
    return { level: 'high', reason: 'entrypoint/schema dependency used during MCP setup; lazying may affect request validation or handshake.' }
  }
  if (group.kind === 'package') return { level: 'medium', reason: 'package top-level side effects unknown; check exported singleton/init order before lazying.' }
  return { level: 'medium-high', reason: 'local module may register tools or mutate process/global state at top level; inspect init side effects first.' }
}

function buildProfileWarnings() {
  const warnings = []
  const bootP50 = Number(bootContext?.summary?.serverBootMs?.p50)
  if (Number.isFinite(bootP50) && totalSampledUs > 0 && totalSampledUs / 1000 < bootP50 * 0.5) {
    warnings.push(`sampled profile window is ${ms(totalSampledUs)} ms, far below serverBoot p50 ${bootP50} ms; this profile may be an early-exit or partial process profile.`)
  }
  if (bootContext?.cpu_prof_path) {
    const expected = slash(String(bootContext.cpu_prof_path)).split('/').pop()
    const actual = slash(profilePath).split('/').pop()
    if (expected && actual && expected !== actual) warnings.push(`boot probe context points at ${expected}, but analyzed file is ${actual}.`)
  }
  const hasExit = frameAgg.some(r => /^(exit|reallyExit)$/.test(r.functionName || ''))
  if (hasExit && mainFlame.root && mainFlame.totalUs < totalSampledUs * 0.1) {
    warnings.push('server.mjs entry window is tiny and includes process exit frames; check singleton-lock/early-exit capture before treating this as the 630 ms cold path.')
  }
  return warnings
}

function renderMarkdown() {
  const lines = []
  const titleIso = new Date().toISOString()
  lines.push(`# Boot cpuprofile analysis — ${titleIso}`)
  lines.push('')
  lines.push(`- cpuprofile: \`${profilePath}\` (${formatBytes(profileStat.size)})`)
  lines.push(`- samples: ${sampleCount.toLocaleString()} / sampled time: ${ms(totalSampledUs)} ms`)
  if (profile.startTime != null && profile.endTime != null) {
    lines.push(`- profile window: ${ms(Number(profile.endTime) - Number(profile.startTime))} ms (V8 timestamps)`)
  }
  if (bootContext?.summary?.serverBootMs) {
    lines.push(`- boot probe: serverBoot p50 ${bootContext.summary.serverBootMs.p50} ms, total p50 ${bootContext.summary.totalMs?.p50 ?? 'n/a'} ms (${bootContext.captured_at || 'no timestamp'})`)
  }
  if (profileWarnings.length) {
    lines.push('')
    lines.push('> Profile validity notes:')
    for (const w of profileWarnings) lines.push(`> - ${w}`)
  }
  lines.push('')

  lines.push('## A. Top self-time frames (top 20)')
  lines.push('')
  lines.push('| # | function | url:line | self ms | self % |')
  lines.push('|---:|---|---|---:|---:|')
  const named = frameAgg.filter(r => r.functionName && !/^\(?anonymous\)?$/.test(r.functionName))
  const topFrames = [...named, ...frameAgg.filter(r => !named.includes(r))].slice(0, 20)
  topFrames.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${escapeMd(r.functionName || '(anonymous)')}\` | ${mdCode(locationLabel(r))} | ${ms(r.selfUs)} | ${pct(r.selfUs, totalSampledUs)} |`)
  })
  lines.push('')

  lines.push('## B. Top file-grouped self-time (top 15)')
  lines.push('')
  lines.push('| # | file / package group | kind | self ms | self % | hottest frame |')
  lines.push('|---:|---|---|---:|---:|---|')
  fileAgg.slice(0, fileTopN).forEach((r, i) => {
    const hot = [...r.topFrames.entries()].sort((a, b) => b[1] - a[1])[0]
    lines.push(`| ${i + 1} | ${mdCode(r.key)} | ${r.kind} | ${ms(r.selfUs)} | ${pct(r.selfUs, totalSampledUs)} | ${hot ? `${mdCode(hot[0])} (${ms(hot[1])} ms)` : ''} |`)
  })
  lines.push('')

  lines.push('## C. Top import/require frames')
  lines.push('')
  lines.push(`Import-loader samples: ${ms(importSites.totalImportUs || 0)} ms (${pct(importSites.totalImportUs || 0, totalSampledUs)}), ${importSites.totalImportSamples || 0} samples.`)
  lines.push('')
  lines.push('| # | import-driving call site (parent frame) | loader child frames | time ms | total % | samples |')
  lines.push('|---:|---|---|---:|---:|---:|')
  importSites.slice(0, importTopN).forEach((r, i) => {
    const kids = [...r.loaderChildren.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, us]) => `${k} ${ms(us)}ms`).join('<br>')
    lines.push(`| ${i + 1} | ${mdCode(frameLabel(r.frame))} | ${kids || ''} | ${ms(r.selfUs)} | ${pct(r.selfUs, totalSampledUs)} | ${r.samples} |`)
  })
  if (!importSites.length) lines.push('| — | no import-loader transition samples found | — | 0.0 | 0.0% | 0 |')
  lines.push('')
  lines.push('Note: static ESM imports often appear under Node internal `ModuleJob` / `loadAndTranslate` frames; CJS `require()` and dynamic `import()` usually retain a useful JavaScript parent frame.')
  lines.push('')

  lines.push('## D. server.mjs 진입 이후 main flame')
  lines.push('')
  if (!mainFlame.root) {
    lines.push(`No sample stack contained \`${serverNeedle}\`; main flame could not be clipped to server.mjs.`)
  } else {
    lines.push(`- sample index window: ${mainFlame.first}..${mainFlame.last} (${mainFlame.last - mainFlame.first + 1} samples)`)
    lines.push(`- window sampled time: ${ms(mainFlame.totalUs)} ms (${pct(mainFlame.totalUs, totalSampledUs)} of profile)`)
    lines.push(`- stacks clipped at server.mjs: ${mainFlame.clippedSamples}; post-entry stacks without server.mjs: ${mainFlame.outsideSamples}`)
    lines.push('')
    lines.push('```text')
    lines.push(...renderTree(mainFlame.root, 0, 5, minTreeUs))
    lines.push('```')
  }
  lines.push('')

  lines.push('## E. 결론 / lazy-import 후보')
  lines.push('')
  lines.push('Heuristic: candidates are the hottest non-internal file/package groups, with estimated saving equal to sampled self-time for that group. This is a lower/partial bound: it does not include all descendant time that would move with a lazy boundary, and one sampled run is not a guarantee of p50 savings.')
  lines.push('')
  lines.push('| # | candidate | current import path | estimated saving | risk | rationale |')
  lines.push('|---:|---|---|---:|---|---|')
  candidates.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${mdCode(c.group.key)} | ${formatTrace(c.trace)} | ${ms(c.estimatedUs)} ms | ${c.risk.level} | ${escapeMd(c.risk.reason)} |`)
  })
  if (!candidates.length) lines.push('| — | no non-internal candidates found | — | 0.0 ms | — | — |')
  lines.push('')
  lines.push('### Script limitations')
  lines.push('')
  lines.push('- V8 CPU profiles are sampled; sub-millisecond work and short import bursts may be missed or rounded into neighboring frames.')
  lines.push('- `timeDeltas` are charged to the sampled leaf frame as self-time; async work in forked child processes is not represented in the parent process profile.')
  lines.push('- `callFrame.url` can be empty, anonymous, bundled, or Node-internal; static ESM import statements are often not recoverable as exact source lines from the profile alone.')
  lines.push('- Lazy-candidate import paths use a regex-based local import graph. Dynamic path construction beyond this repo’s common `loadModule()` / `pathToFileURL(join(...))` idioms may be missed.')
  lines.push('- Estimated savings are self-time based, not wall-clock proof; validate any lazy-import change with another boot probe/profile round.')
  lines.push('')
  return lines.join('\n')
}

function renderConsole(markdown) {
  // Keep stdout reusable: print the full markdown. The first line is a concise
  // summary for terminal use, followed by all report sections.
  return markdown
}

function renderTree(node, depth, maxDepth, miscThresholdUs) {
  const lines = []
  const indent = '  '.repeat(depth)
  if (depth === 0) {
    lines.push(`${node.label} — total ${ms(node.totalUs)}ms, self ${ms(node.selfUs)}ms`)
  }
  if (depth >= maxDepth) return lines
  const children = [...node.children.values()].sort((a, b) => b.totalUs - a.totalUs)
  const kept = []
  const misc = { count: 0, totalUs: 0, selfUs: 0 }
  for (const child of children) {
    if (child.totalUs >= miscThresholdUs || child.selfUs >= miscThresholdUs) kept.push(child)
    else {
      misc.count++
      misc.totalUs += child.totalUs
      misc.selfUs += child.selfUs
    }
  }
  for (const child of kept) {
    lines.push(`${indent}- ${child.label} — total ${ms(child.totalUs)}ms, self ${ms(child.selfUs)}ms`)
    lines.push(...renderTree(child, depth + 1, maxDepth, miscThresholdUs))
  }
  if (misc.count) lines.push(`${indent}- … + ${misc.count} misc — total ${ms(misc.totalUs)}ms, self ${ms(misc.selfUs)}ms`)
  return lines
}

function formatTrace(trace) {
  if (!trace) return 'not traced'
  if (!trace.found) return escapeMd(trace.note || 'not traced')
  const site = trace.importSite
  const siteText = site ? `${site.file}${site.line ? `:${site.line}` : ''} (${site.via}${site.spec ? ` ${site.spec}` : ''})` : 'site unknown'
  const chain = trace.chain ? trace.chain
    .filter(x => x.target || x.via === 'entry' || x.via === 'module')
    .slice(0, 8)
    .map(x => x.target ? `${x.file}:${x.line} → ${x.target}` : x.file)
    .join(' → ') : ''
  return `${mdCode(siteText)}${chain ? `<br>${escapeMd(chain)}` : ''}`
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(1)} MiB`
}

function validateProfile(p) {
  if (!p || !Array.isArray(p.nodes)) die('invalid cpuprofile: missing nodes[]')
  if (!Array.isArray(p.samples)) die('invalid cpuprofile: missing samples[]')
  if (!Array.isArray(p.timeDeltas)) die('invalid cpuprofile: missing timeDeltas[]')
}

function makeSampleDurations(p) {
  const samples = p.samples || []
  const deltas = p.timeDeltas || []
  const out = new Array(samples.length)
  if (deltas.length === samples.length) {
    for (let i = 0; i < samples.length; i++) out[i] = Number(deltas[i]) || 0
    return out
  }
  const total = Number(p.endTime) > Number(p.startTime) ? Number(p.endTime) - Number(p.startTime) : samples.length * 1000
  const each = samples.length ? total / samples.length : 0
  for (let i = 0; i < samples.length; i++) out[i] = Number(deltas[i]) || each
  return out
}

function normalizeCallFrame(cf) {
  return {
    functionName: cf.functionName || '',
    scriptId: cf.scriptId || '',
    url: normalizeUrl(cf.url || ''),
    lineNumber: Number.isFinite(cf.lineNumber) ? cf.lineNumber + 1 : 0,
    columnNumber: Number.isFinite(cf.columnNumber) ? cf.columnNumber + 1 : 0,
  }
}

function normalizeUrl(url) {
  if (!url) return ''
  let u = String(url).replace(/\\/g, '/')
  if (u.startsWith('file://')) {
    try { u = fileURLToPath(u).replace(/\\/g, '/') } catch {}
  }
  if (isInsideCwd(u)) return toRel(u)
  // Profiles captured on Windows often use lower/upper-case drive letters.
  const cwdLower = cwd.replace(/\\/g, '/').toLowerCase()
  const uLower = u.toLowerCase()
  if (uLower.startsWith(cwdLower + '/')) return u.slice(cwdLower.length + 1)
  return u
}

function isInsideCwd(p) {
  if (!p) return false
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p)
  const rel = relative(cwd, abs)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}
function toRel(p) {
  return relative(cwd, resolve(p)).replace(/\\/g, '/') || '.'
}

function fileGroup(url) {
  if (!url) return { key: '(no url / anonymous)', kind: 'unknown' }
  const clean = url.replace(/\\/g, '/')
  if (clean.startsWith('node:')) return { key: clean, kind: 'node' }
  if (/^native\s/.test(clean)) return { key: 'native', kind: 'native' }
  if (/^internal\//.test(clean)) return { key: clean.split('/').slice(0, 3).join('/'), kind: 'internal' }
  const nm = clean.match(/(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/[^/]+)|[^/]+)/)
  if (nm) return { key: nm[1], kind: 'package', packageName: nm[1] }
  if (isInsideCwd(clean) || !isAbsolute(clean)) return { key: toRel(clean), kind: 'local' }
  return { key: clean, kind: 'external-file' }
}

function packageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0]
}

function isServerFrame(f) {
  const u = (f.url || '').replace(/\\/g, '/')
  return u === serverNeedle || u.endsWith('/' + serverNeedle) || u.endsWith('/server.mjs')
}

function isModuleLoaderFrame(f) {
  const fn = f.functionName || ''
  const url = f.url || ''
  if (/^(require|loadESM|compile|loadAndTranslate)$/.test(fn)) return true
  if (/^(Module\._load|Module\._compile|Module\.load|Module\.require|ModuleLoader\.import)$/.test(fn)) return true
  if (/^(defaultLoad|defaultResolve|resolve|load|translate|createModuleJob|link|instantiate|run|evaluate)$/.test(fn) && /(?:^|\/)internal\/modules\//.test(url)) return true
  if (/(?:^|\/)internal\/modules\/(?:cjs|esm)\//.test(url) && !/^(executeUserEntryPoint|run_main)$/.test(fn)) return true
  return false
}

function frameKey(f) { return `${f.functionName}\t${f.url}\t${f.lineNumber}` }
function frameLabel(f) { return `${shortFunction(f)} ${locationLabel(f)}`.trim() }
function compactFrameLabel(f) { return `${shortFunction(f)} ${shortLocation(f)}`.trim() }
function shortFunction(f) { return f.functionName || '(anonymous)' }
function locationLabel(r) {
  const url = r.url || '(no url)'
  const line = r.lineNumber || 0
  return `${url}${line ? `:${line}` : ''}`
}
function shortLocation(f) {
  const loc = locationLabel(f)
  const nm = fileGroup(f.url)
  if (nm.kind === 'package') return `${nm.key}:${f.lineNumber || 0}`
  if (nm.kind === 'internal') return `${nm.key}:${f.lineNumber || 0}`
  if (nm.kind === 'node') return nm.key
  return loc
}

function resolveLocalSpecifier(spec, importerAbs) {
  let base
  if (spec.startsWith('file:')) {
    try { base = fileURLToPath(spec) } catch { return null }
  } else {
    base = spec.startsWith('/') ? spec : resolve(dirname(importerAbs), spec)
  }
  const candidates = []
  if (extname(base)) candidates.push(base)
  else candidates.push(base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, join(base, 'index.mjs'), join(base, 'index.js'), join(base, 'index.cjs'))
  return candidates.find(p => existsSync(p)) || null
}

function dedupeEdges(edges) {
  const seen = new Set()
  const out = []
  for (const e of edges) {
    const k = `${e.kind}:${e.spec}:${e.line}:${e.rel || e.packageName || ''}:${e.via}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) }
  catch (e) { die(`failed to read JSON ${p}: ${e.message}`) }
}
function safeReadJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function parseArgs(argv) {
  const out = { _: [] }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
    else out._.push(a)
  }
  return out
}
function ms(us) { return (Number(us || 0) / 1000).toFixed(1) }
function pct(us, totalUs) { return totalUs ? `${(100 * us / totalUs).toFixed(1)}%` : '0.0%' }
function mdCode(s) { return `\`${escapeMd(String(s || ''))}\`` }
function escapeMd(s) { return String(s).replace(/\|/g, '\\|').replace(/`/g, '\\`') }
function slash(s) { return String(s || '').replace(/\\/g, '/') }
function die(msg) { console.error(`[analyze-boot-prof] ${msg}`); process.exit(1) }
