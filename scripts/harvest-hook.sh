#!/bin/bash
# Claude Code Stop-hook adapter → claude-rem harvester.
#
# Reads Claude Code hook JSON (session_id / transcript_path / cwd) from stdin,
# locates the workspace brain by walking up from cwd, and — when the
# transcript has grown enough since the last harvest — silently spawns the
# detached harvester (distill.sh). Nothing is posted into the chat.
#
# Debounce offset advances only on successful distill (distill.sh writes it),
# so skipped/failed harvests keep their credit and retry on the next stop.

# Never harvest a harvester's own headless session.
if [ -n "$CLAUDE_REM_HARVEST" ]; then
  cat > /dev/null
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

# Parse hook JSON with python3 (zero-dependency; jq is not assumed).
vals=$(python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print('\t'.join(str(d.get(k) or '') for k in ('session_id', 'transcript_path', 'cwd')))
")
IFS=$'\t' read -r session_id transcript_path cwd <<EOF
$vals
EOF
[ -z "$cwd" ] && cwd="$PWD"

if [ -z "$session_id" ] || [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  exit 0
fi

# Find the workspace that owns a coding brain (walk up, like git discovery).
root="$cwd"
while [ "$root" != "/" ] && [ ! -d "$root/.claude-rem" ]; do
  root=$(dirname "$root")
done
if [ ! -d "$root/.claude-rem" ]; then
  exit 0
fi

BRAIN_DIR="$root/.claude-rem"
STATE_DIR="$BRAIN_DIR/.state"
mkdir -p "$STATE_DIR"

cfgint() {  # cfgint <key> <default>
  python3 - "$BRAIN_DIR/config.json" "$1" "$2" <<'PY'
import json, sys
try:
    v = json.load(open(sys.argv[1])).get(sys.argv[2])
    print(int(v))
except Exception:
    print(sys.argv[3])
PY
}
THRESHOLD=$(cfgint harvestThresholdBytes 25000)   # ~6k tokens of new transcript
BACKOFF_MIN=$(cfgint failureBackoffMinutes 10)

size=$(stat -f%z "$transcript_path" 2>/dev/null || stat -c%s "$transcript_path" 2>/dev/null || echo 0)
last=$(cat "$STATE_DIR/$session_id" 2>/dev/null || echo 0)
case "$last" in (*[!0-9]*|"") last=0;; esac

if [ $((size - last)) -lt "$THRESHOLD" ]; then
  exit 0
fi

# Backoff: after a failed harvest, wait before retrying so a broken engine
# doesn't burn a model call on every stop event.
if [ -n "$(find "$STATE_DIR/last_failure" -mmin -"$BACKOFF_MIN" 2>/dev/null)" ]; then
  exit 0
fi

# Fire-and-forget: detach the worker so the hook returns immediately and the
# user's session is never touched. `< /dev/null` guards stdin for the child.
nohup "$SCRIPT_DIR/distill.sh" "$transcript_path" "$root" < /dev/null >/dev/null 2>&1 &
exit 0
