'use strict';
// Async one-shot shell runner.
//
// Replaces the legacy spawnSync path in builtin.mjs case 'bash'. The
// improvements over spawnSync are:
//   - tree-kill on timeout / abort (Windows taskkill /T /F, POSIX process
//     group SIGTERM->SIGKILL escalation) so forked children come down with
//     the parent shell instead of being orphaned holding pipes.
//   - automatic spill to $PLUGIN_DATA/shell-output/<taskId>.* once the
//     in-memory buffers exceed SHELL_OUTPUT_INLINE_CAP*4 bytes. The caller
//     receives an outputFilePath marker the model can FileRead later
//     instead of losing the tail past the inline cap.
//   - external AbortSignal hookup so a session-scoped abort (ESC, new
//     prompt) cancels in-flight bash work without orphaning the child.
//
// Persistent shells in bash-session.mjs keep their separate stdin-marker
// protocol — that runner is stateful and uses a different model entirely.

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as nodeUtil from 'node:util';
import { getPluginData } from '../config.mjs';

// Inline cap. Output above this size is spilled to disk and the caller
// renders a path marker instead of pasting the tail. Matches the
// SHELL_OUTPUT_MAX_CHARS used by the smart-truncate renderer in
// builtin.mjs so spilled output and inline output share the same boundary.
export const SHELL_OUTPUT_INLINE_CAP = 30_000;

// Hard ceiling on disk-backed output. Past this the SIZE_WATCHDOG (G2)
// SIGKILLs the child to avoid filling the filesystem. 100 MB is generous
// for any legitimate command output and tight enough to catch a runaway
// loop within ~seconds on a typical SSD.
export const SHELL_OUTPUT_DISK_CAP = 100 * 1024 * 1024;

// Background-task disk watchdog cadence. The size guard polls the spilled
// stdout/stderr files every interval and SIGKILLs the child once the
// combined size exceeds SHELL_OUTPUT_DISK_CAP. 5 s matches Claude Code's
// upstream cadence — short enough that a runaway loop is caught within a
// few seconds, long enough that the stat overhead is negligible.
export const SIZE_WATCHDOG_INTERVAL_MS = 5_000;

// ANSI / VT control sequence stripper. Falls back to a regex sweep when
// node:util's stripVTControlCharacters isn't available (older Node).
const _ANSI_REGEX =
  /(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:|\\|))/g;
const _stripAnsiImpl =
  typeof nodeUtil.stripVTControlCharacters === 'function'
    ? (s) => nodeUtil.stripVTControlCharacters(s)
    : (s) => String(s).replace(_ANSI_REGEX, () => '');

export function stripAnsi(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  return _stripAnsiImpl(s);
}

// Tree-kill helper. spawn alone only signals the direct child, so a
// `sleep 1000 &` or a forked node server inside the shell stays alive
// holding the pipes open. POSIX path signals the process group (we spawn
// with detached:true to give the child its own pgid). Windows uses
// taskkill /T /F to walk the tree. Safe to call repeatedly; all errors
// swallowed.
export function treeKill(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      // Escalate to SIGKILL after 3s so a child that ignores SIGTERM
      // still comes down. Windows taskkill /F is already forceful so
      // skip the escalation timer there.
      const esc = setTimeout(() => {
        if (child.killed) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }, 3000);
      if (esc.unref) esc.unref();
    }
  } catch {
    /* swallow */
  }
}

// Owns the captured stdout/stderr buffers for a single command run. Starts
// fully in memory; once the combined byte total exceeds the spill threshold
// (SHELL_OUTPUT_INLINE_CAP*4), opens append-only files in
// $PLUGIN_DATA/shell-output/ and from then on writes go straight to disk.
// On settle, the caller (execShellCommand) decides whether to keep the
// spilled files based on the final size.
class TaskOutput {
  constructor(taskId) {
    this.taskId = taskId;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.stdoutFd = null;
    this.stderrFd = null;
    this.stdoutPath = null;
    this.stderrPath = null;
    this.spilled = false;
    this.stdoutFileSize = 0;
    this.stderrFileSize = 0;
  }

