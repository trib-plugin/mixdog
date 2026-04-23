#!/usr/bin/env bash
# mixdog statusline wrapper — v0.1.18
# Combines Claude Code stdin JSON (cost, model) with mixdog /bridge/status.
# Outputs two lines: runtime (line 1) and incoming (line 2).
# Width-responsive: >=120 wide, 80-119 medium, <80 narrow.
# Graceful degradation: missing jq, unreachable endpoint, or missing stdin.

set -euo pipefail 2>/dev/null || true   # best-effort; some POSIX shells vary

# ── Terminal width ──────────────────────────────────────────────────────────
COLS="${COLUMNS:-}"
if [ -z "$COLS" ]; then
  COLS="$(tput cols 2>/dev/null || echo 80)"
fi
# Ensure numeric
case "$COLS" in
  ''|*[!0-9]*) COLS=80 ;;
esac

# ── Read Claude Code stdin JSON ─────────────────────────────────────────────
# Claude Code passes rich session JSON on stdin when configured as a command.
# Read it non-blockingly: if stdin is a tty or /dev/null, skip gracefully.
CC_JSON=""
if [ ! -t 0 ]; then
  CC_JSON="$(cat 2>/dev/null || true)"
fi

# ── Extract Claude Code fields ───────────────────────────────────────────────
CC_COST=""
CC_MODEL=""
CC_CTX_USED=""

if [ -n "$CC_JSON" ]; then
  HAS_JQ=0
  command -v jq >/dev/null 2>&1 && HAS_JQ=1

  if [ "$HAS_JQ" -eq 1 ]; then
    CC_COST="$(printf '%s' "$CC_JSON"   | jq -r '.cost.total_cost_usd // empty' 2>/dev/null || true)"
    CC_MODEL="$(printf '%s' "$CC_JSON"  | jq -r '.model.display_name // empty' 2>/dev/null || true)"
    CC_CTX_USED="$(printf '%s' "$CC_JSON" | jq -r '.context_window.used_percentage // empty' 2>/dev/null || true)"
  else
    # Fallback: minimal grep/sed extraction (no arrays, simple flat keys)
    CC_COST="$(printf '%s' "$CC_JSON"   | grep -o '"total_cost_usd"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_MODEL="$(printf '%s' "$CC_JSON"  | grep -o '"display_name"[ ]*:[ ]*"[^"]*"' | sed 's/.*:[ ]*"\([^"]*\)"/\1/' | head -1 || true)"
    CC_CTX_USED="$(printf '%s' "$CC_JSON" | grep -o '"used_percentage"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
  fi
fi

# ── Fetch mixdog /bridge/status ──────────────────────────────────────────────
BRIDGE_JSON=""
BRIDGE_JSON="$(curl -s --max-time 1 'http://localhost:3458/bridge/status?format=json' 2>/dev/null || true)"
# Verify it's JSON-ish (starts with '{')
case "$BRIDGE_JSON" in
  '{'*) : ;;
  *) BRIDGE_JSON="" ;;
esac

# ── Extract bridge fields ────────────────────────────────────────────────────
B_SESS_ACTIVE=0
B_SESS_ROLES=""
B_LAST_ROLE=""
B_LAST_AGO=""
B_SCHED_NEXT_TIME=""
B_SCHED_NEXT_NAME=""
B_SCHED_ACTIVE=0
B_SCHED_DEFERRED=0
B_RECALL=0
B_JOBS=0
B_NGROK=0

