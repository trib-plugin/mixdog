#!/usr/bin/env bash
# mixdog statusline wrapper — v0.1.25
# Line 1 (runtime): model + effort, cost, context window bar, 5h / 7d rate limit, block reset time.
# Line 2 (incoming, from setup-server /bridge/status): sessions, last completed, jobs, schedule, discord, ngrok, recall.
# Width-responsive: >=120 wide, 80-119 medium, <80 narrow. Graceful degradation on missing jq, unreachable endpoint, or missing stdin.

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
CC_RL_5H=""       # rate_limits.five_hour.used_percentage
CC_RL_7D=""       # rate_limits.seven_day.used_percentage
CC_RL_5H_RESET="" # rate_limits.five_hour.resets_at (unix epoch seconds)

if [ -n "$CC_JSON" ]; then
  HAS_JQ=0
  command -v jq >/dev/null 2>&1 && HAS_JQ=1

  if [ "$HAS_JQ" -eq 1 ]; then
    CC_COST="$(printf '%s' "$CC_JSON"       | jq -r '.cost.total_cost_usd // empty' 2>/dev/null || true)"
    CC_MODEL="$(printf '%s' "$CC_JSON"      | jq -r '.model.display_name // empty' 2>/dev/null || true)"
    CC_CTX_USED="$(printf '%s' "$CC_JSON"   | jq -r '.context_window.used_percentage // empty' 2>/dev/null || true)"
    CC_RL_5H="$(printf '%s' "$CC_JSON"      | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null || true)"
    CC_RL_7D="$(printf '%s' "$CC_JSON"      | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null || true)"
    CC_RL_5H_RESET="$(printf '%s' "$CC_JSON" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null || true)"
  else
    # Fallback: minimal grep/sed extraction (no arrays, simple flat keys)
    CC_COST="$(printf '%s' "$CC_JSON"      | grep -o '"total_cost_usd"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_MODEL="$(printf '%s' "$CC_JSON"     | grep -o '"display_name"[ ]*:[ ]*"[^"]*"' | sed 's/.*:[ ]*"\([^"]*\)"/\1/' | head -1 || true)"
    CC_CTX_USED="$(printf '%s' "$CC_JSON"  | grep -o '"used_percentage"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    # rate_limits extraction: look for five_hour / seven_day blocks (grep/sed approximation)
    CC_RL_5H="$(printf '%s' "$CC_JSON"     | grep -o '"five_hour"[^}]*"used_percentage"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_RL_7D="$(printf '%s' "$CC_JSON"     | grep -o '"seven_day"[^}]*"used_percentage"[ ]*:[ ]*[0-9.]*' | grep -o '[0-9.]*$' | head -1 || true)"
    CC_RL_5H_RESET="$(printf '%s' "$CC_JSON" | grep -o '"five_hour"[^}]*"resets_at"[ ]*:[ ]*[0-9]*' | grep -o '[0-9]*$' | head -1 || true)"
  fi
fi

# ── Extract effort level from ~/.claude/settings.json ────────────────────────
CC_EFFORT=""
if [ -n "${CLAUDE_CODE_EFFORT_LEVEL:-}" ]; then
  CC_EFFORT="$CLAUDE_CODE_EFFORT_LEVEL"
elif command -v jq >/dev/null 2>&1 && [ -r "$HOME/.claude/settings.json" ]; then
  CC_EFFORT="$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.json" 2>/dev/null || true)"
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
B_DISCORD_UNREAD=""  # empty = unavailable; "0" = available but zero

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
    B_DISCORD_UNREAD="$(printf '%s' "$BRIDGE_JSON" | jq -r '.discord.totalUnread // empty' 2>/dev/null || true)"
  else
    # grep/sed fallback for critical scalars
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
# B_DISCORD_UNREAD: keep empty if not present (omit segment); sanitise if present
case "$B_DISCORD_UNREAD" in ''|*[!0-9]*) B_DISCORD_UNREAD="" ;; esac

