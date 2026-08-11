#!/bin/bash
# coding-brain harvester engine. Spawned by the harvest hooks (or by
# `coding-brain harvest`); never runs inside the user's chat session.
#
# Engine: `claude -p` on the user's existing Claude subscription — no API key.
#  - Isolation: --setting-sources "" (no CLAUDE.md, no user hooks, no plugins).
#  - Cost: transcript pre-condensed by filter.py, handed as ONE file.
#  - Jail: --allowedTools with //absolute/path/** rules — Read limited to the
#    workspace, Write/Edit limited to the brain dir. (Double slash is
#    required for absolute paths; a single slash silently fails.)
#
# Usage: distill.sh <transcript.jsonl> <workspace_root>

TRANSCRIPT_PATH="$1"
WORKSPACE_ROOT="$2"

cd "$WORKSPACE_ROOT" || exit 1
WORKSPACE_ROOT="$PWD"
# Hooks can run with a thin PATH; add the usual CLI homes only if `claude`
# isn't already resolvable (so an explicit PATH always wins).
command -v claude >/dev/null 2>&1 || export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

BRAIN_DIR="${BRAIN_DIR:-$WORKSPACE_ROOT/.coding-brain}"
export BRAIN_DIR
STATE_DIR="$BRAIN_DIR/.state"
LOCK_DIR="$STATE_DIR/harvest.lock"
LOG_FILE="$STATE_DIR/harvest.log"
COST_LOG="$STATE_DIR/cost.jsonl"
CONFIG="$BRAIN_DIR/config.json"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$STATE_DIR" "$BRAIN_DIR/sessions" "$BRAIN_DIR/topics"

# Read a key from config.json (python3 stdlib; missing file/key -> default).
cfg() {  # cfg <key> <default>
  python3 - "$CONFIG" "$1" "$2" <<'PY'
import json, sys
path, key, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    v = json.load(open(path)).get(key)
    print(v if v is not None else default)
except Exception:
    print(default)
PY
}

# Quality-first, no cheap tier. A shallow digest is worse than no digest: it
# writes confident-sounding wrong facts into STATE that every later session
# then trusts. Override with config.json `model` if you want something else.
MODEL=$(cfg model claude-sonnet-5)
STALE_LOCK_MIN=$(cfg staleLockMinutes 30)
ASSISTANT_CAP=$(cfg assistantCapChars 2500)
TOTAL_CAP=$(cfg totalCapChars 400000)

notify() {  # notify <title> <message> — glanceable, never interruptive; macOS only
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
  fi
}

# One harvester at a time. A lock left behind by a crashed harvest (reboot,
# kill -9) would freeze harvesting forever — break it when stale.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +"$STALE_LOCK_MIN" 2>/dev/null)" ]; then
    echo "$(date '+%F %T') breaking stale lock (>${STALE_LOCK_MIN}m old)" >> "$LOG_FILE"
    rm -rf "$LOCK_DIR"
  fi
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    # A skipped run keeps its debounce credit (the offset advances only on
    # success below), so this content is retried on the next stop event.
    echo "$(date '+%F %T') skipped (another harvest in progress) $TRANSCRIPT_PATH" >> "$LOG_FILE"
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

STEM=$(basename "$TRANSCRIPT_PATH" .jsonl)
echo "$(date '+%F %T') harvest start: $TRANSCRIPT_PATH" >> "$LOG_FILE"

# The brain is versioned: one commit per harvest. git log = the compounding
# audit trail ("what did my brain learn"), and any bad harvest is revertable.
# The workspace's own git is never touched.
if [ ! -d "$BRAIN_DIR/.git" ]; then
  git -C "$BRAIN_DIR" init -q &&
    printf '.state/\n' > "$BRAIN_DIR/.gitignore" &&
    git -C "$BRAIN_DIR" add -A &&
    git -C "$BRAIN_DIR" -c user.name="coding-brain" -c user.email="coding-brain@local" \
      commit -qm "baseline: brain before versioned harvests" >> "$LOG_FILE" 2>&1
fi

# Debounce offset candidate: transcript size BEFORE the harvest reads it, so
# content appended while a slow harvest runs still counts toward the next one.
SIZE_AT_START=$(stat -f%z "$TRANSCRIPT_PATH" 2>/dev/null || stat -c%s "$TRANSCRIPT_PATH" 2>/dev/null || echo 0)

