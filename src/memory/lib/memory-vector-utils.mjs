import { createHash } from 'crypto'
import { cleanMemoryText } from './memory-extraction.mjs'

export function vecToHex(vector) {
  const hex = Buffer.from(new Float32Array(vector).buffer).toString('hex')
  if (!/^[0-9a-f]+$/.test(hex)) throw new Error('invalid hex from vector')
  return hex
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function averageVectors(vectors = []) {
  const rows = vectors.filter(vector => Array.isArray(vector) && vector.length > 0)
  if (rows.length === 0) return []
  const dims = rows[0].length
  const out = new Array(dims).fill(0)
  for (const vector of rows) {
    if (vector.length !== dims) continue
    for (let i = 0; i < dims; i += 1) out[i] += vector[i]
  }
  for (let i = 0; i < dims; i += 1) out[i] /= rows.length
  return out
}

export function embeddingItemKey(entityType, entityId) {
  return `${entityType}:${entityId}`
}

export function hashEmbeddingInput(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

export function contextualizeEmbeddingInput(item) {
  const entityType = String(item.entityType ?? '')
  const content = cleanMemoryText(item.content ?? '')
  if (!content) return ''

  if (entityType === 'fact') {
    const label = String(item.subtype ?? 'fact')
    const slot = item.slot ? ` slot=${item.slot}` : ''
    const workstream = item.workstream ? ` workstream=${item.workstream}` : ''
    return cleanMemoryText(`memory fact type=${label}${slot}${workstream}\n${content}`)
  }

  if (entityType === 'task') {
    const status = item.status ? ` status=${item.status}` : ''
    const priority = item.priority ? ` priority=${item.priority}` : ''
    const workstream = item.workstream ? ` workstream=${item.workstream}` : ''
    return cleanMemoryText(`memory task${status}${priority}${workstream}\n${content}`)
  }

  if (entityType === 'signal') {
    const kind = item.subtype ? ` kind=${item.subtype}` : ''
    return cleanMemoryText(`memory signal${kind}\n${content}`)
  }

  if (entityType === 'entity') {
    const etype = item.subtype ? ` type=${item.subtype}` : ''
    return cleanMemoryText(`knowledge entity${etype}\n${content}`)
  }

  if (entityType === 'relation') {
    const rtype = item.subtype ? ` type=${item.subtype}` : ''
    return cleanMemoryText(`knowledge relation${rtype}\n${content}`)
  }

  return content
}