if [ -n "$BRIDGE_JSON" ]; then
  HAS_JQ=0
  command -v jq >/dev/null 2>&1 && HAS_JQ=1

  if [ "$HAS_JQ" -eq 1 ]; then
    B_SESS_ACTIVE="$(printf '%s' "$BRIDGE_JSON"    | jq -r '.sessions.active // 0' 2>/dev/null || echo 0)"
    B_SESS_ROLES="$(printf '%s' "$BRIDGE_JSON"     | jq -r 'if (.sessions.roles | length) > 0 then .sessions.roles | join(",") else "" end' 2>/dev/null || true)"
    B_LAST_ROLE="$(printf '%s' "$BRIDGE_JSON"      | jq -r '.lastCompleted.role // empty' 2>/dev/null || true)"
    B_LAST_AGO="$(printf '%s' "$BRIDGE_JSON"       | jq -r '.lastCompleted.agoMinutes // empty' 2>/dev/null || true)"
    B_SCHED_NEXT_TIME="$(printf '%s' "$BRIDGE_JSON" | jq -r 'if .schedule.next then (.schedule.next.fireAt / 1000 | todate | .[11:16]) else empty end' 2>/dev/null || true)"
    B_SCHED_NEXT_NAME="$(printf '%s' "$BRIDGE_JSON" | jq -r '.schedule.next.name // empty' 2>/dev/null || true)"
    B_SCHED_ACTIVE="$(printf '%s' "$BRIDGE_JSON"   | jq -r '.schedule.active // 0' 2>/dev/null || echo 0)"
    B_SCHED_DEFERRED="$(printf '%s' "$BRIDGE_JSON" | jq -r '.schedule.deferred // 0' 2>/dev/null || echo 0)"
    B_RECALL="$(printf '%s' "$BRIDGE_JSON"         | jq -r '.recallLastHour // 0' 2>/dev/null || echo 0)"
    B_JOBS="$(printf '%s' "$BRIDGE_JSON"           | jq -r '.jobs.count // 0' 2>/dev/null || echo 0)"
    B_NGROK="$(printf '%s' "$BRIDGE_JSON"          | jq -r 'if .ngrok.online then 1 else 0 end' 2>/dev/null || echo 0)"
  else
    # grep/sed fallback for critical scalars
    B_SESS_ACTIVE="$(printf '%s' "$BRIDGE_JSON" | grep -o '"active"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || echo 0)"
    B_RECALL="$(printf '%s' "$BRIDGE_JSON"      | grep -o '"recallLastHour"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || echo 0)"
    B_JOBS="$(printf '%s' "$BRIDGE_JSON"        | grep -o '"count"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || echo 0)"
    B_NGROK="$(printf '%s' "$BRIDGE_JSON"       | grep -oE '"online"[ ]*:[ ]*(true|false)' | grep -o 'true\|false' | head -1 | sed 's/true/1/;s/false/0/' || echo 0)"
    B_LAST_ROLE="$(printf '%s' "$BRIDGE_JSON"   | grep -o '"role"[ ]*:[ ]*"[^"]*"' | sed 's/.*:[ ]*"\([^"]*\)"/\1/' | head -1 || true)"
    B_LAST_AGO="$(printf '%s' "$BRIDGE_JSON"    | grep -o '"agoMinutes"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || true)"
    B_SCHED_ACTIVE="$(printf '%s' "$BRIDGE_JSON" | grep -o '"active"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | sed -n '2p' || echo 0)"
  fi
fi

# Ensure numeric defaults
B_SESS_ACTIVE="${B_SESS_ACTIVE:-0}"
B_SCHED_ACTIVE="${B_SCHED_ACTIVE:-0}"
B_SCHED_DEFERRED="${B_SCHED_DEFERRED:-0}"
B_RECALL="${B_RECALL:-0}"
B_JOBS="${B_JOBS:-0}"
B_NGROK="${B_NGROK:-0}"
case "$B_SESS_ACTIVE"   in ''|*[!0-9]*) B_SESS_ACTIVE=0 ;; esac
case "$B_SCHED_ACTIVE"  in ''|*[!0-9]*) B_SCHED_ACTIVE=0 ;; esac
case "$B_SCHED_DEFERRED" in ''|*[!0-9]*) B_SCHED_DEFERRED=0 ;; esac
case "$B_RECALL"        in ''|*[!0-9]*) B_RECALL=0 ;; esac
case "$B_JOBS"          in ''|*[!0-9]*) B_JOBS=0 ;; esac
case "$B_NGROK"         in ''|*[!0-9]*) B_NGROK=0 ;; esac

# ── Format cost ──────────────────────────────────────────────────────────────
fmt_cost() {
  # $1 = raw float from jq/grep; outputs "$X.XX" or ""
  local v="$1"
  [ -z "$v" ] && return
  # Use awk for portable float formatting
  printf '%.2f' "$v" 2>/dev/null | awk '{printf "$%s", $0}'
}
COST_STR=""
if [ -n "$CC_COST" ]; then
  COST_STR="$(fmt_cost "$CC_COST")"
fi

# ── Assemble segments ────────────────────────────────────────────────────────
# Line 1 segments: sessions, last-completed, jobs, cost
# Line 2 segments: schedule-next, schedule-roster, ngrok, recall

# -- sessions segment --
seg_sessions_wide() {
  if [ "$B_SESS_ACTIVE" -gt 0 ] && [ -n "$B_SESS_ROLES" ]; then
    printf '⚙ %s running (%s)' "$B_SESS_ACTIVE" "$B_SESS_ROLES"
  elif [ "$B_SESS_ACTIVE" -gt 0 ]; then
    printf '⚙ %s running' "$B_SESS_ACTIVE"
  else
    printf '⚙ idle'
  fi
}
seg_sessions_med() {
  if [ "$B_SESS_ACTIVE" -gt 0 ] && [ -n "$B_SESS_ROLES" ]; then
    printf '⚙ %s (%s)' "$B_SESS_ACTIVE" "$B_SESS_ROLES"
  elif [ "$B_SESS_ACTIVE" -gt 0 ]; then
    printf '⚙ %s' "$B_SESS_ACTIVE"
  else
    printf '⚙ idle'
  fi
}
seg_sessions_nar() {
  if [ "$B_SESS_ACTIVE" -gt 0 ]; then
    printf '⚙ %s running' "$B_SESS_ACTIVE"
  else
    printf '⚙ idle'
  fi
}

# -- last completed --
seg_last_wide() {
  [ -z "$B_LAST_ROLE" ] && return
  local ago="${B_LAST_AGO:-0}"
  local timestr
  if [ "$ago" -le 0 ] 2>/dev/null; then timestr="just now"; else timestr="${ago}m"; fi
  printf '✓ %s %s' "$B_LAST_ROLE" "$timestr"
}
seg_last_med() { seg_last_wide; }  # same for medium
seg_last_nar() { :; }              # omit in narrow

