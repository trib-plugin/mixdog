import { parentPort } from 'worker_threads'
import { createRequire } from 'module'
import { join } from 'path'
import { mkdirSync } from 'fs'

const MODEL_ID = 'Xenova/bge-m3'
const DEFAULT_DIMS = 1024
const DEFAULT_DTYPE = 'q4'
const INTRA_OP_THREADS = 1
const INTER_OP_THREADS = 1
const MODEL_CACHE_DIR = join(process.env.HOME || process.env.USERPROFILE, '.cache', 'mixdog-memory', 'models')
const IDLE_TIMEOUT_MS = 15 * 60 * 1000

let extractorPromise = null
let configuredDtype = DEFAULT_DTYPE
let _device = 'cpu'
let _idleTimer = null
let ortPatched = false

function resetIdleTimer() {
  if (_idleTimer) clearTimeout(_idleTimer)
  _idleTimer = setTimeout(() => {
    if (extractorPromise) {
      extractorPromise.then(ext => { try { ext.dispose() } catch {} }).catch(() => {})
      extractorPromise = null
      const prevDevice = _device
      _device = 'cpu'
      process.stderr.write('[embed-worker] idle timeout — model disposed\n')
      parentPort.postMessage({ type: 'idle-dispose', device: prevDevice, dtype: configuredDtype })
    }
    _idleTimer = null
  }, IDLE_TIMEOUT_MS)
}

function patchOrtThreads() {
  if (ortPatched) return
  try {
    const require = createRequire(import.meta.url)
    const ort = require('onnxruntime-node')
    if (!ort?.InferenceSession?.create) {
      process.stderr.write('[embed-worker] ORT patch skipped: InferenceSession.create not found\n')
      return
    }
    const origCreate = ort.InferenceSession.create.bind(ort.InferenceSession)
    ort.InferenceSession.create = async function (pathOrBuffer, options = {}) {
      if (!options.intraOpNumThreads) options.intraOpNumThreads = INTRA_OP_THREADS
      if (!options.interOpNumThreads) options.interOpNumThreads = INTER_OP_THREADS
      return origCreate(pathOrBuffer, options)
    }
    ortPatched = true
    process.stderr.write(`[embed-worker] ORT patched OK: intra=${INTRA_OP_THREADS} inter=${INTER_OP_THREADS}\n`)
  } catch (err) {
    process.stderr.write(`[embed-worker] ORT patch failed: ${err?.message || err}\n`)
  }
}

async function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      parentPort.postMessage({ type: 'profile', record: { phase: 'baseline', model: MODEL_ID, device: _device, dtype: configuredDtype, note: 'pre-load' } })
      patchOrtThreads()
      const { pipeline, env } = await import('@huggingface/transformers')
      env.allowLocalModels = false
      try { mkdirSync(MODEL_CACHE_DIR, { recursive: true }) } catch {}
      env.cacheDir = MODEL_CACHE_DIR
      try { env.backends.onnx.wasm.numThreads = INTRA_OP_THREADS } catch {}
      const opts = {}
      if (configuredDtype && configuredDtype !== 'fp32') {
        opts.dtype = configuredDtype
      }
      const startMs = Date.now()
      let extractor
      const preferGpu = (process.env.MIXDOG_MEMORY_EMBED_DEVICE || 'auto') !== 'cpu'
      if (preferGpu) {
        try {
          extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'dml' })
          _device = 'dml'
        } catch (gpuErr) {
          process.stderr.write(`[embed-worker] DML failed (${gpuErr.message?.slice(0, 80)}), falling back to CPU\n`)
          extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'cpu' })
          _device = 'cpu'
        }
      } else {
        extractor = await pipeline('feature-extraction', MODEL_ID, { ...opts, device: 'cpu' })
        _device = 'cpu'
      }
      const loadMs = Date.now() - startMs
      process.stderr.write(`[embed-worker] loaded ${MODEL_ID} dtype=${configuredDtype} device=${_device} threads=${INTRA_OP_THREADS} in ${loadMs}ms\n`)
      parentPort.postMessage({ type: 'profile', record: { phase: 'load', model: MODEL_ID, device: _device, dtype: configuredDtype, wallMs: loadMs } })
      return extractor
    })()
  }
  return extractorPromise
}

parentPort.on('message', async (msg) => {
  const { id, action } = msg
  try {
    switch (action) {
      case 'embed': {
        resetIdleTimer()
        const extractor = await loadExtractor()
        const t0 = Date.now()
        const output = await extractor(msg.text, { pooling: 'mean', normalize: true })
        const wallMs = Date.now() - t0
        const dims = output.data?.length || DEFAULT_DIMS
        const vector = Array.from(output.data ?? [])
        parentPort.postMessage({ id, type: 'result', vector, dims, wallMs, device: _device, dtype: configuredDtype })
        break
      }
      case 'warmup': {
        const extractor = await loadExtractor()
        const t0 = Date.now()
        await extractor('warmup', { pooling: 'mean', normalize: true })
        const wallMs = Date.now() - t0
        parentPort.postMessage({ id, type: 'result', dims: DEFAULT_DIMS, wallMs, device: _device, dtype: configuredDtype })
        parentPort.postMessage({ type: 'profile', record: { phase: 'warmup', model: MODEL_ID, device: _device, dtype: configuredDtype, wallMs } })
        resetIdleTimer()
        break
      }
      case 'configure': {
        if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
        if (msg.dtype != null) {
          const dt = String(msg.dtype).trim().toLowerCase()
          configuredDtype = ['fp32', 'fp16', 'q8', 'q4'].includes(dt) ? dt : DEFAULT_DTYPE
        }
        if (extractorPromise) {
          try {
            const ext = await extractorPromise
            try { ext.dispose() } catch {}
          } catch {}
          extractorPromise = null
          _device = 'cpu'
        }
        parentPort.postMessage({ id, type: 'result' })
        break
      }
      case 'dispose': {
        if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null }
        const prevDevice = _device
        if (extractorPromise) {
          try {
            const ext = await extractorPromise
            try { ext.dispose() } catch {}
          } catch {}
          extractorPromise = null
          _device = 'cpu'
        }
        parentPort.postMessage({ id, type: 'result', prevDevice, dtype: configuredDtype })
        break
      }
    }
  } catch (err) {
    parentPort.postMessage({ id, type: 'error', message: err?.message || String(err) })
  }
})
