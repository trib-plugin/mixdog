// runtime-fetcher.mjs — P1 runtime fetcher for mixdog 0.4.0
// runtime-fetcher.mjs
// REQUIRES: `tar` (bsdtar-compatible) on PATH.
// On Windows, bsdtar ships with Windows 10 1803+ as %SystemRoot%\System32\tar.exe.
// If tar is missing, ensureRuntime() throws with an actionable error message.
//
// Downloads and verifies a prebuilt native PG runtime from the mixdog GitHub
// release manifest.
//
// Layout: <dataDir>/runtime/runtime-{ver}/  +  <dataDir>/runtime/active-version
// Atomic swap: write active-version.tmp then rename → active-version.
// GC: removes stale runtime-* dirs and staging-* dirs on every ensureRuntime call.
//
// Public API: ensureRuntime(dataDir) → { runtimeDir, pgBinDir, libDir, sharePath, version }

import { createHash } from 'crypto'
import {
  chmodSync, createWriteStream, existsSync, mkdirSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { pipeline } from 'stream/promises'
import { spawnSync } from 'child_process'

// Bundled fallback manifest shipped alongside the plugin. fileURLToPath required
// for cross-platform path resolution (URL.pathname returns /C:/... on Windows).
const BUNDLED_MANIFEST_PATH = fileURLToPath(new URL('../data/runtime-manifest.json', import.meta.url))

// GitHub raw URL fallback — used only when no cached or bundled manifest exists.
const MANIFEST_URL = 'https://raw.githubusercontent.com/trib-plugin/mixdog/main/src/memory/data/runtime-manifest.json'

// ---------------------------------------------------------------------------
// Platform key
// ---------------------------------------------------------------------------

function platformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform
  return `${os}-${process.arch}`
}

// ---------------------------------------------------------------------------
// Manifest resolution
// ---------------------------------------------------------------------------

async function loadManifest(dataDir) {
  const runtimeManifestPath = join(dataDir, 'runtime', 'manifest.json')
  if (existsSync(runtimeManifestPath)) {
    try { return JSON.parse(readFileSync(runtimeManifestPath, 'utf8')) } catch {}
  }
  if (existsSync(BUNDLED_MANIFEST_PATH)) {
    return JSON.parse(readFileSync(BUNDLED_MANIFEST_PATH, 'utf8'))
  }
  const res = await fetch(MANIFEST_URL)
  if (!res.ok) throw new Error(`[runtime-fetcher] manifest fetch failed: ${res.status} ${res.statusText}`)
  const manifest = await res.json()
  mkdirSync(join(dataDir, 'runtime'), { recursive: true })
  writeFileSync(runtimeManifestPath, JSON.stringify(manifest, null, 2))
  return manifest
}

// ---------------------------------------------------------------------------
// SHA-256 verification
// ---------------------------------------------------------------------------

async function sha256File(filePath) {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

async function verifySha256(filePath, expected) {
  const actual = await sha256File(filePath)
  if (actual !== expected) {
    throw new Error(`[runtime-fetcher] sha256 mismatch for ${filePath}: expected ${expected}, got ${actual}`)
  }
}

// ---------------------------------------------------------------------------
// Active-runtime validation (pointer-file layout)
// ---------------------------------------------------------------------------

function activeVersionPath(runtimeDir) {
  return join(runtimeDir, 'active-version')
}

function readActiveVersion(runtimeDir) {
  try { return readFileSync(activeVersionPath(runtimeDir), 'utf8').trim() } catch { return null }
}

function runtimeVerDir(runtimeDir, ver) {
  return join(runtimeDir, `runtime-${ver}`)
}

function runtimePaths(verDir) {
  return {
    pgBinDir:  join(verDir, 'bin'),
    libDir:    join(verDir, 'lib'),
    sharePath: join(verDir, 'share'),
  }
}

// ---------------------------------------------------------------------------
// Download with retry
// ---------------------------------------------------------------------------

async function downloadWithRetry(url, destPath) {
  // 4 total attempts: 1 initial + 3 retries; waits between attempts: 1s, 3s, 9s.
  const delays = [1000, 3000, 9000]
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status >= 400 && res.status < 500) {
        // 4xx: terminal — do not retry.
        throw new Error(`[runtime-fetcher] asset download HTTP ${res.status} (terminal) — ${url}`)
      }
      if (!res.ok) {
        throw new Error(`[runtime-fetcher] asset download HTTP ${res.status} — ${url}`)
      }
      const out = createWriteStream(destPath)
      await pipeline(res.body, out)
      return // success
    } catch (err) {
      lastErr = err
      // Terminal 4xx: do not retry.
      if (err.message.includes('(terminal)')) throw err
      if (attempt < 3) {
        process.stderr.write(`[runtime-fetcher] download attempt ${attempt + 1} failed (${err.message}), retrying in ${delays[attempt]}ms…\n`)
        await new Promise(r => setTimeout(r, delays[attempt]))
      }
    }
  }
  throw lastErr
}

