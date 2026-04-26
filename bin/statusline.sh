#!/usr/bin/env bash
# mixdog statusline wrapper — v0.1.43
# Line 1 (runtime): model + effort, cost, context window bar, 5h / 7d rate limit, block reset, maint badges (↻ cycle1/cycle2/recap).
# Line 2 (incoming, from mixdog /bridge/status): sessions only — "● N Running (roles)". Suppressed when no work sessions.
#
# Windows/Git Bash perf note: process spawn (fork + exec) on MSYS is ~50-100ms per call.
# 0.1.32 already collapsed ~20 jq calls into 2, but $(seg_*) command substitutions added
# another ~15 subshell forks (~750ms). 0.1.35 inlines every seg_* into a single shell pass
# using bash regex for JSON parsing (zero jq spawns) and direct string concat for L1/L2
# assembly (zero subshell forks). Measured: 2.07s → ~0.2s on the same machine.
#
# Parses CC stdin JSON with bash `[[ =~ ]]` — good enough for the flat-ish payload we need;
# we never traverse arbitrary nesting, only named keys inside known objects.

# ── Terminal width ──────────────────────────────────────────────────────────
# Prefer $COLUMNS env (CC sets it). Skip `tput cols` — it costs a fork and
# returns 80 on piped stdout anyway. Default wide.
COLS="${COLUMNS:-120}"
case "$COLS" in
  ''|*[!0-9]*) COLS=120 ;;
esac

# ── Read Claude Code stdin JSON ─────────────────────────────────────────────
CC_JSON=""
if [ ! -t 0 ]; then
  CC_JSON="$(cat 2>/dev/null || true)"
  # Debug dump (overwritten every tick); lets us inspect the live payload.
  [ -n "$CC_JSON" ] && printf '%s' "$CC_JSON" > "$HOME/.claude/cc-statusline-last.json" 2>/dev/null
fi

# ── Extract Claude Code fields (pure bash regex, no jq spawn) ──────────────
CC_COST=""
CC_MODEL=""
CC_CTX_USED=""
CC_RL_5H=""
CC_RL_7D=""
CC_RL_5H_RESET=""