# ── Rate limit percentages (integer) ─────────────────────────────────────────
RL_5H_INT=""   # integer % or empty
RL_7D_INT=""   # integer % or empty
if [ -n "$CC_RL_5H" ]; then
  RL_5H_INT="$(printf '%s' "$CC_RL_5H" | awk '{printf "%d", $1+0.5}' 2>/dev/null || true)"
  case "$RL_5H_INT" in ''|*[!0-9]*) RL_5H_INT="" ;; esac
fi
if [ -n "$CC_RL_7D" ]; then
  RL_7D_INT="$(printf '%s' "$CC_RL_7D" | awk '{printf "%d", $1+0.5}' 2>/dev/null || true)"
  case "$RL_7D_INT" in ''|*[!0-9]*) RL_7D_INT="" ;; esac
fi

# ── Format helpers ───────────────────────────────────────────────────────────
fmt_cost() {
  # $1 = raw float from jq/grep; outputs "$X.XX" or ""
  local v="$1"
  [ -z "$v" ] && return
  printf '%.2f' "$v" 2>/dev/null | awk '{printf "$%s", $0}'
}
COST_STR=""
if [ -n "$CC_COST" ]; then
  COST_STR="$(fmt_cost "$CC_COST")"
fi

# Short model name: keep only the family word ("Opus", "Sonnet", "Haiku") + trailing version.
# Falls back to the raw display_name if no match.
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

# Effort: upper-case, e.g. "XHIGH", "HIGH", "MEDIUM"
EFFORT_STR=""
if [ -n "$CC_EFFORT" ]; then
  EFFORT_STR="$(printf '%s' "$CC_EFFORT" | tr '[:lower:]' '[:upper:]')"
fi

# Context window integer %
CTX_INT=""
if [ -n "$CC_CTX_USED" ]; then
  CTX_INT="$(printf '%s' "$CC_CTX_USED" | awk '{printf "%d", $1+0.5}' 2>/dev/null || true)"
  case "$CTX_INT" in ''|*[!0-9]*) CTX_INT="" ;; esac
fi

# Progress bar for context: $1 = pct 0..100, $2 = total cells
fmt_bar() {
  local pct="$1" cells="$2" filled i out=""
  [ -z "$pct" ] && return
  [ "$cells" -le 0 ] 2>/dev/null && return
  filled=$(( pct * cells / 100 ))
  [ "$filled" -lt 0 ] && filled=0
  [ "$filled" -gt "$cells" ] && filled="$cells"
  # Ensure any non-zero percentage shows at least one filled cell
  if [ "$pct" -gt 0 ] && [ "$filled" -eq 0 ]; then filled=1; fi
  i=0
  while [ "$i" -lt "$filled" ]; do out="${out}▓"; i=$((i+1)); done
  while [ "$i" -lt "$cells" ]; do out="${out}░"; i=$((i+1)); done
  printf '%s' "$out"
}

# Reset time formatter: unix epoch seconds → "HH:MM" local time. Empty if unparseable.
fmt_reset_hhmm() {
  local v="$1"
  [ -z "$v" ] && return
  case "$v" in ''|*[!0-9]*) return ;; esac
  # Try GNU date first, then BSD date, then awk+strftime
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
# Model + Effort
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
  local m="${MODEL_STR%% *}"   # first word only
  if [ -n "$EFFORT_STR" ]; then
    printf '%s · %s' "$m" "$EFFORT_STR"
  else
    printf '%s' "$m"
  fi
}

# Cost
seg_cost_l1() { [ -n "$COST_STR" ] && printf '%s' "$COST_STR"; }

# Context Window (with bar on wide/med, percentage-only on narrow)
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

# 5H / 7D rate limits
seg_rl5h_l1() { [ -n "$RL_5H_INT" ] && printf '5H %s%%' "$RL_5H_INT"; }
seg_rl7d_l1() { [ -n "$RL_7D_INT" ] && printf '7D %s%%' "$RL_7D_INT"; }

# Reset time
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

# Drop L2 when only the default "Idle" token would be emitted (no events to show)
if [ "$L2" = "Idle" ]; then
  L2=""
fi

# Always emit line 1; emit line 2 only if non-empty so Claude Code doesn't render an empty row.
printf '%s\n' "${L1:-mixdog}"
[ -n "$L2" ] && printf '%s\n' "$L2"
