#!/bin/bash
# Cursor stop-hook adapter → coding-brain harvester.
#
# Cursor project hooks run from the project root and pass hook JSON
# (status / conversation_id / transcript_path) on stdin. When a substantial
# chunk of work finishes, silently spawn the detached harvester
# (distill.sh). Nothing is posted into the chat.
#
# Same debounce state, same distiller, same store as the Claude Code hook —
# ONE brain fed by both tools.

# Never harvest the harvester's own headless session.
if [ -n "$CODING_BRAIN_HARVEST" ]; then
  cat > /dev/null
  echo '{}'
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

vals=$(python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print('\t'.join(str(d.get(k) or '') for k in ('status', 'conversation_id', 'transcript_path')))
")
IFS=$'\t' read -r status conversation_id transcript_path <<EOF
$vals
EOF
[ -z "$status" ] && status="completed"

root="$PWD"
BRAIN_DIR="$root/.coding-brain"
STATE_DIR="$BRAIN_DIR/.state"

if [ "$status" != "completed" ] || [ -z "$conversation_id" ] || [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ] || [ ! -d "$BRAIN_DIR" ]; then
  echo '{}'
  exit 0
fi
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
last=$(cat "$STATE_DIR/$conversation_id" 2>/dev/null || echo 0)
case "$last" in (*[!0-9]*|"") last=0;; esac

if [ $((size - last)) -lt "$THRESHOLD" ]; then
  echo '{}'
  exit 0
fi

# The debounce offset advances only after a successful distill (distill.sh
# writes it) — a lock-skipped or failed harvest keeps its credit and retries
# on the next stop event instead of silently losing that transcript chunk.

# Backoff: after a failed harvest, wait before retrying so a broken engine
# doesn't burn a model call on every stop event.
if [ -n "$(find "$STATE_DIR/last_failure" -mmin -"$BACKOFF_MIN" 2>/dev/null)" ]; then
  echo '{}'
  exit 0
fi

# Fire-and-forget: detach the worker so the hook returns immediately and the
# user's session is never touched. `< /dev/null` guards stdin for the child.
nohup "$SCRIPT_DIR/distill.sh" "$transcript_path" "$root" < /dev/null >/dev/null 2>&1 &

echo '{}'
exit 0