# Deterministic workspace snapshot — transcript claims vs reality.
EVIDENCE_FILE="$STATE_DIR/EVIDENCE.md"
if ! "$SCRIPT_DIR/verify.sh" "$WORKSPACE_ROOT" >> "$LOG_FILE" 2>&1; then
  echo "$(date '+%F %T') verify failed (continuing with best-effort harvest)" >> "$LOG_FILE"
fi

# Pre-filter the raw transcript (deterministic, free, strips <private> spans).
FILTERED="$STATE_DIR/filtered-$STEM.txt"
if ! python3 "$SCRIPT_DIR/filter.py" "$TRANSCRIPT_PATH" "$FILTERED" "$ASSISTANT_CAP" "$TOTAL_CAP" >> "$LOG_FILE" 2>&1; then
  echo "$(date '+%F %T') filter failed" >> "$LOG_FILE"
  date +%s > "$STATE_DIR/last_failure"
  notify "coding-brain" "Harvest failed (filter) — see .coding-brain/.state/harvest.log"
  exit 1
fi

PROMPT="You are the coding-brain harvester, a headless background agent. A coding-agent session (Claude Code, Cursor, or Codex) in this workspace produced substantial work. Your job:

1. Read the instructions file $BRAIN_DIR/INSTRUCTIONS.md and follow it exactly.
2. The session transcript has been PRE-CONDENSED to user messages, assistant text, and tool targets. Read it at: $FILTERED
   Read it in as few chunks as possible (it is already filtered; do not re-read).
3. BEFORE rewriting STATE.md, read the evidence snapshot at: $EVIDENCE_FILE
   Treat transcript claims as candidates; reconcile against evidence (git dirty flags, artifact existence). Drop or soften anything evidence contradicts. Prefer uncertain wording over confident falsehoods.
4. Update the brain files as INSTRUCTIONS.md specifies, then stop. Do not touch any files outside $BRAIN_DIR."

# Inherited by the headless agent's own hook processes so the harvest hooks
# never harvest a harvest run.
export CODING_BRAIN_HARVEST=1

# NOTE: `< /dev/null` is mandatory — `claude -p` eats inherited stdin, which
# hangs/steals input when spawned from a hook or a read loop.
FILTERED_BYTES=$(wc -c < "$FILTERED" 2>/dev/null | tr -d ' ')
case "$FILTERED_BYTES" in (*[!0-9]*|"") FILTERED_BYTES=0;; esac
RUN_MODEL="$MODEL"
echo "$(date '+%F %T') model=$RUN_MODEL (filtered ${FILTERED_BYTES}b)" >> "$LOG_FILE"

RAW=$(claude -p "$PROMPT" --model "$RUN_MODEL" \
  --setting-sources "" \
  --allowedTools "Read(/${WORKSPACE_ROOT}/**),Write(/${BRAIN_DIR}/**),Edit(/${BRAIN_DIR}/**),Grep,Glob,Bash(git *),Bash(ls *),Bash(wc *),Bash(mkdir *)" \
  --output-format json < /dev/null 2>>"$LOG_FILE")
rc=$?

# Cost/result receipts (subscription-billed; cost_usd is informational).
echo "$RAW" | python3 -c "
import json, sys
stem = '$STEM'[:12]
try:
    d = json.loads(sys.stdin.read())
    print(json.dumps({'stem': stem, 'cost_usd': d.get('total_cost_usd'), 'turns': d.get('num_turns'), 'duration_ms': d.get('duration_ms'), 'billed': 'subscription'}))
except Exception as e:
    print(json.dumps({'stem': stem, 'parse_error': str(e)}))
" >> "$COST_LOG" 2>/dev/null
echo "$RAW" | python3 -c "import json,sys
try: print('RESULT:', (json.loads(sys.stdin.read()).get('result') or '')[:400])
except Exception as e: print('RESULT parse error:', e)" >> "$LOG_FILE" 2>/dev/null

# Success requires the brain to have SURVIVED, not just the agent exiting 0.
# Documented failure (Aug 10): the brain dir was deleted mid-run by another
# process; every write errored, yet this script printed "Harvest complete."
# and exited 0. Silent data loss reporting as success is the one failure a
# memory tool cannot have.
if [ "$rc" -eq 0 ] && { [ ! -d "$BRAIN_DIR" ] || [ ! -f "$BRAIN_DIR/STATE.md" ]; }; then
  rc=97
  mkdir -p "$STATE_DIR" 2>/dev/null
  echo "$(date '+%F %T') FALSE-SUCCESS GUARD: brain dir or STATE.md missing after run" >> "$LOG_FILE" 2>/dev/null
fi

