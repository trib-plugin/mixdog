/**
 * llm-worker-host.mjs — LLM worker host using direct spawn (no fork).
 *
 * Replaces fork-based approach that broke in bundled environments
 * where the separate worker .mjs file cannot be resolved.
 * Each task spawns a child process directly and communicates via stdio.
 */

import { spawn } from 'node:child_process'

let active = false

export function hasLlmWorker() {
  return active
}

export function startLlmWorker() {
  active = true
}

export async function stopLlmWorker() {
  active = false
}

/**
 * Run a command in a child process (direct spawn, no fork/IPC).
 * Mirrors the old llm-worker.mjs runTask() logic.
 */
export function runLlmWorkerTask(task = {}) {
  if (!active) {
    throw new Error('llm worker is not running')
  }

  const command = String(task.command ?? '').trim()
  const args = Array.isArray(task.args) ? task.args.map(v => String(v)) : []
  if (!command) {
    return Promise.reject(new Error('worker task requires command'))
  }

  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1000, Number(task.timeout ?? 120000))
    const isWin = process.platform === 'win32'
    const safeArgs = isWin ? args.map(a => /\s/.test(a) ? `"${a}"` : a) : args

    const child = spawn(command, safeArgs, {
      cwd: task.cwd ? String(task.cwd) : process.cwd(),
      env: {
        ...process.env,
        ...(task.env && typeof task.env === 'object' ? task.env : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
    })

    let stdout = ''
    let stderr = ''
    let finished = false

    const timer = setTimeout(() => {
      if (finished) return
      finished = true
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`${command} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    child.on('error', error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (signal) {
        reject(new Error(`${command} killed by ${signal}${signal === 'SIGTERM' ? ' (timeout)' : ''}`))
        return
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`))
        return
      }
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      })
    })

    if (task.stdin != null) {
      child.stdin.write(String(task.stdin))
    }
    child.stdin.end()
  })
}