if [ -n "$CC_JSON" ]; then
  # Flat-ish top-level keys (unique names): cost.total_cost_usd, model.display_name
  [[ $CC_JSON =~ \"total_cost_usd\"[[:space:]]*:[[:space:]]*([0-9.]+) ]] && CC_COST="${BASH_REMATCH[1]}"
  [[ $CC_JSON =~ \"display_name\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && CC_MODEL="${BASH_REMATCH[1]}"

  # Nested "used_percentage" appears in context_window / five_hour / seven_day.
  # Anchor by slicing off the prefix up to the parent key, then regex the first
  # used_percentage/resets_at in the suffix. Bash parameter expansion = no fork,
  # and this handles nested objects (e.g. context_window.current_usage) that the
  # old `[^}]*` anchor could not skip.
  #
  # Scope the context_window slice: cap it at the next sibling key "rate_limits"
  # so a cold-start payload (where context_window has no used_percentage yet)
  # cannot accidentally pick up the five_hour used_percentage. Missing field →
  # CC_CTX_USED stays empty → the bar is omitted instead of showing a wrong value.
  _CTX_TAIL="${CC_JSON#*\"context_window\"}"
  if [ "$_CTX_TAIL" != "$CC_JSON" ]; then
    _CTX_SCOPE="${_CTX_TAIL%%\"rate_limits\"*}"
    [[ $_CTX_SCOPE =~ \"used_percentage\"[[:space:]]*:[[:space:]]*([0-9.]+) ]] && CC_CTX_USED="${BASH_REMATCH[1]}"
    unset _CTX_SCOPE
  fi
  _5H_TAIL="${CC_JSON#*\"five_hour\"}"
  if [ "$_5H_TAIL" != "$CC_JSON" ]; then
    [[ $_5H_TAIL =~ \"used_percentage\"[[:space:]]*:[[:space:]]*([0-9.]+) ]] && CC_RL_5H="${BASH_REMATCH[1]}"
    [[ $_5H_TAIL =~ \"resets_at\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && CC_RL_5H_RESET="${BASH_REMATCH[1]}"
  fi
  _7D_TAIL="${CC_JSON#*\"seven_day\"}"
  [ "$_7D_TAIL" != "$CC_JSON" ] && [[ $_7D_TAIL =~ \"used_percentage\"[[:space:]]*:[[:space:]]*([0-9.]+) ]] && CC_RL_7D="${BASH_REMATCH[1]}"
  unset _CTX_TAIL _5H_TAIL _7D_TAIL
fi

# ── Extract effort level ────────────────────────────────────────────────────
# Env var set by parent; avoids reading settings.json at all.
CC_EFFORT="${CLAUDE_CODE_EFFORT_LEVEL:-}"
if [ -z "$CC_EFFORT" ] && [ -r "$HOME/.claude/settings.json" ]; then
  _SETTINGS="$(cat "$HOME/.claude/settings.json" 2>/dev/null || true)"
  [[ $_SETTINGS =~ \"effortLevel\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] && CC_EFFORT="${BASH_REMATCH[1]}"
  unset _SETTINGS
fi

# ── Fetch mixdog /bridge/status ──────────────────────────────────────────────
# Discovery:
#   1. Advertisement file (~/.claude/mixdog-status.json) — MCP status server port.
#   2. Legacy port 3458 — setup-server when /mixdog:config is open.
# We try advert first. Only fall back to 3458 if advert is missing or the first curl fails
# with a connection error (not a timeout), to avoid burning 1s on idle.
BRIDGE_JSON=""
STATUS_ADVERT="$HOME/.claude/mixdog-status.json"
STATUS_PORT=""
if [ -r "$STATUS_ADVERT" ]; then
  _ADVERT="$(cat "$STATUS_ADVERT" 2>/dev/null || true)"
  [[ $_ADVERT =~ \"port\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && STATUS_PORT="${BASH_REMATCH[1]}"
  unset _ADVERT
fi
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

# ── Extract bridge fields (pure bash regex) ─────────────────────────────────
B_SESS_ACTIVE=0
B_SESS_ROLES=""
B_LAST_ROLE=""
B_LAST_AGO=""
B_SCHED_NEXT_AT=""
B_SCHED_NEXT_NAME=""
B_SCHED_ACTIVE=0
B_SCHED_DEFERRED=0
B_RECALL=0
B_JOBS=0
B_RECAP_RUNNING=false
B_RECAP_STARTED_AT=""
B_RECAP_LAST_COMPLETED_AT=""
B_NGROK=0
B_DISCORD_UNREAD=""

if [ -n "$BRIDGE_JSON" ]; then
  # Anchor "active" on the sessions object (first occurrence); schedule has its own "active"
  # which we extract separately by anchoring on "schedule".
  [[ $BRIDGE_JSON =~ \"sessions\"[[:space:]]*:[[:space:]]*\{[^}]*\"active\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_SESS_ACTIVE="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"sessions\"[[:space:]]*:[[:space:]]*\{[^}]*\"roles\"[[:space:]]*:[[:space:]]*\[([^]]*)\] ]] && B_SESS_ROLES_RAW="${BASH_REMATCH[1]}"
  if [ -n "${B_SESS_ROLES_RAW:-}" ]; then
    # Strip quotes and spaces, flatten to comma-separated. Pure bash: substring ops only.
    B_SESS_ROLES="${B_SESS_ROLES_RAW//\"/}"
    B_SESS_ROLES="${B_SESS_ROLES// /}"
  fi

  [[ $BRIDGE_JSON =~ \"lastCompleted\"[[:space:]]*:[[:space:]]*\{[^}]*\"role\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && B_LAST_ROLE="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"lastCompleted\"[[:space:]]*:[[:space:]]*\{[^}]*\"agoMinutes\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_LAST_AGO="${BASH_REMATCH[1]}"

  # Schedule next fireAt (ms epoch) + name
  [[ $BRIDGE_JSON =~ \"next\"[[:space:]]*:[[:space:]]*\{[^}]*\"fireAt\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_SCHED_NEXT_AT="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"next\"[[:space:]]*:[[:space:]]*\{[^}]*\"name\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && B_SCHED_NEXT_NAME="${BASH_REMATCH[1]}"

  # Schedule.active / deferred — anchored on "schedule" to disambiguate from sessions.active.
  [[ $BRIDGE_JSON =~ \"schedule\"[[:space:]]*:[[:space:]]*\{[^}]*\"active\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_SCHED_ACTIVE="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"schedule\"[[:space:]]*:[[:space:]]*\{[^}]*\"deferred\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_SCHED_DEFERRED="${BASH_REMATCH[1]}"

  [[ $BRIDGE_JSON =~ \"recallLastHour\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_RECALL="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"jobs\"[[:space:]]*:[[:space:]]*\{[^}]*\"count\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_JOBS="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"recap\"[[:space:]]*:[[:space:]]*\{[^}]*\"running\"[[:space:]]*:[[:space:]]*(true|false) ]] && B_RECAP_RUNNING="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"recap\"[[:space:]]*:[[:space:]]*\{[^}]*\"startedAt\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_RECAP_STARTED_AT="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"recap\"[[:space:]]*:[[:space:]]*\{[^}]*\"lastCompletedAt\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_RECAP_LAST_COMPLETED_AT="${BASH_REMATCH[1]}"
  [[ $BRIDGE_JSON =~ \"ngrok\"[[:space:]]*:[[:space:]]*\{[^}]*\"online\"[[:space:]]*:[[:space:]]*(true|false) ]] && {
    [ "${BASH_REMATCH[1]}" = "true" ] && B_NGROK=1 || B_NGROK=0
  }
  [[ $BRIDGE_JSON =~ \"discord\"[[:space:]]*:[[:space:]]*\{[^}]*\"totalUnread\"[[:space:]]*:[[:space:]]*([0-9]+) ]] && B_DISCORD_UNREAD="${BASH_REMATCH[1]}"
fi

# ── Format helpers (all inline; no function calls) ──────────────────────────

# Model short form — bash parameter expansion (no spawn).
# Collapse "(1M context)" → "(1M)" and normalise punctuation.
MODEL_STR=""
if [ -n "$CC_MODEL" ]; then
  _raw="$CC_MODEL"
  _raw="${_raw/(1M context)/(1M)}"
  case "$_raw" in
    *Opus*)   MODEL_STR="Opus${_raw#*Opus}" ;;
    *Sonnet*) MODEL_STR="Sonnet${_raw#*Sonnet}" ;;
    *Haiku*)  MODEL_STR="Haiku${_raw#*Haiku}" ;;
    *)        MODEL_STR="$_raw" ;;
  esac
  unset _raw
fi
MODEL_SHORT="${MODEL_STR%% *}"

# Effort — uppercase via bash ${var^^} (bash 4+; Git Bash has it).
EFFORT_STR=""
if [ -n "$CC_EFFORT" ]; then
  EFFORT_STR="${CC_EFFORT^^}"
fi

# Context int — bash arithmetic trims fractional part (no awk).
# Default to 0 when the payload hasn't populated context_window yet, so the
# bar starts at 0% instead of being hidden.
CTX_INT="0"
if [ -n "$CC_CTX_USED" ]; then
  printf -v CTX_INT "%.0f" "$CC_CTX_USED" 2>/dev/null || CTX_INT="0"
fi

RL_5H_INT=""
if [ -n "$CC_RL_5H" ]; then
  printf -v RL_5H_INT "%.0f" "$CC_RL_5H" 2>/dev/null || RL_5H_INT=""
fi

RL_7D_INT=""
if [ -n "$CC_RL_7D" ]; then
  printf -v RL_7D_INT "%.0f" "$CC_RL_7D" 2>/dev/null || RL_7D_INT=""
fi

# Reset HH:MM — single `date` call (unavoidable unless we bring in a pure-bash epoch→HHMM).
RESET_STR=""
if [ -n "$CC_RL_5H_RESET" ]; then
  RESET_STR="$(date -d "@$CC_RL_5H_RESET" '+%H:%M' 2>/dev/null || date -r "$CC_RL_5H_RESET" '+%H:%M' 2>/dev/null || true)"
fi

# ── ANSI colour helpers ────────────────────────────────────────────────────
# Red ≥90, yellow ≥70, default otherwise. Uses \033 which printf expands.
_ANSI_RESET=$'\033[0m'
_ANSI_BOLD=$'\033[1m'
_ANSI_DIM=$'\033[2m'
_ANSI_RED=$'\033[31m'
_ANSI_GREEN=$'\033[32m'
_ANSI_YELLOW=$'\033[33m'
_ANSI_BLUE=$'\033[34m'
_ANSI_MAGENTA=$'\033[35m'
_ANSI_CYAN=$'\033[36m'
colour_pct() {
  # $1 = integer pct. Sets COLOURED. Always coloured so the gradient is visible.
  local p="$1"
  if [ "$p" -ge 90 ] 2>/dev/null; then COLOURED="${_ANSI_RED}${p}%${_ANSI_RESET}"
  elif [ "$p" -ge 70 ] 2>/dev/null; then COLOURED="${_ANSI_YELLOW}${p}%${_ANSI_RESET}"
  else COLOURED="${_ANSI_GREEN}${p}%${_ANSI_RESET}"; fi
}

# Bar — pure bash loop, no spawns.
make_bar() {
  # $1=pct, $2=cells. Sets BAR_OUT.
  BAR_OUT=""
  local pct="$1" cells="$2" filled i
  [ -z "$pct" ] && return
  [ "$cells" -le 0 ] 2>/dev/null && return
  filled=$(( pct * cells / 100 ))
  [ "$filled" -lt 0 ] && filled=0
  [ "$filled" -gt "$cells" ] && filled="$cells"
  if [ "$pct" -gt 0 ] && [ "$filled" -eq 0 ]; then filled=1; fi
  i=0
  while [ "$i" -lt "$filled" ]; do BAR_OUT="${BAR_OUT}▓"; i=$((i+1)); done
  while [ "$i" -lt "$cells" ]; do BAR_OUT="${BAR_OUT}░"; i=$((i+1)); done
}

# Schedule next HH:MM — convert ms epoch to HH:MM via single `date`.
SCHED_NEXT_HHMM=""
if [ -n "$B_SCHED_NEXT_AT" ]; then
  _secs=$(( B_SCHED_NEXT_AT / 1000 ))
  SCHED_NEXT_HHMM="$(date -d "@$_secs" '+%H:%M' 2>/dev/null || date -r "$_secs" '+%H:%M' 2>/dev/null || true)"
  unset _secs
fi

# ── Build L1 (runtime) as a single string with inline segments ──────────────
# Join helper: append $1 to L1 with " │ " separator if both non-empty.
# Dim separator — defined once, reused across add_l1 / add_l2.
_SEP="${_ANSI_DIM}│${_ANSI_RESET}"
L1=""
add_l1() {
  [ -z "$1" ] && return
  if [ -z "$L1" ]; then L1="$1"; else L1="$L1 $_SEP $1"; fi
}

# Model + effort — diamond marker in cyan, model in bold.
if [ -n "$MODEL_STR" ]; then
  if [ "$COLS" -ge 120 ]; then _m="$MODEL_STR"; else _m="$MODEL_SHORT"; fi
  if [ -n "$EFFORT_STR" ]; then
    add_l1 "${_ANSI_CYAN}◆${_ANSI_RESET} ${_ANSI_BOLD}${_m}${_ANSI_RESET} ${_ANSI_DIM}·${_ANSI_RESET} ${_ANSI_BOLD}${EFFORT_STR}${_ANSI_RESET}"
  else
    add_l1 "${_ANSI_CYAN}◆${_ANSI_RESET} ${_ANSI_BOLD}${_m}${_ANSI_RESET}"
  fi
  unset _m
fi

# Context — coloured bar fill: green<70, yellow<90, red>=90; empty cells dim.
if [ -n "$CTX_INT" ]; then
  if   [ "$CTX_INT" -ge 90 ] 2>/dev/null; then _fill="$_ANSI_RED"
  elif [ "$CTX_INT" -ge 70 ] 2>/dev/null; then _fill="$_ANSI_YELLOW"
  else _fill="$_ANSI_GREEN"
  fi
  if   [ "$COLS" -ge 120 ]; then make_bar "$CTX_INT" 14
  elif [ "$COLS" -ge 80 ];  then make_bar "$CTX_INT" 8
  else BAR_OUT=""
  fi
  # Recolour the bar: split into filled (▓) and empty (░) by substitution.
  _filled="${BAR_OUT//░/}"
  _empty="${BAR_OUT//▓/}"
  if [ -n "$BAR_OUT" ]; then
    _bar="${_fill}${_filled}${_ANSI_RESET}${_ANSI_DIM}${_empty}${_ANSI_RESET}"
    add_l1 "${_bar} ${CTX_INT}%"
  else
    add_l1 "${_fill}${CTX_INT}%${_ANSI_RESET}"
  fi
  unset _fill _filled _empty _bar
fi

# Rate limits + reset — numbers coloured by threshold; reset time dim.
if [ -n "$RL_5H_INT" ]; then
  colour_pct "$RL_5H_INT"; add_l1 "${_ANSI_DIM}5H${_ANSI_RESET} $COLOURED"
fi
if [ "$COLS" -ge 80 ]; then
  if [ -n "$RL_7D_INT" ]; then
    colour_pct "$RL_7D_INT"; add_l1 "${_ANSI_DIM}7D${_ANSI_RESET} $COLOURED"
  fi
  [ -n "$RESET_STR" ] && add_l1 "${_ANSI_DIM}↻ ${RESET_STR}${_ANSI_RESET}"
fi

# ── Build L2 (bridge) ───────────────────────────────────────────────────────
L2=""
add_l2() {
  [ -z "$1" ] && return
  if [ -z "$L2" ]; then L2="$1"; else L2="$L2 $_SEP $1"; fi
}

# Sessions — split the raw role list into work vs maint buckets and emit them
# as separate L2 segments.
#
#   work  = worker | reviewer | debugger | tester | researcher
#           → "● N Running (worker, worker, reviewer)" listing every role token
#             in encounter order. No dedupe: parallel fan-out of the same role
#             must remain visible (e.g. two workers → "worker, worker").
#   maint = cycle1-agent | cycle2-agent | recap-agent
#           → "↻ cycle1 ↻ cycle2 ↻ recap" — one badge per maint type that has
#             ANY session running. Counts are intentionally hidden: the bridge
#             commonly spawns ten cycle1 chunks at once and the count adds noise.
#
# Pure bash: parameter expansion to split the comma-separated B_SESS_ROLES.
# No awk, no jq.
_WORK_COUNT=0
_WORK_ORDER=""        # comma-separated, encounter order, no dedupe
_MAINT_HAS_CYCLE1=0
_MAINT_HAS_CYCLE2=0
_MAINT_HAS_RECAP=0

if [ -n "$B_SESS_ROLES" ]; then
  # Replace commas with spaces so the for-loop iterates roles cleanly.
  _ROLES_SPACED="${B_SESS_ROLES//,/ }"
  for _role in $_ROLES_SPACED; do
    [ -z "$_role" ] && continue
    case "$_role" in
      worker|reviewer|debugger|tester|researcher)
        _WORK_COUNT=$(( _WORK_COUNT + 1 ))
        if [ -z "$_WORK_ORDER" ]; then _WORK_ORDER="$_role"
        else _WORK_ORDER="$_WORK_ORDER, $_role"
        fi
        ;;
      cycle1-agent) _MAINT_HAS_CYCLE1=1 ;;
      cycle2-agent) _MAINT_HAS_CYCLE2=1 ;;
      recap-agent)  _MAINT_HAS_RECAP=1 ;;
      *)
        # Unknown role — bucket as work so it stays visible. Better to surface
        # an unrecognised role than silently swallow it.
        _WORK_COUNT=$(( _WORK_COUNT + 1 ))
        if [ -z "$_WORK_ORDER" ]; then _WORK_ORDER="$_role"
        else _WORK_ORDER="$_WORK_ORDER, $_role"
        fi
        ;;
    esac
  done
  unset _ROLES_SPACED _role
fi

# Work sessions on L2: prefer the encounter-ordered role list when available,
# else fall back to the bridge-reported active count for older payloads / odd states.
# Maint flags are intentionally NOT consulted here — maint badges live on L1.
if [ "$_WORK_COUNT" -gt 0 ]; then
  if [ -n "$_WORK_ORDER" ]; then
    add_l2 "${_ANSI_GREEN}●${_ANSI_RESET} ${_ANSI_BOLD}${_WORK_COUNT} Running${_ANSI_RESET} ${_ANSI_DIM}(${_ANSI_RESET}${_ANSI_CYAN}${_WORK_ORDER}${_ANSI_RESET}${_ANSI_DIM})${_ANSI_RESET}"
  else
    add_l2 "${_ANSI_GREEN}●${_ANSI_RESET} ${_ANSI_BOLD}${_WORK_COUNT} Running${_ANSI_RESET}"
  fi
elif [ "$B_SESS_ACTIVE" -gt 0 ] 2>/dev/null; then
  add_l2 "${_ANSI_GREEN}●${_ANSI_RESET} ${_ANSI_BOLD}${B_SESS_ACTIVE} Running${_ANSI_RESET}"
fi

# Maint badges → built here but appended to L1 (see below). Stitch into a
# single segment so the dim "│" separator falls between maint and the
# preceding L1 segment (reset time), not between individual badges.
_MAINT_SEG=""
if [ "$_MAINT_HAS_CYCLE1" -eq 1 ]; then
  _MAINT_SEG="${_ANSI_GREEN}↻${_ANSI_RESET} ${_ANSI_BOLD}cycle1${_ANSI_RESET}"
fi
if [ "$_MAINT_HAS_CYCLE2" -eq 1 ]; then
  if [ -n "$_MAINT_SEG" ]; then _MAINT_SEG="$_MAINT_SEG "; fi
  _MAINT_SEG="${_MAINT_SEG}${_ANSI_GREEN}↻${_ANSI_RESET} ${_ANSI_BOLD}cycle2${_ANSI_RESET}"
fi
if [ "$_MAINT_HAS_RECAP" -eq 1 ]; then
  if [ -n "$_MAINT_SEG" ]; then _MAINT_SEG="$_MAINT_SEG "; fi
  _MAINT_SEG="${_MAINT_SEG}${_ANSI_GREEN}↻${_ANSI_RESET} ${_ANSI_BOLD}recap${_ANSI_RESET}"
fi
[ -n "$_MAINT_SEG" ] && add_l1 "$_MAINT_SEG"
unset _MAINT_SEG
unset _WORK_COUNT _WORK_ORDER _MAINT_HAS_CYCLE1 _MAINT_HAS_CYCLE2 _MAINT_HAS_RECAP

# Jobs / Schedule / Roster / Discord / Recall segments remain removed.


# If L2 is just "Idle", suppress — runtime line already conveys idle state.
if [ "$L2" = "Idle" ]; then
  L2=""
fi

# ── Debug trace: capture moments when the bridge status endpoint doesn't
# respond. Most common cause of L2 suddenly going blank while agents are
# clearly running. Minimal overhead — only writes when BRIDGE_JSON is empty.
if [ -z "$BRIDGE_JSON" ]; then
  _TRACE_DIR="$HOME/.claude/plugins/data/mixdog-trib-plugin"
  if [ -d "$_TRACE_DIR" ]; then
    if [ -r "$STATUS_ADVERT" ]; then _advert=present; else _advert=missing; fi
    printf '%s NOBRIDGE port=%s advert=%s\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" \
      "${STATUS_PORT:-?}" \
      "$_advert" \
      >> "$_TRACE_DIR/statusline-trace.log" 2>/dev/null
    unset _advert
  fi
  unset _TRACE_DIR
fi

printf '%s\n' "${L1:-mixdog}"
[ -n "$L2" ] && printf '%s\n' "$L2"
exit 0