  _ensureFileBacking() {
    if (this.spilled) return;
    const dir = join(getPluginData(), 'shell-output');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
    this.stdoutPath = join(dir, `${this.taskId}.stdout`);
    this.stderrPath = join(dir, `${this.taskId}.stderr`);
    this.stdoutFd = openSync(this.stdoutPath, 'a');
    this.stderrFd = openSync(this.stderrPath, 'a');
    if (this.stdoutBuf) {
      try {
        writeSync(this.stdoutFd, this.stdoutBuf);
      } catch {}
      this.stdoutFileSize += Buffer.byteLength(this.stdoutBuf, 'utf-8');
    }
    if (this.stderrBuf) {
      try {
        writeSync(this.stderrFd, this.stderrBuf);
      } catch {}
      this.stderrFileSize += Buffer.byteLength(this.stderrBuf, 'utf-8');
    }
    this.spilled = true;
  }

  _maybeSpill() {
    if (this.spilled) return;
    if (this.stdoutBuf.length + this.stderrBuf.length > SHELL_OUTPUT_INLINE_CAP * 4) {
      this._ensureFileBacking();
    }
  }

  writeStdout(s) {
    if (!s) return;
    if (this.spilled) {
      try {
        writeSync(this.stdoutFd, s);
      } catch {}
      this.stdoutFileSize += Buffer.byteLength(s, 'utf-8');
      return;
    }
    this.stdoutBuf += s;
    this._maybeSpill();
  }

  writeStderr(s) {
    if (!s) return;
    if (this.spilled) {
      try {
        writeSync(this.stderrFd, s);
      } catch {}
      this.stderrFileSize += Buffer.byteLength(s, 'utf-8');
      return;
    }
    this.stderrBuf += s;
    this._maybeSpill();
  }

  totalDiskBytes() {
    return this.stdoutFileSize + this.stderrFileSize;
  }

  async getStdout() {
    if (this.spilled) {
      try {
        fsyncSync(this.stdoutFd);
      } catch {}
      try {
        return readFileSync(this.stdoutPath, 'utf-8');
      } catch {
        return '';
      }
    }
    return this.stdoutBuf;
  }

  async getStderr() {
    if (this.spilled) {
      try {
        fsyncSync(this.stderrFd);
      } catch {}
      try {
        return readFileSync(this.stderrPath, 'utf-8');
      } catch {
        return '';
      }
    }
    return this.stderrBuf;
  }

  closeFds() {
    if (this.stdoutFd != null) {
      try {
        closeSync(this.stdoutFd);
      } catch {}
      this.stdoutFd = null;
    }
    if (this.stderrFd != null) {
      try {
        closeSync(this.stderrFd);
      } catch {}
      this.stderrFd = null;
    }
  }

  // Drop the spilled files when the inline body already covers the full
  // output. Called when total spilled bytes <= SHELL_OUTPUT_INLINE_CAP, so
  // outputFilePath would only point at a duplicate of what the caller is
  // already pasting into the result.
  deleteFiles() {
    this.closeFds();
    if (this.stdoutPath) {
      try {
        unlinkSync(this.stdoutPath);
      } catch {}
      this.stdoutPath = null;
    }
    if (this.stderrPath) {
      try {
        unlinkSync(this.stderrPath);
      } catch {}
      this.stderrPath = null;
    }
    this.spilled = false;
  }
}

export { TaskOutput };

// Result envelope. Status markers ([exit code: N], [signal: SIGTERM]) are
// the caller's responsibility — case 'bash' in builtin.mjs owns that
// rendering convention.
export class ExecResult {
  constructor(opts) {
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.exitCode = opts.exitCode;
    this.signal = opts.signal || null;
    this.timedOut = opts.timedOut === true;
    this.killed = opts.killed === true;
    this.stdoutPath = opts.stdoutPath || null;
    this.stdoutFileSize = opts.stdoutFileSize || 0;
    this.stderrPath = opts.stderrPath || null;
    this.stderrFileSize = opts.stderrFileSize || 0;
    this.taskId = opts.taskId;
  }
}

