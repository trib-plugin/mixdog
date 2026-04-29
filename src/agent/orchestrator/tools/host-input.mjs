// Host-terminal input injection.
//
// Exposes `inject_input` as an MCP tool that types text into the *host*
// terminal currently running Claude Code (and therefore this MCP server,
// which Claude Code spawned as a child).
//
// Strategy:
//   1. Walk the parent-process chain starting at this Node process.
//   2. Find the first ancestor whose image name identifies a supported
//      terminal host (currently: powershell / pwsh).
//   3. Dispatch via a per-host handler map. Adding cmd / Windows Terminal /
//      VS Code / Claude Desktop later means dropping a new entry into
//      `HOST_HANDLERS` — no branching surgery in the dispatcher.
//
// The PowerShell handler reuses the proven helper script
// `scripts/inject-input.ps1` (AttachConsole + CreateFileW("CONIN$") +
// WriteConsoleInputW, with the stale-STD_INPUT_HANDLE workaround). We
// shell out to the script rather than reimplementing the FFI in Node so
// the C# console-input typedef stays in one place.
//
// Returned JSON shape: { ok, host, pid, exitCode, stderr? }.

import { spawnSync, execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// trib-plugin/src/agent/orchestrator/tools/host-input.mjs
//   __dirname = .../trib-plugin/src/agent/orchestrator/tools
//   → trib-plugin requires four `..` (orchestrator → agent → src → root).
const PLUGIN_ROOT = join(__dirname, '..', '..', '..', '..')
const PS_HELPER = join(PLUGIN_ROOT, 'scripts', 'inject-input.ps1')

// ── Parent-chain walker (Windows) ─────────────────────────────────────
//
// Uses one wmic / Get-CimInstance call to read the full Win32_Process
// table once, then walks PPID links in-process. Keeps the cost to one
// process spawn regardless of chain depth.
function readProcessTable() {
  // Prefer PowerShell + Get-CimInstance — wmic.exe is deprecated and
  // missing on newer Windows builds.
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 },
    )
    const parsed = JSON.parse(out)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const byPid = new Map()
    for (const row of rows) {
      if (!row || row.ProcessId == null) continue
      byPid.set(Number(row.ProcessId), {
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId ?? 0),
        name: String(row.Name ?? ''),
      })
    }
    return byPid
  } catch (e) {
    throw new Error(`failed to read process table: ${e?.message || e}`)
  }
}

// Image-name → host-tag map. Lower-case match.
const HOST_BY_IMAGE = {
  'pwsh.exe': 'powershell',
  'powershell.exe': 'powershell',
  // Future:
  // 'cmd.exe': 'cmd',
  // 'windowsterminal.exe': 'windows-terminal',
  // 'code.exe': 'vscode-terminal',
  // 'claude.exe': 'claude-desktop',
}

function classifyHost(imageName) {
  if (!imageName) return null
  return HOST_BY_IMAGE[imageName.toLowerCase()] ?? null
}

// Walk parent chain from the given pid, returning the first ancestor whose
// image maps to a known host. Bounded to 32 hops and skips PID 0 / orphan.
function findHostAncestor(startPid) {
  const table = readProcessTable()
  let cur = table.get(Number(startPid))
  let hops = 0
  const trail = []
  while (cur && hops < 32) {
    trail.push({ pid: cur.pid, name: cur.name })
    const tag = classifyHost(cur.name)
    if (tag) return { host: tag, pid: cur.pid, name: cur.name, trail }
    if (!cur.ppid || cur.ppid === cur.pid) break
    cur = table.get(cur.ppid)
    hops += 1
  }
  return { host: null, pid: null, name: null, trail }
}

// ── Per-host handlers ─────────────────────────────────────────────────

function handlePowerShell(text, pid) {
  // Pass the payload via a temp file rather than a command-line arg so
  // arbitrary characters (quotes, backticks, $, newlines) survive without
  // any shell or PowerShell parsing pitfalls. The .ps1 helper is invoked
  // directly via powershell.exe -File, no -Command interpolation.
  const tmpDir = mkdtempSync(join(tmpdir(), 'mixdog-inject-'))
  const payloadPath = join(tmpDir, 'payload.txt')
  let result
  try {
    writeFileSync(payloadPath, String(text), 'utf8')
    // The helper script's -Text param expects a single string. Read the
    // payload file inside a tiny -Command shim so we don't have to touch
    // the existing helper. -Raw preserves embedded newlines and trailing
    // whitespace exactly as the caller wrote them.
    const psCommand =
      `$ErrorActionPreference='Stop'; ` +
      `$txt = Get-Content -LiteralPath ${psQuote(payloadPath)} -Raw -Encoding UTF8; ` +
      `& ${psQuote(PS_HELPER)} -TargetPid ${Number(pid)} -Text $txt`
    result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    )
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
  const exitCode = result.status ?? -1
  const stderr = (result.stderr || '').trim()
  const ok = exitCode === 0
  const out = { ok, exitCode }
  if (!ok && stderr) out.stderr = stderr
  return out
}

// PowerShell single-quoted literal: escape ' as ''. Wraps the whole value
// in single quotes so $ / backtick / parentheses are taken literally.
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`
}

const HOST_HANDLERS = {
  powershell: handlePowerShell,
  // cmd: handleCmd,
  // 'windows-terminal': handleWT,
  // 'vscode-terminal': handleVSCode,
  // 'claude-desktop': handleClaudeDesktop,
}

// ── Public entry ──────────────────────────────────────────────────────

export const HOST_INPUT_TOOL_DEFS = [
  {
    name: 'inject_input',
    description: 'Inject text into host terminal (parent console). Always submits — appends newline if absent.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'Text to type into the host terminal.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
]

export async function executeHostInputTool(name, args /*, cwd */) {
  if (name !== 'inject_input') throw new Error(`Unknown host-input tool: ${name}`)
  const text = args?.text
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('inject_input: `text` (string, non-empty) is required')
  }
  if (process.platform !== 'win32') {
    throw new Error(`inject_input: only supported on Windows (got platform=${process.platform})`)
  }

  // Always submit: append a trailing newline if the caller didn't.
  const payload = text.endsWith('\n') ? text : text + '\n'

  const { host, pid, name: imageName, trail } = findHostAncestor(process.pid)
  if (!host) {
    const trailStr = trail.map(t => `${t.pid}:${t.name}`).join(' → ')
    throw new Error(`inject_input: no supported terminal host found in parent chain (${trailStr || '<empty>'})`)
  }
  const handler = HOST_HANDLERS[host]
  if (typeof handler !== 'function') {
    throw new Error(`inject_input: host "${host}" not supported yet (resolved image=${imageName} pid=${pid})`)
  }

  const result = handler(payload, pid)
  return JSON.stringify({
    ok: !!result.ok,
    host,
    pid,
    exitCode: result.exitCode,
    ...(result.stderr ? { stderr: result.stderr } : {}),
  })
}
