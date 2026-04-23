#!/usr/bin/env bash
# mixdog statusline wrapper — v0.1.33
# Line 1 (runtime): model + effort, cost, context window bar, 5h / 7d rate limit, block reset time.
# Line 2 (incoming, from mixdog /bridge/status): sessions, last completed, jobs, schedule, discord, ngrok, recall.
# Endpoint discovery: advertisement file → MCP status server → legacy setup-server (3458).
# Width-responsive: >=120 wide, 80-119 medium, <80 narrow. Graceful degradation on missing jq, unreachable endpoint, or missing stdin.
#
# Windows perf note: every external process spawn on Windows/Git Bash costs ~200-300ms.
# Claude Code enforces a 5s statusLine timeout and calls AbortController.abort() on every
# re-trigger. 0.1.30 spawned jq ~20 times per invocation (~5s total) and never finished
# before being killed. 0.1.32 collapses each JSON payload into a single jq filter that
# emits a tab-separated line, reducing total runtime from ~4.5s to <1s on Windows.

set -euo pipefail 2>/dev/null || true   # best-effort; some POSIX shells vary

# ── Terminal width ──────────────────────────────────────────────────────────
COLS="${COLUMNS:-}"
if [ -z "$COLS" ]; then
  COLS="$(tput cols 2>/dev/null || echo 80)"
fi
case "$COLS" in
  ''|*[!0-9]*) COLS=80 ;;
esac

# ── Read Claude Code stdin JSON ─────────────────────────────────────────────
CC_JSON=""
if [ ! -t 0 ]; then
  CC_JSON="$(cat 2>/dev/null || true)"
fi

# ── Extract Claude Code fields (single jq call) ─────────────────────────────
CC_COST=""
CC_MODEL=""
CC_CTX_USED=""
CC_RL_5H=""
CC_RL_7D=""
CC_RL_5H_RESET=""

HAS_JQ=0
command -v jq >/dev/null 2>&1 && HAS_JQ=1

