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
  })
  worker.on('exit', (code) => {
    if (code !== 0) {
      process.stderr.write(`[embed] worker exited with code ${code}\n`)
      for (const [, p] of _pending) p.reject(new Error(`Worker exited with code ${code}`))
      _pending.clear()
    }
    worker = null
  })
  return worker
}

function sendToWorker(action, extra = {}) {
  const w = ensureWorker()
  const id = ++_msgId
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject })
    w.postMessage({ id, action, ...extra })
  })
}

export function configureEmbedding(config = {}) {
  cachedDims = null
  _device = 'cpu'
  queryEmbeddingCache.clear()
  if (worker) {
    sendToWorker('configure', { dtype: config.dtype }).catch(() => {})
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
  cachedDims = result.dims || DEFAULT_DIMS
  _device = result.device || 'cpu'
  const vector = result.vector
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
