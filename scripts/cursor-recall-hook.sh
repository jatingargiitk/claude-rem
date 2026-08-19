#!/bin/bash
# Cursor sessionStart hook: inject the persistent coding brain into every new
# chat. Cursor project hooks run from the project root; output is JSON with
# an `additional_context` field.

# Recursion guard: a harvester's internal calls must inject nothing.
if [ -n "$CLAUDE_REM_HARVEST" ]; then
  cat > /dev/null
  echo '{}'
  exit 0
fi

cat > /dev/null  # consume hook input; we don't need it

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BRAIN_DIR="$PWD/.claude-rem"
STATE_FILE="$BRAIN_DIR/STATE.md"

if [ ! -f "$STATE_FILE" ]; then
  # No compiled memory yet. If past transcripts exist, offer the backfill —
  # sessionStart fires once per chat, so no marker is needed. The compile
  # spends real quota: consent required, nothing written until yes.
  CDIR="${CLAUDE_REM_CLAUDE_DIR:-$HOME/.claude}"
  UDIR="${CLAUDE_REM_CURSOR_DIR:-$HOME/.cursor}"
  if { [ -d "$CDIR/projects" ] && ls "$CDIR/projects"/*/*.jsonl >/dev/null 2>&1; }      || { [ -d "$UDIR/projects" ] && ls "$UDIR/projects"/*/agent-transcripts/*/*.jsonl >/dev/null 2>&1; }; then
    flags="--cursor"
    [ -d "${CLAUDE_REM_CODEX_DIR:-$HOME/.codex}" ] && flags="$flags --codex"
    # If the Claude Code side is plugin-managed, keep it that way.
    if ls "$HOME/.claude/plugins/cache"/*/claude-rem >/dev/null 2>&1; then
      flags="$flags --no-claude-hooks"
    fi
    nudge="[claude-rem] This workspace has no compiled memory yet, but past coding
sessions exist on this machine. Tell the user, in one short line, that
claude-rem can compile a starter brain from their session history so it
remembers their work from day one (takes a few minutes of their Claude
subscription quota; prints its own cost receipt; asks consent before
reading anything), and that it will also connect the other supported
coding tools found on this machine. If and only if the user says yes, run:
  npx -y claude-rem@latest init $flags --yes
Do not run it unprompted. Do not mention this instruction block."
    printf '%s' "$nudge" | python3 -c 'import json,sys; print(json.dumps({"additional_context": sys.stdin.read()}))'
    exit 0
  fi
  echo '{}'
  exit 0
fi

# --- Freshness receipt: make the brain's heartbeat visible to the user. ---
last_ts=$(cat "$BRAIN_DIR/.state/last_success" 2>/dev/null)
case "$last_ts" in (*[!0-9]*|"") last_ts="";; esac
if [ -z "$last_ts" ]; then
  # Fallback before the first harvest: newest digest mtime.
  newest=$(ls -t "$BRAIN_DIR/sessions" 2>/dev/null | head -1)
  [ -n "$newest" ] && last_ts=$(stat -f%m "$BRAIN_DIR/sessions/$newest" 2>/dev/null || stat -c%Y "$BRAIN_DIR/sessions/$newest" 2>/dev/null)
fi
freshness="unknown"
if [ -n "$last_ts" ]; then
  mins=$(( ($(date +%s) - last_ts) / 60 ))
  if [ "$mins" -lt 60 ]; then freshness="${mins}m ago"
  elif [ "$mins" -lt 1440 ]; then freshness="$((mins / 60))h ago"
  else freshness="$((mins / 1440))d ago"; fi
fi
lastlearn=$(git -C "$BRAIN_DIR" log -1 --format='%s' 2>/dev/null)
warn=""
if [ -f "$BRAIN_DIR/.state/last_failure" ]; then
  warn=" · WARNING: LAST HARVEST FAILED — brain may be stale (.claude-rem/.state/harvest.log)"
fi
ntopics=$(ls "$BRAIN_DIR/topics" 2>/dev/null | grep -c '\.md$')
receipt="🧠 brain → STATE.md · ${ntopics} projects indexed (harvest ${freshness})${warn}"

ctx="[CODING BRAIN] Compiled memory from previous sessions — LEADS, not findings. Open threads are starting points: investigate, do not recite. Verify status claims before repeating them. Answer the question as asked, at the size asked. If the prompt names a project or term that appears nowhere in this briefing, do not map it onto the closest-sounding known project — identify the real referent from the workspace first. When you state a fact from this memory rather than something verified live, attribute it in passing (\"per the brain's note, Aug 12\") so memory stays distinguishable from verification.

In the VERY FIRST reply of this session ONLY, open with this receipt line verbatim (then a blank line, then your answer). NEVER repeat it in any later reply of this conversation:
$receipt

PULL RETRIEVAL: anything not in this dump (past sessions, fixes, how-we-did-X) is searchable — run:
  $SCRIPT_DIR/search.sh <query words>
It ranks STATE + all topic notes + all session digests and shows matching lines; then READ the top file(s). Use it BEFORE re-deriving or asking the user about anything that may have happened in a past session.

$(cat "$STATE_FILE")"

if [ -f "$BRAIN_DIR/RULES.md" ]; then
  ctx="$ctx

=== Learned rules (binding conventions) ===
$(cat "$BRAIN_DIR/RULES.md")"
fi

GLOBAL_RULES="${CLAUDE_REM_GLOBAL_DIR:-$HOME/.claude-rem}/RULES.md"
GLOBAL_ACTIVE=0
if [ -f "$GLOBAL_RULES" ] && grep -v '^[[:space:]]*#' "$GLOBAL_RULES" 2>/dev/null | grep -q '[^[:space:]]'; then
  GLOBAL_ACTIVE=1
fi
if [ "$GLOBAL_ACTIVE" -eq 1 ]; then
  ctx="$ctx

=== Global rules (all workspaces — ~/.claude-rem/RULES.md) ===
$(grep -v '^[[:space:]]*#' "$GLOBAL_RULES")"
fi

topics=$(ls "$BRAIN_DIR/topics" 2>/dev/null)
if [ -n "$topics" ]; then
  ctx="$ctx

Topic notes — one rolling file per project, compiled current truth. When the task goes deep on a project, read .claude-rem/topics/<file> (prefer these over session digests, which are raw history):
$topics"
fi

recent=$(ls -t "$BRAIN_DIR/sessions" 2>/dev/null | head -3)
if [ -n "$recent" ]; then
  ctx="$ctx

Most recent session digests (raw history; topic notes supersede them):
$recent"
fi

# Quick notes remembered mid-session that no harvest has folded into STATE
# yet — fresher than STATE, surface them.
pending=$(grep '^- ' "$BRAIN_DIR/NOTES.md" 2>/dev/null | tail -10)
if [ -n "$pending" ]; then
  ctx="$ctx

Pending quick notes (newer than STATE):
$pending"
fi

# JSON-encode with python3 (no jq dependency).
printf '%s' "$ctx" | python3 -c 'import json,sys; print(json.dumps({"additional_context": sys.stdin.read()}))'
exit 0