# -- jobs --
seg_jobs_wide() {
  [ "$B_JOBS" -gt 0 ] && printf '🔧 %s jobs' "$B_JOBS"
}
seg_jobs_med() {
  [ "$B_JOBS" -gt 0 ] && printf '🔧 %s' "$B_JOBS"
}
seg_jobs_nar() {
  [ "$B_JOBS" -gt 0 ] && printf '🔧 %s' "$B_JOBS"
}

# -- cost --
seg_cost_wide() { [ -n "$COST_STR" ] && printf '🪙 %s/d' "$COST_STR"; }
seg_cost_med()  { [ -n "$COST_STR" ] && printf '🪙 %s'   "$COST_STR"; }
seg_cost_nar()  { [ -n "$COST_STR" ] && printf '🪙 %s'   "$COST_STR"; }

# -- schedule next --
seg_sched_next_wide() {
  [ -z "$B_SCHED_NEXT_TIME" ] && return
  local name="$B_SCHED_NEXT_NAME"
  # Truncate name to 15 chars for wide
  name="${name:0:15}"
  printf '⏰ %s %s' "$B_SCHED_NEXT_TIME" "$name"
}
seg_sched_next_med() {
  [ -z "$B_SCHED_NEXT_TIME" ] && return
  local name="$B_SCHED_NEXT_NAME"
  # Truncate name to 8 chars for medium (first word)
  name="${name%% *}"
  name="${name:0:8}"
  printf '⏰ %s %s' "$B_SCHED_NEXT_TIME" "$name"
}
seg_sched_next_nar() {
  [ -z "$B_SCHED_NEXT_TIME" ] && return
  printf '⏰ %s' "$B_SCHED_NEXT_TIME"
}

# -- schedule roster --
seg_roster_wide() {
  [ "$B_SCHED_ACTIVE" -eq 0 ] && return
  if [ "$B_SCHED_DEFERRED" -gt 0 ]; then
    printf '📋 %s/%sdef' "$B_SCHED_ACTIVE" "$B_SCHED_DEFERRED"
  else
    printf '📋 %s' "$B_SCHED_ACTIVE"
  fi
}
seg_roster_med() {
  [ "$B_SCHED_ACTIVE" -eq 0 ] && return
  printf '📋 %s' "$B_SCHED_ACTIVE"
}
seg_roster_nar() { :; }   # omit in narrow

# -- ngrok --
seg_ngrok_wide() { [ "$B_NGROK" -eq 1 ] && printf '🌐 tunnel'; }
seg_ngrok_med()  { [ "$B_NGROK" -eq 1 ] && printf '🌐'; }
seg_ngrok_nar()  { :; }

# -- recall --
seg_recall_wide() {
  [ "$B_RECALL" -gt 0 ] && printf '🧠 %sr/1h' "$B_RECALL"
}
seg_recall_med() {
  [ "$B_RECALL" -gt 0 ] && printf '🧠 %s' "$B_RECALL"
}
seg_recall_nar() {
  [ "$B_RECALL" -gt 0 ] && printf '🧠 %s' "$B_RECALL"
}

# ── Build lines ──────────────────────────────────────────────────────────────
join_dot() {
  # Join non-empty arguments with ' · '
  local first=1
  local out=""
  for seg in "$@"; do
    [ -z "$seg" ] && continue
    if [ "$first" -eq 1 ]; then
      out="$seg"
      first=0
    else
      out="$out · $seg"
    fi
  done
  printf '%s' "$out"
}

if [ "$COLS" -ge 120 ]; then
  # Wide (>=120)
  L1="$(join_dot \
    "$(seg_sessions_wide)" \
    "$(seg_last_wide)" \
    "$(seg_jobs_wide)" \
    "$(seg_cost_wide)")"
  L2="$(join_dot \
    "$(seg_sched_next_wide)" \
    "$(seg_roster_wide)" \
    "$(seg_ngrok_wide)" \
    "$(seg_recall_wide)")"
elif [ "$COLS" -ge 80 ]; then
  # Medium (80-119)
  L1="$(join_dot \
    "$(seg_sessions_med)" \
    "$(seg_last_med)" \
    "$(seg_jobs_med)" \
    "$(seg_cost_med)")"
  L2="$(join_dot \
    "$(seg_sched_next_med)" \
    "$(seg_roster_med)" \
    "$(seg_ngrok_med)" \
    "$(seg_recall_med)")"
else
  # Narrow (<80)
  L1="$(join_dot \
    "$(seg_sessions_nar)" \
    "$(seg_jobs_nar)" \
    "$(seg_cost_nar)")"
  L2="$(join_dot \
    "$(seg_sched_next_nar)" \
    "$(seg_recall_nar)")"
fi

# Always emit both lines (even if empty — Claude Code renders them stacked)
printf '%s\n' "${L1:-mixdog}"
printf '%s\n' "${L2:-}"
