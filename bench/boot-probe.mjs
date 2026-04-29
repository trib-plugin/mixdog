#!/usr/bin/env bun
// bench/boot-probe.mjs — MCP cold-start breakdown probe.
//
// Measures three timestamps per cold boot of `node scripts/run-mcp.mjs`:
//   T0 spawn               — child_process.spawn() returned (ts captured pre-spawn).
//   T1 server-entry        — server.mjs hit its first executable line.
//                            Method "marker": stderr line `[boot-mark] server-entry <ms>`
//                            (temporary marker added to server.mjs by this probe and
//                            removed at the end). Method "first-byte": first stdout/stderr
//                            byte from the launcher (fallback if marker fails).
//   T2 initialize_response — MCP `initialize` JSON-RPC response with id=1 received on stdout.
//
// N=5 runs, 200ms idle between runs, then optional 6th run with --cpu-prof so a
// V8 cpuprofile lands in bench/results/boot-cpu-prof/. Result JSON is written to
// bench/results/boot-probe-<ISO>.json.
//
// Usage:
//   node bench/boot-probe.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(HERE, '..')
const RUN_MCP = join(PLUGIN_ROOT, 'scripts', 'run-mcp.mjs')
const SERVER_PATH = join(PLUGIN_ROOT, 'server.mjs')
const RESULTS_DIR = join(PLUGIN_ROOT, 'bench', 'results')
const CPU_PROF_DIR = join(RESULTS_DIR, 'boot-cpu-prof')

// Use an isolated PLUGIN_DATA so we don't collide with the live mixdog
// instance's singleton lock and so deps install once into a clean dir.
const ISO_DATA = join(tmpdir(), 'mixdog-boot-probe-data')
// cpu-prof rounds use a SEPARATE isolated PLUGIN_DATA so they never collide
// with stale singleton locks from the measured 5 runs (which can otherwise
// cause the cpu-prof child to early-exit before V8 flushes the .cpuprofile).
const ISO_DATA_CPUPROF = join(tmpdir(), 'mixdog-boot-probe-cpuprof-data')

const N_RUNS = 5
const REST_MS = 200
const RUN_TIMEOUT_MS = 120_000
// Grace period (ms) AFTER initialize response is received in cpu-prof rounds.
// Without this the SIGTERM fires before V8's cpu-prof writer can flush a full
// .cpuprofile and we capture only ~200ms of the ~630ms server boot.
const CPUPROF_GRACE_MS = 1500

const MARKER_LINE =
  "process.stderr.write(`[boot-mark] server-entry ${Date.now()}\\n`); // TEMP: bench/boot-probe — remove after measurement\n"

// ── marker insertion / removal ─────────────────────────────────────────────
function insertMarker() {
  const src = readFileSync(SERVER_PATH, 'utf8')
  if (src.includes('[boot-mark] server-entry')) return { inserted: false, alreadyPresent: true }
  // Insert directly after shebang line (line 1).
  const lines = src.split('\n')
  if (!lines[0].startsWith('#!')) {
    // No shebang — insert at very top.
    lines.unshift(MARKER_LINE.replace(/\n$/, ''))
  } else {
    lines.splice(1, 0, MARKER_LINE.replace(/\n$/, ''))
  }
  writeFileSync(SERVER_PATH, lines.join('\n'))
  return { inserted: true, alreadyPresent: false }
}

function removeMarker() {
  const src = readFileSync(SERVER_PATH, 'utf8')
  if (!src.includes('[boot-mark] server-entry')) return false
  const filtered = src
    .split('\n')
    .filter((l) => !l.includes('[boot-mark] server-entry'))
    .join('\n')
  writeFileSync(SERVER_PATH, filtered)
  return true
}

