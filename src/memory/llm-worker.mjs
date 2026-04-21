#!/usr/bin/env node

import { spawn } from 'node:child_process'

function runTask(task = {}) {
  return new Promise((resolve, reject) => {
    const command = String(task.command ?? '').trim()
    const args = Array.isArray(task.args) ? task.args.map(value => String(value)) : []
    if (!command) {
      reject(new Error('worker task requires command'))
      return
    }

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
        reject(new Error(`${command} killed by ${signal}${signal === 'SIGTERM' ? ' (timeout)' : ''}: ${stderr.trim()}`))
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

process.on('message', async (message = {}) => {
  if (message.type !== 'run') return
  const requestId = Number(message.requestId ?? 0)
  try {
    const result = await runTask(message.task ?? {})
    process.send?.({ type: 'result', requestId, result })
  } catch (error) {
    process.send?.({
      type: 'error',
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
