#!/bin/bash
# Codex notify hook → claude-rem harvester.
#
# Codex has no Stop hook; instead its config.toml `notify` key runs an
# external program with one JSON argument on events like agent-turn-complete.
# The JSON schema is not stable, so we don't depend on it: on every
# invocation we scan for rollouts modified in the last few minutes, map each
# to its workspace via the session_meta cwd (first line), and apply the
# standard claude-rem debounce before spawning the detached harvester.
#
# Debounce offset advances only on successful distill (distill.sh writes it),
# so skipped/failed harvests keep their credit and retry on the next notify.

# Never harvest a harvester's own headless session.
if [ -n "$CLAUDE_REM_HARVEST" ]; then
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CODEX_DIR="${CLAUDE_REM_CODEX_DIR:-$HOME/.codex}"
SESSIONS_DIR="$CODEX_DIR/sessions"
[ -d "$SESSIONS_DIR" ] || exit 0

# The JSON argument ($1) is intentionally unused beyond existing — schema
# varies across codex versions; recency scan below is version-proof.

SPAWNED=0
MAX_SPAWNS=3

find "$SESSIONS_DIR" -name 'rollout-*.jsonl' -mmin -10 2>/dev/null | while IFS= read -r transcript_path; do
  [ "$SPAWNED" -ge "$MAX_SPAWNS" ] && break
  [ -f "$transcript_path" ] || continue

  # session_meta (first line) carries the workspace cwd.
  cwd=$(head -1 "$transcript_path" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print((d.get('payload') or {}).get('cwd') or '')
except Exception:
    print('')
" 2>/dev/null)
  [ -n "$cwd" ] && [ -d "$cwd" ] || continue

  # Find the workspace that owns a coding brain (walk up, like git discovery).
  root="$cwd"
  while [ "$root" != "/" ] && [ ! -d "$root/.claude-rem" ]; do
    root=$(dirname "$root")
  done
  [ -d "$root/.claude-rem" ] || continue

  BRAIN_DIR="$root/.claude-rem"
  STATE_DIR="$BRAIN_DIR/.state"
  mkdir -p "$STATE_DIR"

  THRESHOLD=$(python3 - "$BRAIN_DIR/config.json" harvestThresholdBytes 25000 <<'PY'
import json, sys
try:
    print(int(json.load(open(sys.argv[1])).get(sys.argv[2])))
except Exception:
    print(sys.argv[3])
PY
)
  BACKOFF_MIN=$(python3 - "$BRAIN_DIR/config.json" failureBackoffMinutes 10 <<'PY'
import json, sys
try:
    print(int(json.load(open(sys.argv[1])).get(sys.argv[2])))
except Exception:
    print(sys.argv[3])
PY
)

  stem=$(basename "$transcript_path" .jsonl)
  size=$(stat -f%z "$transcript_path" 2>/dev/null || stat -c%s "$transcript_path" 2>/dev/null || echo 0)
  last=$(cat "$STATE_DIR/$stem" 2>/dev/null || echo 0)
  case "$last" in (*[!0-9]*|"") last=0;; esac
  [ $((size - last)) -lt "$THRESHOLD" ] && continue

  # Backoff: after a failed harvest, wait before retrying so a broken engine
  # doesn't burn a model call on every notify event.
  [ -n "$(find "$STATE_DIR/last_failure" -mmin -"$BACKOFF_MIN" 2>/dev/null)" ] && continue

  # Fire-and-forget: detach the worker so codex is never blocked.
  # `< /dev/null` guards stdin for the child.
  nohup "$SCRIPT_DIR/distill.sh" "$transcript_path" "$root" < /dev/null >/dev/null 2>&1 &
  SPAWNED=$((SPAWNED + 1))
done

exit 0