// ── single run ─────────────────────────────────────────────────────────────
function runOnce(runIdx, { cpuProf = false } = {}) {
  return new Promise((resolveRun) => {
    const dataDir = cpuProf ? ISO_DATA_CPUPROF : ISO_DATA
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }
    if (cpuProf) {
      env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --cpu-prof --cpu-prof-dir=${CPU_PROF_DIR}`.trim()
    }

    const t0 = Date.now()
    const proc = spawn('node', [RUN_MCP], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: PLUGIN_ROOT,
      windowsHide: true,
    })

    let t1 = null
    let t1Method = null // 'marker' | 'first-byte'
    let t2 = null
    let stdoutBuf = ''
    let stderrBuf = ''
    let firstByteTs = null
    let initSent = false
    let timedOut = false
    let initErr = null

    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGKILL') } catch {}
    }, RUN_TIMEOUT_MS)

    function maybeSendInit() {
      if (initSent) return
      initSent = true
      const req = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'boot-probe', version: '0' },
        },
      }
      try {
        proc.stdin.write(JSON.stringify(req) + '\n')
      } catch (e) {
        initErr = `stdin write failed: ${e.message}`
      }
    }

    proc.stderr.on('data', (chunk) => {
      const now = Date.now()
      if (firstByteTs === null) firstByteTs = now
      stderrBuf += chunk.toString('utf8')
      // Look for the marker.
      if (t1 === null) {
        const m = /\[boot-mark\] server-entry (\d+)/.exec(stderrBuf)
        if (m) {
          t1 = now
          t1Method = 'marker'
          maybeSendInit()
        }
      }
    })

    proc.stdout.on('data', (chunk) => {
      const now = Date.now()
      if (firstByteTs === null) firstByteTs = now
      stdoutBuf += chunk.toString('utf8')

      // If we have not yet established T1 and stdout produces bytes, the launcher
      // is alive. We still wait for the marker; first-byte fallback is applied at
      // run end if the marker never appears.

      if (t2 === null) {
        // MCP frames are NDJSON lines on stdio transport.
        const lines = stdoutBuf.split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line)
            if (obj && obj.id === 1) {
              t2 = now
              if (cpuProf) {
                // V8 only flushes the .cpuprofile on a CLEAN exit (process.exit
                // or natural drain). SIGTERM on Node skips the writer. So:
                //   1. wait grace period for boot work to settle in the profile,
                //   2. close stdin so the MCP stdio reader sees EOF and the
                //      server self-exits cleanly,
                //   3. fall back to SIGINT (Node's default handler treats it as
                //      a clean exit and DOES flush cpu-prof) if it lingers,
                //   4. last resort SIGKILL after a generous timeout.
                setTimeout(() => {
                  try { proc.stdin.end() } catch {}
                  setTimeout(() => {
                    if (!proc.killed && proc.exitCode === null) {
                      try { proc.kill('SIGINT') } catch {}
                      setTimeout(() => {
                        if (!proc.killed && proc.exitCode === null) {
                          try { proc.kill('SIGKILL') } catch {}
                        }
                      }, 2000)
                    }
                  }, 2000)
                }, CPUPROF_GRACE_MS)
              } else {
                try { proc.kill('SIGTERM') } catch {}
              }
              break
            }
          } catch { /* partial frame */ }
        }
      }
    })

    // If we never see the marker, the launcher is still spinning up. Send the
    // initialize request opportunistically once we observe ANY launcher output
    // (marker handler also calls maybeSendInit when the marker arrives). If
    // neither appears, we still attempt to send after a short delay so the
    // measurement does not stall.
    const initFallback = setTimeout(() => maybeSendInit(), 5_000)

    proc.on('exit', () => {
      clearTimeout(timer)
      clearTimeout(initFallback)
      if (t1 === null && firstByteTs !== null) {
        t1 = firstByteTs
        t1Method = 'first-byte'
      }
      const result = {
        run: runIdx,
        t0,
        t1,
        t2,
        launcherMs: t1 != null ? t1 - t0 : null,
        serverBootMs: t1 != null && t2 != null ? t2 - t1 : null,
        totalMs: t2 != null ? t2 - t0 : null,
        timedOut,
        initErr,
        t1MethodForRun: t1Method,
      }
      resolveRun(result)
    })

    proc.on('error', (e) => {
      clearTimeout(timer)
      clearTimeout(initFallback)
      resolveRun({
        run: runIdx,
        t0,
        t1: null,
        t2: null,
        launcherMs: null,
        serverBootMs: null,
        totalMs: null,
        timedOut: false,
        initErr: `spawn error: ${e.message}`,
        t1MethodForRun: null,
      })
    })
  })
}

// ── stats helper ───────────────────────────────────────────────────────────
function summarize(values) {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return { p50: null, p95: null, mean: null, min: null, max: null, n: 0 }
  const pct = (p) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    p50: pct(50),
    p95: pct(95),
    mean: +mean.toFixed(1),
    min: xs[0],
    max: xs[xs.length - 1],
    n: xs.length,
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function findLatestCpuProf(sinceMs = 0) {
  if (!existsSync(CPU_PROF_DIR)) return null
  const candidates = readdirSync(CPU_PROF_DIR)
    .filter((f) => f.endsWith('.cpuprofile'))
    .map((f) => {
      const full = join(CPU_PROF_DIR, f)
      const st = statSync(full)
      return { f, full, mtimeMs: st.mtimeMs, sizeBytes: st.size }
    })
    .filter((c) => c.mtimeMs >= sinceMs)
  if (!candidates.length) return null
  // The cpu-prof run produces TWO .cpuprofile files: one for the launcher
  // (run-mcp.mjs, small) and one for server.mjs (large, contains the actual
  // boot hot-path). Pick the largest — that's the one we want to analyze.
  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes)
  const picked = candidates[0]
  return {
    relPath: join('bench', 'results', 'boot-cpu-prof', picked.f),
    fullPath: picked.full,
    sizeBytes: picked.sizeBytes,
    mtimeMs: picked.mtimeMs,
    allMatched: candidates.map((c) => ({ f: c.f, size: c.sizeBytes })),
  }
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true })
  mkdirSync(CPU_PROF_DIR, { recursive: true })
  mkdirSync(ISO_DATA, { recursive: true })
  mkdirSync(ISO_DATA_CPUPROF, { recursive: true })

  const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))

  console.log(`[boot-probe] using isolated PLUGIN_DATA=${ISO_DATA}`)
  console.log(`[boot-probe] cpu-prof PLUGIN_DATA=${ISO_DATA_CPUPROF}`)
  console.log('[boot-probe] inserting temp server-entry marker...')
  const mark = insertMarker()
  console.log(`[boot-probe] marker inserted=${mark.inserted} alreadyPresent=${mark.alreadyPresent}`)

  // Warmup: prime the isolated dataDir so npm install (if any) and stamp write
  // happen BEFORE the measured runs. After warmup, subsequent boots skip the
  // install path via stamp match and isolate cold-start cost cleanly.
  console.log('[boot-probe] warmup run (priming deps in isolated data dir)...')
  const warm = await runOnce(0)
  console.log(`  warmup: launcher=${warm.launcherMs}ms server=${warm.serverBootMs}ms total=${warm.totalMs}ms ` +
              `t1Method=${warm.t1MethodForRun}${warm.timedOut ? ' [TIMED OUT]' : ''}`)
  await sleep(REST_MS)

  const runs = []
  let t1Method = 'marker' // optimistic — downgraded if any run falls back
  let cpuProfSinceMs = 0

  try {
    for (let i = 1; i <= N_RUNS; i++) {
      console.log(`[boot-probe] run ${i}/${N_RUNS} ...`)
      const r = await runOnce(i)
      console.log(`  t0=${r.t0} t1=${r.t1} t2=${r.t2} launcher=${r.launcherMs}ms server=${r.serverBootMs}ms total=${r.totalMs}ms ` +
                  `t1Method=${r.t1MethodForRun}${r.timedOut ? ' [TIMED OUT]' : ''}${r.initErr ? ` [err: ${r.initErr}]` : ''}`)
      if (r.t1MethodForRun === 'first-byte') t1Method = 'first-byte'
      runs.push(r)
      if (i < N_RUNS) await sleep(REST_MS)
    }

    // Optional cpu-prof run (does not affect summary).
    console.log('[boot-probe] running cpu-prof capture (1x)...')
    cpuProfSinceMs = Date.now()
    const profRun = await runOnce(N_RUNS + 1, { cpuProf: true })
    console.log(`  cpu-prof: total=${profRun.totalMs}ms${profRun.timedOut ? ' [TIMED OUT]' : ''}`)
  } finally {
    console.log('[boot-probe] removing temp server-entry marker...')
    const removed = removeMarker()
    console.log(`[boot-probe] marker removed=${removed}`)
    // Sanity check: ensure no marker remains.
    const after = readFileSync(SERVER_PATH, 'utf8')
    if (after.includes('[boot-mark] server-entry')) {
      console.error('[boot-probe] WARNING: marker still present in server.mjs!')
    }
  }

  const summary = {
    launcherMs: summarize(runs.map((r) => r.launcherMs)),
    serverBootMs: summarize(runs.map((r) => r.serverBootMs)),
    totalMs: summarize(runs.map((r) => r.totalMs)),
  }

  // Match cpuprofile by mtime >= the cpu-prof run start so we never grab a
  // stale file from an earlier session.
  const cpuProfMatch = findLatestCpuProf(cpuProfSinceMs)
  const cpuProfPath = cpuProfMatch ? cpuProfMatch.relPath : null
  const cpuProfSizeBytes = cpuProfMatch ? cpuProfMatch.sizeBytes : null

  const result = {
    version: pkg.version,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    n_runs: N_RUNS,
    rest_ms: REST_MS,
    runs,
    summary,
    t1_method: t1Method,
    marker_removed: true,
    cpu_prof_path: cpuProfPath,
    cpu_prof_size_bytes: cpuProfSizeBytes,
    cpu_prof_all_matched: cpuProfMatch ? cpuProfMatch.allMatched : null,
    captured_at: new Date().toISOString(),
  }

  const stamp = result.captured_at.replace(/[:.]/g, '-')
  const outPath = join(RESULTS_DIR, `boot-probe-${stamp}.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\n[boot-probe] wrote ${outPath}`)
  console.log('\n══ summary ══')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((e) => {
  console.error('[boot-probe] fatal:', e)
  // Best-effort cleanup.
  try { removeMarker() } catch {}
  process.exit(1)
})