// One-shot async shell runner. abortSignal optional (session-scoped abort
// from getAbortSignalForSession in builtin.mjs). Timeout implemented via
// treeKill so forked grandchildren also come down. Output streams capture
// to TaskOutput which transparently spills to disk past the inline cap.
export function execShellCommand({
  shell,
  shellArg,
  command,
  env,
  cwd,
  timeoutMs,
  abortSignal,
}) {
  return new Promise((resolve) => {
    const taskId = `bash_${randomUUID().slice(0, 8)}`;
    const taskOutput = new TaskOutput(taskId);
    let timedOut = false;
    let killed = false;
    let settled = false;
    let timer = null;
    let abortHandler = null;

    let child;
    try {
      child = spawn(shell, [shellArg, command], {
        env,
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: detached gives the child its own process group so
        // treeKill can signal the whole group. Windows detached has
        // different semantics (no console attached, used for daemonization)
        // so it stays off there.
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve(
        new ExecResult({
          stdout: '',
          stderr: String((err && err.message) || err),
          exitCode: 1,
          signal: null,
          timedOut: false,
          killed: false,
          taskId,
        }),
      );
      return;
    }

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => taskOutput.writeStdout(chunk));
    child.stderr.on('data', (chunk) => taskOutput.writeStderr(chunk));

    let sizeWatchdog = null;
    const settle = async (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (sizeWatchdog) {
        clearInterval(sizeWatchdog);
        sizeWatchdog = null;
      }
      if (abortSignal && abortHandler) {
        try {
          abortSignal.removeEventListener('abort', abortHandler);
        } catch {}
      }
      const stdout = await taskOutput.getStdout();
      const stderr = await taskOutput.getStderr();
      // Inline-only path: nothing spilled. Nothing to clean up.
      // Spilled but tiny: drop the files — outputFilePath would duplicate
      // the inline body. Spilled and large: keep the files, caller renders
      // the path marker.
      if (
        taskOutput.spilled &&
        stdout.length + stderr.length <= SHELL_OUTPUT_INLINE_CAP
      ) {
        taskOutput.deleteFiles();
      } else {
        taskOutput.closeFds();
      }
      resolve(
        new ExecResult({
          stdout,
          stderr,
          exitCode,
          signal,
          timedOut,
          killed,
          stdoutPath: taskOutput.spilled ? taskOutput.stdoutPath : null,
          stdoutFileSize: taskOutput.stdoutFileSize,
          stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
          stderrFileSize: taskOutput.stderrFileSize,
          taskId,
        }),
      );
    };

    // P1 fix: settle on 'close', not 'exit'. 'exit' fires when the child
    // terminates but stdout/stderr streams may still be flushing buffered
    // bytes; settling there can lose the tail of the output. 'close' fires
    // after stdio is fully drained, so getStdout()/getStderr() see the
    // complete capture.
    child.once('close', (code, signal) => settle(code, signal));
    child.once('error', () => settle(1, null));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        treeKill(child);
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    // Size watchdog — a stuck command pumping GBs of stdout into the spill
    // file would fill the user's disk before the timeout fires. Poll the
    // running disk total every 5 s and SIGKILL once we cross the cap. The
    // settle() path clears this interval directly (see top of this Promise
    // body) so no extra exit / error listeners are needed here.
    sizeWatchdog = setInterval(() => {
      if (settled) return;
      if (taskOutput.totalDiskBytes() > SHELL_OUTPUT_DISK_CAP) {
        killed = true;
        treeKill(child);
      }
    }, SIZE_WATCHDOG_INTERVAL_MS);
    if (sizeWatchdog.unref) sizeWatchdog.unref();

    if (abortSignal) {
      abortHandler = () => {
        killed = true;
        treeKill(child);
      };
      try {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      } catch {}
    }
  });
}
