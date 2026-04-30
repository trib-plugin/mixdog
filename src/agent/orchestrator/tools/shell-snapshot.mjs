'use strict';
// Shell environment snapshot.
//
// Captures the user's interactive shell state (functions, aliases, shell
// options) by sourcing their config file in a one-shot login shell and
// dumping the resulting environment to a temp script. Subsequent bash
// commands prepend `source <snapshot>` so they run with the same nvm /
// pyenv / mise / asdf / direnv setup the user gets in their interactive
// terminal — without paying a fresh login-shell startup on every call.
//
// Mirrors Claude Code upstream (src/utils/bash/ShellSnapshot.ts:413,
// createAndSaveSnapshot). Simpler scope: bash and zsh only, no embedded
// search-tool injection (mixdog ships its own grep/glob helpers).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getPluginData } from '../config.mjs';

const SNAPSHOT_TIMEOUT_MS = 10_000;

// One snapshot per shellPath. Re-snapshot when the cached file is gone;
// otherwise the cached path is reused for the process lifetime so we
// don't pay the login-shell cost per call.
const _cache = new Map();

// Negative cache. When snapshot generation fails (timeout, syntax error,
// missing dump utilities) we mark the shell path so subsequent calls
// fall through immediately instead of paying another 10 s timeout per
// command. Cleared on process exit (process-scoped Set).
const _failedShells = new Set();

function getConfigFile(shellPath) {
  const lower = shellPath.toLowerCase();
  if (lower.includes('zsh')) return join(homedir(), '.zshrc');
  if (lower.includes('bash')) return join(homedir(), '.bashrc');
  return join(homedir(), '.profile');
}

// User-state capture script. Functions + aliases + shell options. Writes
// to $SNAPSHOT_FILE so the parent process can reuse it via `source`.
//
// Filtering: completion functions (single-underscore prefix) are dropped
// since they bloat the snapshot without affecting interactive behaviour.
// Double-underscore helpers (__pyenv_init etc) are kept.
function _shellQuote(s) {
  // POSIX single-quote escape: close, escaped quote, reopen.
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function getSnapshotScript(shellPath, snapshotFilePath, configFileExists) {
  const isZsh = shellPath.toLowerCase().includes('zsh');
  const sourceCfg = configFileExists
    ? `source ${_shellQuote(getConfigFile(shellPath))} < /dev/null 2>/dev/null || true`
    : '# no user config file';
  const fnDump = isZsh
    ? `
      typeset -f > /dev/null 2>&1
      typeset +f 2>/dev/null | grep -vE '^_[^_]' | while read func; do
        typeset -f "$func" >> "$SNAPSHOT_FILE" 2>/dev/null
      done
    `
    : `
      declare -f > /dev/null 2>&1
      declare -F 2>/dev/null | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do
        declare -f "$func" >> "$SNAPSHOT_FILE" 2>/dev/null
      done
    `;
  const optDump = isZsh
    ? `setopt 2>/dev/null | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"`
    : `
      shopt -p 2>/dev/null | head -n 1000 >> "$SNAPSHOT_FILE"
      set -o 2>/dev/null | grep "on" | awk '{print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
      echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
    `;
  const aliasDump = `
      # Filter winpty wrappers on Git Bash — they fail without a TTY.
      if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        alias 2>/dev/null | grep -v "='winpty " | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
      else
        alias 2>/dev/null | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
      fi
  `;
  return `SNAPSHOT_FILE=${_shellQuote(snapshotFilePath)}
${sourceCfg}
echo "# Snapshot" >| "$SNAPSHOT_FILE"
echo "# Unset all aliases first to avoid frozen-alias issues inside functions" >> "$SNAPSHOT_FILE"
echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"
echo "# Functions" >> "$SNAPSHOT_FILE"
${fnDump}
echo "# Shell options" >> "$SNAPSHOT_FILE"
${optDump}
echo "# Aliases" >> "$SNAPSHOT_FILE"
${aliasDump}
echo "export PATH=\\"$PATH\\"" >> "$SNAPSHOT_FILE"
exit 0
`;
}

function _runSnapshot(shellPath, snapshotPath, configFileExists) {
  return new Promise((resolve) => {
    const script = getSnapshotScript(shellPath, snapshotPath, configFileExists);
    let stderrBuf = '';
    // P1 fix: -ic (interactive command) so .bashrc/.zshrc with the standard
    // `[[ $- == *i* ]] && return` guard runs to completion. Plain -c skips
    // the user-config body and produces a header-only snapshot.
    const child = spawn(shellPath, ['-ic', script], {
      env: {
        ...process.env,
        SHELL: shellPath,
        GIT_EDITOR: 'true',
        CLAUDECODE: '1',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (s) => {
      stderrBuf += s;
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
    }, SNAPSHOT_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && existsSync(snapshotPath)) {
        // P1 sentinel: even with -ic, certain shells / config files yield
        // a snapshot containing only the header lines (functions / aliases /
        // options sections were skipped). Reject sizes below the threshold
        // so the negative cache kicks in instead of binding a useless path.
        let snapSize = 0;
        try { snapSize = statSync(snapshotPath).size; } catch {}
        if (snapSize < 200) {
          try {
            process.stderr.write(
              `[shell-snapshot] empty snapshot rejected size=${snapSize}\n`,
            );
          } catch {}
          resolve(null);
          return;
        }
        resolve(snapshotPath);
      } else {
        try {
          process.stderr.write(
            `[shell-snapshot] failed exit=${code} stderr=${(stderrBuf || '').slice(0, 200)}\n`,
          );
        } catch {}
        resolve(null);
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// Returns the snapshot file path for the given shell, generating one on
// first call. Returns null if generation failed (caller falls through to
// running the command without snapshot prelude).
export async function getOrCreateSnapshot(shellPath) {
  if (_failedShells.has(shellPath)) return null;
  const cached = _cache.get(shellPath);
  if (cached && existsSync(cached)) return cached;
  const dir = join(getPluginData(), 'shell-snapshots');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const shellTag = shellPath.toLowerCase().includes('zsh')
    ? 'zsh'
    : shellPath.toLowerCase().includes('bash')
      ? 'bash'
      : 'sh';
  const snapshotPath = join(
    dir,
    `snapshot-${shellTag}-${Date.now()}-${randomUUID().slice(0, 6)}.sh`,
  );
  const configFile = getConfigFile(shellPath);
  const configExists = existsSync(configFile);
  const result = await _runSnapshot(shellPath, snapshotPath, configExists);
  if (result) _cache.set(shellPath, result);
  else _failedShells.add(shellPath);
  return result;
}

// Wrap a user command so it runs with the captured environment sourced
// in. Snapshot generation is best-effort — when it fails, the command
// still runs (without alias / function support).
export async function wrapCommandWithSnapshot(shellPath, command) {
  const snapshot = await getOrCreateSnapshot(shellPath).catch(() => null);
  if (!snapshot) return command;
  const escaped = snapshot.replace(/'/g, "'\\''");
  return `source '${escaped}' 2>/dev/null; ${command}`;
}