// ---------------------------------------------------------------------------
// Tar entry path validation + extraction
// ---------------------------------------------------------------------------

function extractTarGz(tarPath, destDir, stagingBase) {
  mkdirSync(destDir, { recursive: true })

  // List entries first and validate — reject any that escape staging.
  const listResult = spawnSync('tar', ['-tzf', tarPath], { stdio: 'pipe' })
  if (listResult.status !== 0) {
    throw new Error(`[runtime-fetcher] tar list failed: ${listResult.stderr?.toString() || 'unknown'}`)
  }
  const entries = (listResult.stdout?.toString() || '').split('\n').filter(Boolean)
  const resolvedBase = resolve(stagingBase)
  for (const entry of entries) {
    // Reject absolute paths and traversal sequences.
    if (entry.startsWith('/') || entry.includes('..')) {
      throw new Error(`[runtime-fetcher] tar entry path validation failed (unsafe entry): ${entry}`)
    }
    const resolved = resolve(join(stagingBase, entry))
    if (!resolved.startsWith(resolvedBase)) {
      throw new Error(`[runtime-fetcher] tar entry escapes staging dir: ${entry}`)
    }
  }

  const r = spawnSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'pipe' })
  if (r.status !== 0) {
    throw new Error(`[runtime-fetcher] tar extraction failed: ${r.stderr?.toString() || 'unknown error'}`)
  }
}

// ---------------------------------------------------------------------------
// Unix exec-bit normalization
// ---------------------------------------------------------------------------