if [ -n "$CC_JSON" ]; then
  if [ "$HAS_JQ" -eq 1 ]; then
    # Use  (ASCII Unit Separator) as delimiter. bash `read` with a whitespace
    # IFS collapses consecutive delimiters, which would misalign columns when
    # optional fields are empty. Trailing \r is stripped (jq on Git Bash emits CRLF).
    _CC_ROW="$(printf '%s' "$CC_JSON" | jq -r '[
      (.cost.total_cost_usd // "" | tostring),
      (.model.display_name // ""),
      (.context_window.used_percentage // "" | tostring),
      (.rate_limits.five_hour.used_percentage // "" | tostring),
      (.rate_limits.seven_day.used_percentage // "" | tostring),
      (.rate_limits.five_hour.resets_at // "" | tostring)
    ] | join("\u001f")' 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$_CC_ROW" ]; then
      IFS=$'\x1f' read -r CC_COST CC_MODEL CC_CTX_USED CC_RL_5H CC_RL_7D CC_RL_5H_RESET <<< "$_CC_ROW" || true
    fi
  else
    # Fallback: minimal grep/sed extraction (rare on any target platform)
    CC_COST="$(printf '%s' "$CC_JSON"      | grep -o '"total_cost_usd"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_MODEL="$(printf '%s' "$CC_JSON"     | grep -o '"display_name"[ ]*:[ ]*"[^"]*"' | sed 's/.*:[ ]*"\([^"]*\)"/\1/' | head -1 || true)"
    CC_CTX_USED="$(printf '%s' "$CC_JSON"  | grep -o '"used_percentage"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_RL_5H="$(printf '%s' "$CC_JSON"     | grep -o '"five_hour"[^}]*"used_percentage"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_RL_7D="$(printf '%s' "$CC_JSON"     | grep -o '"seven_day"[^}]*"used_percentage"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_RL_5H_RESET="$(printf '%s' "$CC_JSON" | grep -o '"five_hour"[^}]*"resets_at"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || true)"
  fi
fi

# ── Extract effort level ────────────────────────────────────────────────────
# Prefer env var (set by parent process) — avoids a jq spawn on every invocation.
CC_EFFORT="${CLAUDE_CODE_EFFORT_LEVEL:-}"
if [ -z "$CC_EFFORT" ] && [ "$HAS_JQ" -eq 1 ] && [ -r "$HOME/.claude/settings.json" ]; then
  CC_EFFORT="$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.json" 2>/dev/null || true)"
fi

# ── Fetch mixdog /bridge/status ──────────────────────────────────────────────
# Discovery order:
#   1. Advertisement file (~/.claude/mixdog-status.json) written by the
#      MCP-embedded status server. Ephemeral port, refreshed on every boot.
#   2. Legacy port 3458 — setup-server when /mixdog:config is open.
BRIDGE_JSON=""
STATUS_ADVERT="$HOME/.claude/mixdog-status.json"
STATUS_PORT=""
if [ -r "$STATUS_ADVERT" ]; then
  if [ "$HAS_JQ" -eq 1 ]; then
    STATUS_PORT="$(jq -r '.port // empty' "$STATUS_ADVERT" 2>/dev/null || true)"
  else
    STATUS_PORT="$(grep -o '"port"[ ]*:[ ]*[0-9]*' "$STATUS_ADVERT" | grep -o '[0-9]*$' | head -1 || true)"
  fi
fi
case "$STATUS_PORT" in ''|*[!0-9]*) STATUS_PORT="" ;; esac
if [ -n "$STATUS_PORT" ]; then
  BRIDGE_JSON="$(curl -s --max-time 1 "http://127.0.0.1:${STATUS_PORT}/bridge/status?format=json" 2>/dev/null || true)"
fi
if [ -z "$BRIDGE_JSON" ]; then
  BRIDGE_JSON="$(curl -s --max-time 1 'http://127.0.0.1:3458/bridge/status?format=json' 2>/dev/null || true)"
fi
case "$BRIDGE_JSON" in
  '{'*) : ;;
  *) BRIDGE_JSON="" ;;
esac

# ── Extract bridge fields (single jq call) ──────────────────────────────────
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
B_DISCORD_UNREAD=""

if [ -n "$BRIDGE_JSON" ]; then
  if [ "$HAS_JQ" -eq 1 ]; then
    _B_ROW="$(printf '%s' "$BRIDGE_JSON" | jq -r '[
      (.sessions.active // 0 | tostring),
      (if ((.sessions.roles // []) | length) > 0 then .sessions.roles | join(",") else "" end),
      (.lastCompleted.role // ""),
      (.lastCompleted.agoMinutes // "" | tostring),
      (if .schedule.next then (.schedule.next.fireAt / 1000 | todate | .[11:16]) else "" end),
      (.schedule.next.name // ""),
      (.schedule.active // 0 | tostring),
      (.schedule.deferred // 0 | tostring),
      (.recallLastHour // 0 | tostring),
      (.jobs.count // 0 | tostring),
      (if .ngrok.online then "1" else "0" end),
      (.discord.totalUnread // "" | tostring)
    ] | join("\u001f")' 2>/dev/null | tr -d '\r' || true)"
    if [ -n "$_B_ROW" ]; then
      IFS=$'\x1f' read -r B_SESS_ACTIVE B_SESS_ROLES B_LAST_ROLE B_LAST_AGO \
                        B_SCHED_NEXT_TIME B_SCHED_NEXT_NAME B_SCHED_ACTIVE B_SCHED_DEFERRED \
                        B_RECALL B_JOBS B_NGROK B_DISCORD_UNREAD <<< "$_B_ROW" || true
    fi
  else
    B_SESS_ACTIVE="$(printf '%s' "$BRIDGE_JSON" | grep -o '"active"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || echo 0)"
    B_RECALL="$(printf '%s' "$BRIDGE_JSON"      | grep -o '"recallLastHour"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || echo 0)"
    B_JOBS="$(printf '%s' "$BRIDGE_JSON"        | grep -o '"count"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || echo 0)"
    B_NGROK="$(printf '%s' "$BRIDGE_JSON"       | grep -oE '"online"[ ]*:[ ]*(true|false)' | grep -o 'true\|false' | head -1 | sed 's/true/1/;s/false/0/' || echo 0)"
    B_LAST_ROLE="$(printf '%s' "$BRIDGE_JSON"   | grep -o '"role"[ ]*:[ ]*"[^"]*"' | sed 's/.*:[ ]*"\([^"]*\)"/\1/' | head -1 || true)"
    B_LAST_AGO="$(printf '%s' "$BRIDGE_JSON"    | grep -o '"agoMinutes"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || true)"
    B_SCHED_ACTIVE="$(printf '%s' "$BRIDGE_JSON" | grep -o '"active"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | sed -n '2p' || echo 0)"
    B_DISCORD_UNREAD="$(printf '%s' "$BRIDGE_JSON" | grep -o '"totalUnread"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || true)"
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
case "$B_DISCORD_UNREAD" in ''|*[!0-9]*) B_DISCORD_UNREAD="" ;; esac

# ── Format helpers ───────────────────────────────────────────────────────────
fmt_cost() {
  local v="$1"
  [ -z "$v" ] && return
  printf '%.2f' "$v" 2>/dev/null | awk '{printf "$%s", $0}'
}
COST_STR=""
if [ -n "$CC_COST" ]; then
  COST_STR="$(fmt_cost "$CC_COST")"
fi

fmt_model_short() {
  local m="$1"
  [ -z "$m" ] && return
  case "$m" in
    *Opus*)   printf 'Opus%s'   "$(printf '%s' "$m"   | sed -n 's/.*Opus\(.*\)/\1/p')"   ;;
    *Sonnet*) printf 'Sonnet%s' "$(printf '%s' "$m"   | sed -n 's/.*Sonnet\(.*\)/\1/p')" ;;
    *Haiku*)  printf 'Haiku%s'  "$(printf '%s' "$m"   | sed -n 's/.*Haiku\(.*\)/\1/p')"  ;;
    *)        printf '%s' "$m" ;;
  esac
}
MODEL_STR="$(fmt_model_short "$CC_MODEL")"

EFFORT_STR=""
if [ -n "$CC_EFFORT" ]; then
  EFFORT_STR="$(printf '%s' "$CC_EFFORT" | tr '[:lower:]' '[:upper:]')"
fi

CTX_INT=""
if [ -n "$CC_CTX_USED" ]; then
  CTX_INT="$(printf '%s' "$CC_CTX_USED" | awk '{printf "%d", $1+0.5}' 2>/dev/null || true)"
  case "$CTX_INT" in ''|*[!0-9]*) CTX_INT="" ;; esac
fi

fmt_bar() {
  local pct="$1" cells="$2" filled i out=""
  [ -z "$pct" ] && return
  [ "$cells" -le 0 ] 2>/dev/null && return
  filled=$(( pct * cells / 100 ))
  [ "$filled" -lt 0 ] && filled=0
  [ "$filled" -gt "$cells" ] && filled="$cells"
  if [ "$pct" -gt 0 ] && [ "$filled" -eq 0 ]; then filled=1; fi
  i=0
  while [ "$i" -lt "$filled" ]; do out="${out}▓"; i=$((i+1)); done
  while [ "$i" -lt "$cells" ]; do out="${out}░"; i=$((i+1)); done
  printf '%s' "$out"
}

fmt_reset_hhmm() {
  local v="$1"
  [ -z "$v" ] && return
  case "$v" in ''|*[!0-9]*) return ;; esac
  date -d "@$v" '+%H:%M' 2>/dev/null && return
  date -r "$v" '+%H:%M' 2>/dev/null && return
  awk -v t="$v" 'BEGIN { print strftime("%H:%M", t) }' 2>/dev/null
}
RESET_STR="$(fmt_reset_hhmm "$CC_RL_5H_RESET")"

# Rate limit percentages (integer)
RL_5H_INT=""
RL_7D_INT=""
if [ -n "$CC_RL_5H" ]; then
  RL_5H_INT="$(printf '%s' "$CC_RL_5H" | awk '{printf "%d", $1+0.5}' 2>/dev/null || true)"
  case "$RL_5H_INT" in ''|*[!0-9]*) RL_5H_INT="" ;; esac
fi
if [ -n "$CC_RL_7D" ]; then
  RL_7D_INT="$(printf '%s' "$CC_RL_7D" | awk '{printf "%d", $1+0.5}' 2>/dev/null || true)"
  case "$RL_7D_INT" in ''|*[!0-9]*) RL_7D_INT="" ;; esac
fi

# ── L1 segments (stdin-JSON only) ────────────────────────────────────────────
seg_model_full() {
  [ -z "$MODEL_STR" ] && return
  if [ -n "$EFFORT_STR" ]; then
    printf '%s · %s' "$MODEL_STR" "$EFFORT_STR"
  else
    printf '%s' "$MODEL_STR"
  fi
}
seg_model_short() {
  [ -z "$MODEL_STR" ] && return
  local m="${MODEL_STR%% *}"
  if [ -n "$EFFORT_STR" ]; then
    printf '%s · %s' "$m" "$EFFORT_STR"
  else
    printf '%s' "$m"
  fi
}

seg_cost_l1() { [ -n "$COST_STR" ] && printf '%s' "$COST_STR"; }

seg_ctx_wide() {
  [ -z "$CTX_INT" ] && return
  local bar; bar="$(fmt_bar "$CTX_INT" 10)"
  printf 'Context Window %s %s%%' "$bar" "$CTX_INT"
}
seg_ctx_med() {
  [ -z "$CTX_INT" ] && return
  local bar; bar="$(fmt_bar "$CTX_INT" 6)"
  printf 'Context Window %s %s%%' "$bar" "$CTX_INT"
}
seg_ctx_nar() {
  [ -z "$CTX_INT" ] && return
  printf 'Context %s%%' "$CTX_INT"
}

seg_rl5h_l1() { [ -n "$RL_5H_INT" ] && printf '5H %s%%' "$RL_5H_INT"; }
seg_rl7d_l1() { [ -n "$RL_7D_INT" ] && printf '7D %s%%' "$RL_7D_INT"; }
seg_reset_l1() { [ -n "$RESET_STR" ] && printf 'Reset %s' "$RESET_STR"; }

# ── L2 segments (bridge endpoint only) ───────────────────────────────────────
seg_sessions_l2() {
  if [ "$B_SESS_ACTIVE" -gt 0 ] && [ -n "$B_SESS_ROLES" ]; then
    printf '%s Running (%s)' "$B_SESS_ACTIVE" "$B_SESS_ROLES"
  elif [ "$B_SESS_ACTIVE" -gt 0 ]; then
    printf '%s Running' "$B_SESS_ACTIVE"
  else
    printf 'Idle'
  fi
}
seg_last_l2() {
  [ -z "$B_LAST_ROLE" ] && return
  local ago="${B_LAST_AGO:-0}"
  local timestr
  if [ "$ago" -le 0 ] 2>/dev/null; then timestr="just now"; else timestr="${ago}m"; fi
  printf 'Last %s %s' "$B_LAST_ROLE" "$timestr"
}
seg_jobs_l2()    { [ "$B_JOBS"   -gt 0 ] && printf '%s Jobs'   "$B_JOBS"; }
seg_recall_l2()  { [ "$B_RECALL" -gt 0 ] && printf '%s Recall' "$B_RECALL"; }
seg_ngrok_l2()   { [ "$B_NGROK"  -eq 1 ] && printf 'Tunnel'; }
seg_sched_l2() {
  [ -z "$B_SCHED_NEXT_TIME" ] && return
  local name="${B_SCHED_NEXT_NAME:0:15}"
  if [ -n "$name" ]; then
    printf 'Next %s %s' "$B_SCHED_NEXT_TIME" "$name"
  else
    printf 'Next %s' "$B_SCHED_NEXT_TIME"
  fi
}
seg_roster_l2() {
  [ "$B_SCHED_ACTIVE" -eq 0 ] && return
  if [ "$B_SCHED_DEFERRED" -gt 0 ]; then
    printf '%s Scheduled (%s def)' "$B_SCHED_ACTIVE" "$B_SCHED_DEFERRED"
  else
    printf '%s Scheduled' "$B_SCHED_ACTIVE"
  fi
}
seg_discord_l2() {
  [ -n "$B_DISCORD_UNREAD" ] && [ "$B_DISCORD_UNREAD" -gt 0 ] 2>/dev/null && printf '%s Unread' "$B_DISCORD_UNREAD"
}

# ── Join helpers ─────────────────────────────────────────────────────────────
join_pipe() {
  local first=1
  local out=""
  for seg in "$@"; do
    [ -z "$seg" ] && continue
    if [ "$first" -eq 1 ]; then
      out="$seg"
      first=0
    else
      out="$out │ $seg"
    fi
  done
  printf '%s' "$out"
}

# ── Build lines ──────────────────────────────────────────────────────────────
if [ "$COLS" -ge 120 ]; then
  L1="$(join_pipe \
    "$(seg_model_full)" \
    "$(seg_cost_l1)" \
    "$(seg_ctx_wide)" \
    "$(seg_rl5h_l1)" \
    "$(seg_rl7d_l1)" \
    "$(seg_reset_l1)")"
elif [ "$COLS" -ge 80 ]; then
  L1="$(join_pipe \
    "$(seg_model_short)" \
    "$(seg_cost_l1)" \
    "$(seg_ctx_med)" \
    "$(seg_rl5h_l1)" \
    "$(seg_rl7d_l1)" \
    "$(seg_reset_l1)")"
else
  L1="$(join_pipe \
    "$(seg_model_short)" \
    "$(seg_cost_l1)" \
    "$(seg_ctx_nar)" \
    "$(seg_rl5h_l1)")"
fi

L2="$(join_pipe \
  "$(seg_sessions_l2)" \
  "$(seg_last_l2)" \
  "$(seg_jobs_l2)" \
  "$(seg_sched_l2)" \
  "$(seg_roster_l2)" \
  "$(seg_discord_l2)" \
  "$(seg_ngrok_l2)" \
  "$(seg_recall_l2)")"

if [ "$L2" = "Idle" ]; then
  L2=""
fi

printf '%s\n' "${L1:-mixdog}"
if [ -n "$L2" ]; then
  printf '%s\n' "$L2"
fi
exit 0
