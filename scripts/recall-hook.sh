#!/bin/bash
# Claude Code UserPromptSubmit hook — RETRIEVAL.
# Injects the workspace's coding brain (freshness receipt + STATE + topic
# list + search instruction) into context. Runs once per session to avoid
# bloat. Cheap: no LLM call. Stdout from a UserPromptSubmit hook is added to
# the model's context.

# Recursion guard: a harvester's internal `claude` call must inject nothing.
if [ -n "$CODING_BRAIN_HARVEST" ]; then
  cat > /dev/null
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

vals=$(python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print('\t'.join(str(d.get(k) or '') for k in ('session_id', 'cwd')))
")
IFS=$'\t' read -r session_id cwd <<EOF
$vals
EOF
[ -z "$cwd" ] && cwd="$PWD"

# Find the workspace brain (walk up, like git discovery).
root="$cwd"
while [ "$root" != "/" ] && [ ! -d "$root/.coding-brain" ]; do
  root=$(dirname "$root")
done
BRAIN_DIR="$root/.coding-brain"
STATE_FILE="$BRAIN_DIR/STATE.md"
[ -d "$BRAIN_DIR" ] || exit 0
[ -f "$STATE_FILE" ] || exit 0

# Once per session: a marker in .state (cheap, survives hook re-invocations).
MARKER_DIR="$BRAIN_DIR/.state/injected"
mkdir -p "$MARKER_DIR"
if [ -n "$session_id" ]; then
  MARKER="$MARKER_DIR/$session_id"
  [ -f "$MARKER" ] && exit 0
  touch "$MARKER"
  # Keep the marker dir from growing forever.
  find "$MARKER_DIR" -type f -mtime +7 -delete 2>/dev/null
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
  warn=" · WARNING: LAST HARVEST FAILED — brain may be stale (.coding-brain/.state/harvest.log)"
fi
receipt="🧠 brain: last harvest ${freshness}${lastlearn:+ · $lastlearn}${warn}"

echo "[CODING BRAIN] Persistent context for this workspace, distilled from previous sessions. Harvest reconciles claims against git/file evidence before promoting to STATE — still treat this as a starting point and re-check when it matters."
echo
echo "In the VERY FIRST reply of this session ONLY, open with this receipt line verbatim (then a blank line, then your answer). NEVER repeat it in any later reply of this conversation:"
echo "$receipt"
echo
echo "PULL RETRIEVAL: anything not in this dump (past sessions, fixes, how-we-did-X) is searchable — run:"
echo "  $SCRIPT_DIR/search.sh <query words>"
echo "It ranks STATE + all topic notes + all session digests and shows matching lines; then READ the top file(s). Use it BEFORE re-deriving or asking the user about anything that may have happened in a past session."
echo
cat "$STATE_FILE"

if [ -f "$BRAIN_DIR/RULES.md" ]; then
  echo
  echo "=== Learned rules (binding conventions) ==="
  cat "$BRAIN_DIR/RULES.md"
fi

topics=$(ls "$BRAIN_DIR/topics" 2>/dev/null)
if [ -n "$topics" ]; then
  echo
  echo "Topic notes — one rolling file per project, compiled current truth. When the task goes deep on a project, read $BRAIN_DIR/topics/<file> (prefer these over session digests, which are raw history):"
  echo "$topics"
fi

recent=$(ls -t "$BRAIN_DIR/sessions" 2>/dev/null | head -3)
if [ -n "$recent" ]; then
  echo
  echo "Most recent session digests (raw history; topic notes supersede them):"
  echo "$recent"
fi

# Quick notes remembered mid-session that no harvest has folded into STATE
# yet — fresher than STATE, surface them.
pending=$(grep '^- ' "$BRAIN_DIR/NOTES.md" 2>/dev/null | tail -10)
if [ -n "$pending" ]; then
  echo
  echo "Pending quick notes (newer than STATE):"
  echo "$pending"
fi

exit 0