CHANGED=""
if [ "$rc" -eq 0 ]; then
  date +%s > "$STATE_DIR/last_success"
  rm -f "$STATE_DIR/last_failure"
  git -C "$BRAIN_DIR" add -A >> "$LOG_FILE" 2>&1
  if ! git -C "$BRAIN_DIR" diff --cached --quiet 2>/dev/null; then
    # Commit message = what was learned (newest changed digest's title), so the
    # receipt and `coding-brain log` read like news, not session-ids.
    TITLE=$(git -C "$BRAIN_DIR" diff --cached --name-only | grep '^sessions/' | head -1)
    if [ -n "$TITLE" ] && [ -f "$BRAIN_DIR/$TITLE" ]; then
      TITLE=$(head -1 "$BRAIN_DIR/$TITLE" | sed 's/^# *//' | cut -c1-60)
    else
      TITLE=$(git -C "$BRAIN_DIR" diff --cached --name-only | grep '^topics/' | sed 's|topics/||; s|\.md$||' | head -3 | tr '\n' ',' | sed 's/,$//; s/,/, /g')
    fi
    if [ -z "$TITLE" ]; then
      # No digest/topic changed (STATE-only harvest): borrow the newest
      # digest's title so the receipt still reads like news.
      NEWEST=$(ls -t "$BRAIN_DIR/sessions" 2>/dev/null | head -1)
      [ -n "$NEWEST" ] && TITLE=$(head -1 "$BRAIN_DIR/sessions/$NEWEST" | sed 's/^# *//' | cut -c1-52)
      [ -n "$TITLE" ] && TITLE="$TITLE (update)"
    fi
    [ -z "$TITLE" ] && TITLE="${STEM:0:8}"
    git -C "$BRAIN_DIR" -c user.name="coding-brain" -c user.email="coding-brain@local" \
      commit -qm "harvest: $TITLE" >> "$LOG_FILE" 2>&1
    CHANGED=$(git -C "$BRAIN_DIR" diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null | tr '\n' ' ')
  fi
  short=$(echo "$CHANGED" | tr ' ' '\n' | sed 's|.*/||; s|\.md$||' | grep -v '^$' | head -4 | tr '\n' ',' | sed 's/,$//; s/,/, /g')
  # Routine success is silent by default. A harvest fires after most sessions,
  # so notifying on each one trains you to ignore the notification — and then
  # you miss the failures, which are the only ones you can act on. The receipt
  # line at the start of your next session already reports freshness. Opt back
  # in with "notifyOnSuccess": true in config.json.
  if [ "$(cfg notifyOnSuccess false)" = "true" ]; then
    notify "coding-brain" "Harvested: ${TITLE:-${STEM:0:8}} — updated: ${short:-nothing new}"
  fi
  # Codex reads AGENTS.md natively (no injection hook): refresh the managed
  # receipt block if the user enabled Codex support (markers present). Cheap,
  # deterministic, no model call — and never creates the file uninvited.
  if [ -f "$WORKSPACE_ROOT/AGENTS.md" ] && grep -q 'coding-brain:start' "$WORKSPACE_ROOT/AGENTS.md" 2>/dev/null; then
    "$SCRIPT_DIR/agents-block.sh" "$WORKSPACE_ROOT" "$BRAIN_DIR" >> "$LOG_FILE" 2>&1 \
      || echo "$(date '+%F %T') agents-block refresh failed" >> "$LOG_FILE"
  fi
else
  date +%s > "$STATE_DIR/last_failure"
  notify "coding-brain" "Harvest failed (exit $rc) — see .coding-brain/.state/harvest.log"
fi

# Effectiveness metrics — runs after the digest exists so corrections count.
# CHANGED_DIGESTS scopes digest-signal scanning to files THIS harvest touched,
# so parallel sessions' digests aren't credited to this conversation.
CHANGED_DIGESTS=$(echo "$CHANGED" | tr ' ' '\n' | grep '^sessions/' | sed "s|^|$BRAIN_DIR/|" | tr '\n' ':' | sed 's/:$//') \
  python3 "$SCRIPT_DIR/metrics.py" log "$TRANSCRIPT_PATH" "$WORKSPACE_ROOT" >> "$LOG_FILE" 2>&1 \
  || echo "$(date '+%F %T') metrics log failed" >> "$LOG_FILE"

# Debounce offset advances only on success — and only after metrics has had
# its chance to scan the transcript delta this harvest covered.
if [ "$rc" -eq 0 ]; then
  echo "$SIZE_AT_START" > "$STATE_DIR/$STEM"
fi

echo "$(date '+%F %T') harvest done (exit $rc)" >> "$LOG_FILE"
exit "$rc"
