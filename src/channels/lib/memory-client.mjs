import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT_FILE = path.join(os.tmpdir(), 'mixdog-memory', 'memory-port')

function getMemoryPort() {
  try {
    return Number(fs.readFileSync(PORT_FILE, 'utf8').trim()) || 3350
  } catch {
    return 3350
  }
}

function memoryFetch(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const port = getMemoryPort()
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: 10_000,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve({ raw: data }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('memory-service timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

const BUFFER_DIR = path.join(os.tmpdir(), 'mixdog', 'memory-buffer')

function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts
  }
  const parsed = Date.parse(String(ts ?? ''))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

export async function appendEntry(data) {
  const payload = {
    ts: normalizeTs(data.ts),
    role: String(data.role ?? 'user'),
    content: String(data.content ?? ''),
    sourceRef: String(data.sourceRef ?? `manual:${Date.now()}-${process.pid}`),
    sessionId: data.sessionId ?? null,
  }
  try {
    return await memoryFetch('POST', '/entry', payload)
  } catch (e) {
    process.stderr.write(`[memory-client] appendEntry failed: ${e.message}\n`)
    await new Promise(r => setTimeout(r, 2000))
    try {
      process.stderr.write(`[memory-client] appendEntry retrying...\n`)
      return await memoryFetch('POST', '/entry', payload)
    } catch (retryErr) {
      process.stderr.write(`[memory-client] appendEntry retry failed: ${retryErr.message}\n`)
      try {
        fs.mkdirSync(BUFFER_DIR, { recursive: true })
        const random = Math.random().toString(36).slice(2, 10)
        const bufferPath = path.join(BUFFER_DIR, `entry-${Date.now()}-${random}.json`)
        fs.writeFileSync(bufferPath, JSON.stringify(payload, null, 2))
        process.stderr.write(`[memory-client] Entry buffered to ${bufferPath}\n`)
        return { ok: false, buffered: true, path: bufferPath }
      } catch (bufErr) {
        process.stderr.write(`[memory-client] Failed to buffer entry: ${bufErr.message}\n`)
        return { ok: false }
      }
    }
  }
}

function cleanupStaleBufferFiles(maxAgeDays = 7) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  const now = Date.now()
  let cleaned = 0
  try {
    const files = fs.readdirSync(BUFFER_DIR).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(BUFFER_DIR, file)
      try {
        const stats = fs.statSync(filePath)
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath)
          cleaned++
        }
      } catch (e) {
        process.stderr.write(`[memory-client] cleanupStaleBufferFiles error for ${file}: ${e.message}\n`)
      }
    }
  } catch {}
  return cleaned
}

export async function flushBufferedEntries() {
  let flushed = 0
  let failed = 0
  let files
  try {
    files = fs.readdirSync(BUFFER_DIR).filter(f => f.endsWith('.json'))
  } catch {
    return { flushed, failed }
  }
  for (const file of files) {
    const filePath = path.join(BUFFER_DIR, file)
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      await memoryFetch('POST', '/entry', data)
      fs.unlinkSync(filePath)
      flushed++
    } catch (e) {
      process.stderr.write(`[memory-client] flushBufferedEntries failed for ${file}: ${e.message}\n`)
      failed++
    }
  }
  cleanupStaleBufferFiles()
  return { flushed, failed }
}

export async function ingestTranscript(filePath) {
  try {
    return await memoryFetch('POST', '/ingest-transcript', { filePath })
  } catch (e) {
    process.stderr.write(`[memory-client] ingestTranscript failed: ${e.message}\n`)
    return { ok: false }
  }
}

export async function isHealthy() {
  try {
    const result = await memoryFetch('GET', '/health')
    return result.status === 'ok'
  } catch {
    return false
  }
}
