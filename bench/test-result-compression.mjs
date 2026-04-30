// bench/test-result-compression.mjs
// Standalone fixture for the chained safe-compression passes added in
// `src/agent/orchestrator/tools/result-compression.mjs`.
//
// Run: node bench/test-result-compression.mjs
//
// Each case asserts a specific input → output transform OR a guard
// behaviour (allowlist skip, expand guard fallback, threshold gate).

import {
  stripAnsi,
  normalizeWhitespace,
  dedupRepeatedLines,
  collapseSeparators,
  compressToolResult,
} from '../src/agent/orchestrator/tools/result-compression.mjs'

const cases = []
const test = (name, fn) => cases.push({ name, fn })
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg ?? 'eq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
const truthy = (v, msg) => { if (!v) throw new Error(msg ?? 'truthy failed') }

// --- stripAnsi ---
test('stripAnsi: CSI color sequence removed', () => {
  eq(stripAnsi('\x1b[31mERR\x1b[0m'), 'ERR')
})
test('stripAnsi: nested SGR sequences', () => {
  eq(stripAnsi('\x1b[1;31mBOLD-RED\x1b[0m end'), 'BOLD-RED end')
})
test('stripAnsi: cursor-move sequence removed', () => {
  eq(stripAnsi('a\x1b[2Kb'), 'ab')
})
test('stripAnsi: OSC title sequence removed', () => {
  eq(stripAnsi('pre\x1b]0;title\x07post'), 'prepost')
})
test('stripAnsi: no-op on plain text', () => {
  eq(stripAnsi('plain text only'), 'plain text only')
})

// --- normalizeWhitespace ---
test('normalizeWhitespace: trailing spaces stripped', () => {
  eq(normalizeWhitespace('foo   \nbar\t\t\nbaz'), 'foo\nbar\nbaz')
})
test('normalizeWhitespace: 3+ blank lines collapsed to 2', () => {
  eq(normalizeWhitespace('a\n\n\n\nb'), 'a\n\nb')
})
test('normalizeWhitespace: 2 blank lines preserved', () => {
  eq(normalizeWhitespace('a\n\nb'), 'a\n\nb')
})
test('normalizeWhitespace: mixed trailing + multi-blank', () => {
  eq(normalizeWhitespace('foo  \n\n\n\nbar  '), 'foo\n\nbar')
})

// --- dedupRepeatedLines ---
test('dedupRepeatedLines: 7 identical long lines collapse to marker', () => {
  // Lines must be long enough that 1 line + marker (~30 chars) is
  // shorter than the original run, otherwise marker insertion grows
  // the output and the chain expand guard would (correctly) reject it.
  const line = 'identical_payload_line_with_some_padding_for_realism'
  const input = Array(7).fill(line).join('\n')
  const out = dedupRepeatedLines(input)
  truthy(out.includes('identical lines collapsed'), 'marker present')
  truthy(out.length < input.length, 'shorter than input')
})
test('dedupRepeatedLines: 5 lines stays under DEDUP_MIN_LINES, no compression', () => {
  const input = ['x', 'x', 'x', 'x', 'x'].join('\n')
  eq(dedupRepeatedLines(input), input)
})

// --- collapseSeparators ---
test('collapseSeparators: 3 identical bar lines collapse', () => {
  const bar = '========================'
  const input = `head\n${bar}\n${bar}\n${bar}\nfoot`
  const out = collapseSeparators(input)
  truthy(out.includes('separator lines collapsed'), 'marker present')
  truthy(out.length < input.length, 'shorter')
})
test('collapseSeparators: short bar (<8) ignored', () => {
  const input = '---\n---\n---'
  eq(collapseSeparators(input), input)
})
test('collapseSeparators: 2 identical bar lines preserved', () => {
  const bar = '_______________'
  const input = `${bar}\n${bar}`
  eq(collapseSeparators(input), input)
})
test('collapseSeparators: mixed bar chars not merged', () => {
  const input = '====================\n--------------------\n===================='
  eq(collapseSeparators(input), input)
})

// --- compressToolResult: tool allowlist ---
test('compressToolResult: read tool skipped (allowlist excludes file content)', () => {
  const big = 'aaa\n'.repeat(200) + '\x1b[31mcolor\x1b[0m\n'
  truthy(big.length >= 512, 'fixture above min bytes')
  const out = compressToolResult('read', null, big, null)
  eq(out, big, 'read result must be returned unchanged')
})
test('compressToolResult: bash tool processed', () => {
  const big = '\x1b[31mERROR\x1b[0m   \n'.repeat(60)
  truthy(big.length >= 512, 'fixture above min bytes')
  const out = compressToolResult('bash', null, big, null)
  truthy(out.length < big.length, 'bash output should be compressed')
  truthy(!out.includes('\x1b['), 'ANSI sequences should be gone')
})
test('compressToolResult: MCP-prefixed bash tool also processed', () => {
  const big = '\x1b[31mERROR\x1b[0m   \n'.repeat(60)
  const out = compressToolResult('mcp__plugin_mixdog_mixdog__bash', null, big, null)
  truthy(out.length < big.length, 'prefixed bash should also be compressed')
})
test('compressToolResult: edit tool skipped', () => {
  const big = 'line\n'.repeat(200)
  const out = compressToolResult('edit', null, big, null)
  eq(out, big)
})

// --- compressToolResult: thresholds + guards ---
test('compressToolResult: under min-bytes returns unchanged', () => {
  const small = 'small'
  eq(compressToolResult('bash', null, small, null), small)
})
test('compressToolResult: non-string returns unchanged', () => {
  eq(compressToolResult('bash', null, 12345, null), 12345)
  eq(compressToolResult('bash', null, null, null), null)
})
test('compressToolResult: incompressible large input returns unchanged (expand guard)', () => {
  // Long, varied ASCII with no ANSI / no trailing spaces / no blank
  // runs / no dedup / no separator runs. Result should equal input.
  const lines = []
  for (let i = 0; i < 100; i++) lines.push(`line ${i} unique content ${(i * 17) % 1000}`)
  const input = lines.join('\n')
  truthy(input.length >= 512, 'fixture above min bytes')
  const out = compressToolResult('bash', null, input, null)
  eq(out, input, 'expand guard should fall back to original')
})

// --- combined chain ---
test('chain: ANSI + trailing + dedup + separator all reduce together', () => {
  // Fixture must clear COMPRESS_MIN_BYTES (512) before compressToolResult
  // engages the chain at all.
  const bar = '=========================================='
  const block = '\x1b[32mPASS this is a longer payload line\x1b[0m   \n'.repeat(20)
  const input = [
    bar,
    bar,
    bar,
    bar,
    block,
    'tail   ',
  ].join('\n')
  truthy(input.length >= 512, `fixture above min bytes (got ${input.length})`)
  const out = compressToolResult('bash', null, input, null)
  truthy(out.length < input.length, `compressed (in=${input.length}, out=${out.length})`)
  truthy(!out.includes('\x1b['), 'ANSI gone')
  truthy(out.includes('separator lines collapsed') || out.includes('identical lines collapsed'), 'at least one collapse marker')
})

// --- run ---
let pass = 0, fail = 0
for (const c of cases) {
  try {
    c.fn()
    console.log(`PASS  ${c.name}`)
    pass++
  } catch (e) {
    console.log(`FAIL  ${c.name}\n      ${e.message}`)
    fail++
  }
}
console.log(`\n${pass}/${cases.length} passed${fail ? `, ${fail} failed` : ''}`)
process.exit(fail ? 1 : 0)