function normalizeBinExecBit(verDir) {
  if (process.platform === 'win32') return
  const binDir = join(verDir, 'bin')
  if (!existsSync(binDir)) return
  try {
    const entries = readdirSync(binDir)
    for (const f of entries) {
      try { chmodSync(join(binDir, f), 0o755) } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// GC — remove stale runtime-* and staging-* dirs
// ---------------------------------------------------------------------------

function gcRuntimeDir(runtimeDir, keepVer) {
  try {
    const entries = readdirSync(runtimeDir)
    for (const name of entries) {
      if (name.startsWith('staging-')) {
        try { rmSync(join(runtimeDir, name), { recursive: true, force: true }) } catch {}
      } else if (name.startsWith('runtime-') && name !== `runtime-${keepVer}`) {
        try { rmSync(join(runtimeDir, name), { recursive: true, force: true }) } catch {}
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// ensureRuntime — public API
// ---------------------------------------------------------------------------

const runtimeCache = new Map()

// One-shot tar availability probe; result cached after first call.
let _tarProbed = false
function probeTar() {
  if (_tarProbed) return
  const r = spawnSync('tar', ['--version'], { stdio: 'pipe' })
  if (r.status !== 0 || r.error) {
    throw new Error(
      '[runtime-fetcher] `tar` not found or not executable. ' +
      'On Windows, bsdtar (tar.exe) is required (available since Windows 10 1803). ' +
      'Ensure tar.exe is on PATH (typically %SystemRoot%\\System32\\tar.exe).'
    )
  }
  _tarProbed = true
}

export async function ensureRuntime(dataDir) {
  const key = resolve(dataDir)
  if (runtimeCache.has(key)) return runtimeCache.get(key)

  probeTar()

  const runtimeBaseDir = join(key, 'runtime')
  mkdirSync(runtimeBaseDir, { recursive: true })

  // Entry GC: always clean staging-* (partial extracts from prior crashes), but
  // preserve runtime-${currentVer} so a sibling child's just-completed swap is
  // not wiped. multi-process race protection.
  gcRuntimeDir(runtimeBaseDir, readActiveVersion(runtimeBaseDir))

  const manifest = await loadManifest(key)
  const pkey     = platformKey()
  const asset    = manifest.assets?.[pkey]
  if (!asset) {
    throw new Error(
      `[runtime-fetcher] no asset for platform ${pkey} in manifest. ` +
      `Available: ${Object.keys(manifest.assets || {}).join(', ')}`
    )
  }

  const { url, sha256, size } = asset
  const version = `pg${manifest.pg?.major}.${manifest.pg?.minor}+pgvector-${manifest.pgvector?.version}`

  // Fast path: active-version pointer exists and matches expected sha256.
  const currentVer = readActiveVersion(runtimeBaseDir)
  if (currentVer === version) {
    const verDir = runtimeVerDir(runtimeBaseDir, version)
    if (existsSync(join(verDir, '.version-sha256'))) {
      const stored = readFileSync(join(verDir, '.version-sha256'), 'utf8').trim()
      if (stored === sha256) {
        const result = { runtimeDir: verDir, ...runtimePaths(verDir), version }
        runtimeCache.set(key, result)
        return result
      }
    }
  }

  process.stderr.write(`[runtime-fetcher] downloading runtime ${version} for ${pkey} (~${size} bytes) …\n`)

  const stagingDir = join(runtimeBaseDir, `staging-${Date.now()}`)
  const tarPath    = join(runtimeBaseDir, `runtime-${pkey}-${Date.now()}.tar.gz`)

  let downloadOk = false
  try {
    await downloadWithRetry(url, tarPath)
    await verifySha256(tarPath, sha256)
    downloadOk = true
    extractTarGz(tarPath, stagingDir, stagingDir)
  } finally {
    try { rmSync(tarPath, { force: true }) } catch {}
  }

  if (!downloadOk) {
    try { rmSync(stagingDir, { recursive: true, force: true }) } catch {}
    throw new Error(`[runtime-fetcher] download or verify failed for ${version}`)
  }

  // Stamp sha256 inside staging dir.
  writeFileSync(join(stagingDir, '.version-sha256'), sha256)
  normalizeBinExecBit(stagingDir)

  // Atomic swap:
  // 1. Rename staging → runtime-{ver}
  // 2. Write active-version.tmp → rename to active-version
  // Stale dirs cleaned up by GC after.
  const verDir = runtimeVerDir(runtimeBaseDir, version)
  const avPath    = activeVersionPath(runtimeBaseDir)
  const avTmpPath = `${avPath}.tmp`

  try {
    // If a prior runtime-{ver} dir exists (interrupted earlier run), remove it.
    if (existsSync(verDir)) {
      rmSync(verDir, { recursive: true, force: true })
    }
    renameSync(stagingDir, verDir)
    writeFileSync(avTmpPath, version)
    renameSync(avTmpPath, avPath)
  } catch (swapErr) {
    process.stderr.write(`[runtime-fetcher] atomic swap failed: ${swapErr.message}\n`)
    // Attempt to leave things in a recoverable state: if verDir landed but
    // active-version didn't update, next call will re-download.
    try { rmSync(avTmpPath, { force: true }) } catch {}
    throw swapErr
  }

  // GC: remove stale runtime-* dirs (anything that isn't runtime-{version}).
  gcRuntimeDir(runtimeBaseDir, version)

  process.stderr.write(`[runtime-fetcher] runtime ready at ${verDir}\n`)

  const result = { runtimeDir: verDir, ...runtimePaths(verDir), version }
  runtimeCache.set(key, result)
  return result
}
