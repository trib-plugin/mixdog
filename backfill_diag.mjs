import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import os from 'os'

const DB_PATH = 'C:/Users/tempe/.claude/plugins/data/mixdog-trib-plugin/memory.sqlite'
const PROJECTS_DIR = join(os.homedir(), '.claude', 'projects')

const db = new DatabaseSync(DB_PATH)

const pre = db.prepare('SELECT COUNT(*) as c FROM entries WHERE chunk_root IS NULL AND is_root=0').get()
console.log('PRE raw_rows:', pre.c)

let ftsPre = []
try {
  ftsPre = db.prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?").all('getExactHistoryTypePriority')
} catch(e) { console.log('FTS pre error:', e.message) }
console.log('PRE FTS match count:', ftsPre.length, ftsPre.map(r => r.rowid))

function collectJsonls(dir) {
  const files = []
  try {
    for (const d of readdirSync(dir)) {
      if (d.includes('tmp') || d.includes('cache') || d.includes('plugins')) continue
      const full = join(dir, d)
      try {
        for (const f of readdirSync(full)) {
          if (!f.endsWith('.jsonl') || f.startsWith('agent-')) continue
          files.push(join(full, f))
        }
      } catch {}
    }
  } catch(e) { console.log('scan error:', e.message) }
  return files
}

function firstTextContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (typeof item === 'string') return item
    if (item?.type === 'text' && typeof item.text === 'string') return item.text
  }
  return ''
}

function parseTsToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

const insertStmt = db.prepare(
  'INSERT OR IGNORE INTO entries(ts, role, content, source_ref, session_id, source_turn) VALUES (?, ?, ?, ?, ?, ?)'
)

const files = collectJsonls(PROJECTS_DIR)
console.log('
Found ' + files.length + ' JSONL files')

let totalInserted = 0
for (const fp of files) {
  const parts = fp.split('/')
  const basename = parts[parts.length - 1]
  const sessionUuid = basename.slice(0, -6)
  const dirpart = parts[parts.length - 2]
  let raw
  try { raw = readFileSync(fp, 'utf8') } catch { continue }
  const lines = raw.split('
').filter(Boolean)
  let fileInserted = 0
  for (let i = 0; i < lines.length; i++) {
    let parsed
    try { parsed = JSON.parse(lines[i]) } catch { continue }
    const role = parsed.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = firstTextContent(parsed.message?.content)
    if (!content || !content.trim()) continue
    const tsMs = parseTsToMs(parsed.timestamp ?? parsed.ts ?? Date.now())
    const sourceRef = 'transcript:' + sessionUuid + '#' + (i + 1)
    try {
      const result = insertStmt.run(tsMs, role, content.trim(), sourceRef, sessionUuid, i + 1)
      if (result.changes > 0) fileInserted++
    } catch {}
  }
  if (fileInserted > 0) {
    console.log('  ' + dirpart + '/' + basename + ' => +' + fileInserted)
    totalInserted += fileInserted
  }
}

console.log('
Total newly inserted: ' + totalInserted)

const post = db.prepare('SELECT COUNT(*) as c FROM entries WHERE chunk_root IS NULL AND is_root=0').get()
console.log('POST raw_rows:', post.c)

let ftsPost = []
try {
  ftsPost = db.prepare("SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?").all('getExactHistoryTypePriority')
} catch(e) { console.log('FTS post error:', e.message) }
console.log('POST FTS match count:', ftsPost.length, ftsPost.map(r => r.rowid))

console.log('
Delta raw: +' + (post.c - pre.c) + ' | FTS: ' + ftsPre.length + ' -> ' + ftsPost.length)
