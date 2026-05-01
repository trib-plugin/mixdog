/**
 * embedding-provider.mjs — Embedding provider with worker_threads isolation.
 */

import { Worker } from 'worker_threads'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { writeProfilePoint } from './model-profile.mjs'

const MODEL_ID = 'Xenova/bge-m3'
const DEFAULT_DIMS = 1024

let worker = null
let _restartCount = 0
let _lastRestartMs = 0
const MAX_RESTART_BACKOFF_MS = 30_000
let cachedDims = null
let _device = 'cpu'
let _embedCallCount = 0
let _msgId = 0
const _pending = new Map()
const EMBED_STEADY_SAMPLE_EVERY = 20
const queryEmbeddingCache = new Map()
const QUERY_EMBEDDING_CACHE_LIMIT = 1000

const WORKER_PATH = join(fileURLToPath(import.meta.url), '..', 'embedding-worker.mjs')

function cacheEmbedding(key, vector) {
  if (queryEmbeddingCache.has(key)) queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, vector)
  if (queryEmbeddingCache.size > QUERY_EMBEDDING_CACHE_LIMIT) {
    const oldestKey = queryEmbeddingCache.keys().next().value
    if (oldestKey) queryEmbeddingCache.delete(oldestKey)
  }
}

function getCachedEmbedding(key) {
  if (!queryEmbeddingCache.has(key)) return null
  const value = queryEmbeddingCache.get(key)
  queryEmbeddingCache.delete(key)
  queryEmbeddingCache.set(key, value)
  return value
}

function ensureWorker() {
  if (worker) return worker
  const now = Date.now()
  if (_restartCount > 0) {
    const backoffMs = Math.min(1000 * Math.pow(2, _restartCount - 1), MAX_RESTART_BACKOFF_MS)
    const elapsed = now - _lastRestartMs
    if (elapsed < backoffMs) {
      throw new Error(`embed worker in restart backoff (${Math.ceil((backoffMs - elapsed) / 1000)}s remaining)`)
    }
  }
  _lastRestartMs = now
  const execArgv = process.execArgv.filter((arg) => !String(arg).startsWith('--input-type'))
  worker = new Worker(WORKER_PATH, { env: { ...process.env }, execArgv })
  worker.on('message', (msg) => {
    if (msg.type === 'profile') {
      writeProfilePoint(msg.record)
      return
    }
    if (msg.type === 'idle-dispose') {
      cachedDims = null
      _device = 'cpu'
      process.stderr.write('[embed] idle timeout — model disposed\n')
      writeProfilePoint({ phase: 'post-idle', model: MODEL_ID, device: msg.device, dtype: msg.dtype, note: 'idle dispose' })
      return
    }
    const pending = _pending.get(msg.id)
    if (!pending) return
    _pending.delete(msg.id)
    if (msg.type === 'error') {
      pending.reject(new Error(msg.message))
    } else {
      pending.resolve(msg)
    }
  })
  worker.on('error', (err) => {
    process.stderr.write(`[embed] worker error: ${err?.message || err}\n`)
    for (const [, p] of _pending) p.reject(err)
    _pending.clear()
    worker = null
    _restartCount++
  })
  worker.on('exit', (code) => {
    if (code !== 0) {
      process.stderr.write(`[embed] worker exited with code ${code}\n`)
      for (const [, p] of _pending) p.reject(new Error(`Worker exited with code ${code}`))
      _pending.clear()
      _restartCount++
    } else {
      _restartCount = 0
    }
    worker = null
  })
  return worker
}

const EMBED_WORKER_TIMEOUT_MS = 60_000

function sendToWorker(action, extra = {}, timeoutMs = EMBED_WORKER_TIMEOUT_MS) {
  const w = ensureWorker()
  const id = ++_msgId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id)
      process.stderr.write(`[embed] worker ${action} timed out — terminating worker\n`)
      if (worker) {
        const stuck = worker
        worker = null
        _restartCount++
        stuck.terminate().catch(() => {})
      }
      reject(new Error(`embed worker ${action} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    _pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      w.postMessage({ id, action, ...extra })
    } catch (postErr) {
      clearTimeout(timer)
      _pending.delete(id)
      reject(postErr)
    }
  })
}

export function configureEmbedding(config = {}) {
  cachedDims = null
  _device = 'cpu'
  queryEmbeddingCache.clear()
  if (worker) {
    sendToWorker('configure', { dtype: config.dtype }).catch((err) => {
      // Silent .catch hid worker reconfigure failures (dtype mismatch,
      // worker crash, IPC closed). At least one log line so cycle1 /
      // cycle2 root-cause investigation can see the upstream failure
      // instead of just the downstream `db write failed`.
      process.stderr.write(`[embed] worker configure failed: ${err?.message || err}\n`)
    })
  }
}

export function clearEmbeddingCache() {
  queryEmbeddingCache.clear()
}

export function getEmbeddingModelId() {
  return MODEL_ID
}

export function getEmbeddingDims() {
  return cachedDims || DEFAULT_DIMS
}

export function getEmbeddingDevice() { return _device }

export function consumeProviderSwitchEvent() {
  return null
}

export async function warmupEmbeddingProvider() {
  const result = await sendToWorker('warmup')
  cachedDims = result.dims || DEFAULT_DIMS
  _device = result.device || 'cpu'
  return true
}

export async function disposeEmbeddingProvider() {
  if (worker) {
    const result = await sendToWorker('dispose')
    writeProfilePoint({ phase: 'post-idle', model: MODEL_ID, device: result.prevDevice || _device, dtype: result.dtype, note: 'forced dispose' })
    cachedDims = null
    _device = 'cpu'
    try { await worker.terminate() } catch {}
    worker = null
  }
}

export async function embedText(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return []
  const cacheKey = `${MODEL_ID}\n${clean}`
  const cached = getCachedEmbedding(cacheKey)
  if (cached) return [...cached]

  const result = await sendToWorker('embed', { text: clean })
  const resultDims = result.dims || DEFAULT_DIMS
  if (cachedDims && resultDims !== cachedDims) {
    throw new Error(`embed vector dims mismatch: expected ${cachedDims}, got ${resultDims}`)
  }
  cachedDims = resultDims
  _device = result.device || 'cpu'
  const vector = result.vector
  if (!Array.isArray(vector) || vector.length !== cachedDims) {
    throw new Error(`embed vector length mismatch: expected ${cachedDims}, got ${vector?.length}`)
  }
  cacheEmbedding(cacheKey, vector)
  _embedCallCount++
  if (_embedCallCount % EMBED_STEADY_SAMPLE_EVERY === 0) {
    writeProfilePoint({
      phase: 'steady',
      model: MODEL_ID,
      device: _device,
      dtype: result.dtype,
      wallMs: result.wallMs,
      note: `sample@${_embedCallCount}`,
    })
  }
  return vector
}
