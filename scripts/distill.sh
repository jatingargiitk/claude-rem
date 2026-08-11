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

# ---- harvest mode -----------------------------------------------------------
# single-turn (default): everything the harvester needs is assembled into ONE
# prompt; the model replies with FILE: blocks; THIS script writes the files.
# Measured basis for the default: the agentic loop below averages $1.65 over
# 22 turns per harvest (27 receipts); the same work as a single turn costs
# ~$0.20 - and the recurring harvest is the cost users feel daily.
# agentic (config "harvestMode": "agentic"): the original tool-using loop,
# kept as an escape hatch.
HARVEST_MODE=$(cfg harvestMode single-turn)
INLINE_CAP=$(cfg distillInlineCapChars 250000)

# Inherited by the agent's own hook processes so the harvest hooks never
# harvest a harvest run.
export CODING_BRAIN_HARVEST=1

FILTERED_BYTES=$(wc -c < "$FILTERED" 2>/dev/null | tr -d ' ')
case "$FILTERED_BYTES" in (*[!0-9]*|"") FILTERED_BYTES=0;; esac
RUN_MODEL="$MODEL"
echo "$(date '+%F %T') model=$RUN_MODEL mode=$HARVEST_MODE (filtered ${FILTERED_BYTES}b)" >> "$LOG_FILE"

if [ "$HARVEST_MODE" = "agentic" ]; then
  PROMPT="You are the coding-brain harvester, a headless background agent. A coding-agent session (Claude Code, Cursor, or Codex) in this workspace produced substantial work. Your job:

1. Read the instructions file $BRAIN_DIR/INSTRUCTIONS.md and follow it exactly.
2. The session transcript has been PRE-CONDENSED to user messages, assistant text, and tool targets. Read it at: $FILTERED
   Read it in as few chunks as possible (it is already filtered; do not re-read).
3. BEFORE rewriting STATE.md, read the evidence snapshot at: $EVIDENCE_FILE
   Treat transcript claims as candidates; reconcile against evidence (git dirty flags, artifact existence). Drop or soften anything evidence contradicts. Prefer uncertain wording over confident falsehoods.
4. Update the brain files as INSTRUCTIONS.md specifies, then stop. Do not touch any files outside $BRAIN_DIR."

  # NOTE: `< /dev/null` is mandatory — `claude -p` eats inherited stdin.
  RAW=$(claude -p "$PROMPT" --model "$RUN_MODEL" \
    --setting-sources "" \
    --allowedTools "Read(/${WORKSPACE_ROOT}/**),Write(/${BRAIN_DIR}/**),Edit(/${BRAIN_DIR}/**),Grep,Glob,Bash(git *),Bash(ls *),Bash(wc *),Bash(mkdir *)" \
    --output-format json < /dev/null 2>>"$LOG_FILE")
  rc=$?
else
  # Assemble the whole harvest into one prompt file (deterministic, free).
  PROMPT_FILE="$STATE_DIR/prompt-$STEM.txt"
  python3 - "$BRAIN_DIR" "$FILTERED" "$EVIDENCE_FILE" "$PROMPT_FILE" "$INLINE_CAP" <<'ASSEMBLE'
import os, sys
brain, filtered, evidence, out, cap = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])

def read(p, limit=0):
    try:
        t = open(p, encoding='utf-8', errors='replace').read()
    except OSError:
        return ''
    return (t[:limit] + '\n[capped]') if limit and len(t) > limit else t

def section(text, start, end):
    lines = text.split('\n')
    a = next((i for i, l in enumerate(lines) if l.startswith(start)), -1)
    if a < 0: return ''
    b = next((i for i in range(a + 1, len(lines)) if lines[i].startswith(end)), len(lines))
    return '\n'.join(lines[a:b])

instr = read(os.path.join(brain, 'INSTRUCTIONS.md'))
digest_fmt = section(instr, '## Step 1:', '## Step 2')      # digest + topic-note formats
state_fmt  = section(instr, '## Step 3', '## Step 4')       # STATE format
state = read(os.path.join(brain, 'STATE.md'), 20000)
rules = read(os.path.join(brain, 'RULES.md'), 8000)
tdir = os.path.join(brain, 'topics')
topics, used = [], 0
try:
    names = sorted(os.listdir(tdir))
except OSError:
    names = []
for fn in names:
    if not fn.endswith('.md'): continue
    t = read(os.path.join(tdir, fn), 12000)
    if used + len(t) > 90000:
        topics.append(f'----- topics/{fn} ----- [omitted for size]'); continue
    topics.append(f'----- topics/{fn} -----\n{t}'); used += len(t)
transcript = read(filtered, cap)

prompt = f"""You are the coding-brain harvester. ONE coding session just finished; distill it into the brain. Reply ONLY with FILE: blocks — no prose, no tools. This script writes the files; you only return their content.

Emit, in this order:
1. FILE: sessions/YYYY-MM-DD-<2-4-word-slug>.md — one digest for this session (date from the session, not today). Format:
{digest_fmt}
2. FILE: topics/<slug>.md — for EACH topic note this session materially changes, the FULL rewritten note (rewrite in place, newest facts win; cap ~80 lines). Only emit topics that change.
3. FILE: STATE.md — the FULL rewritten workspace state, LAST. Format:
{state_fmt}
Record observations with what produced them and a date, never interpretive conclusions. Reconcile transcript claims against the EVIDENCE section — drop or soften anything it contradicts; prefer uncertain wording over confident falsehoods. Never store secrets/keys/tokens (reference env-var names only).

=== EVIDENCE (deterministic workspace snapshot) ===
{read(evidence, 15000)}

=== CURRENT STATE.md ===
{state}

=== CURRENT LEARNED RULES ===
{rules}

=== CURRENT TOPIC NOTES ===
{chr(10).join(topics)}

=== SESSION TRANSCRIPT (pre-condensed) ===
{transcript}
"""
open(out, 'w').write(prompt)
ASSEMBLE

  # Engine resolution: claude if present, else Cursor's CLI. A Cursor-only
  # user (no Claude Code installed) previously got a brain that could capture
  # transcripts but never distill them - recall of emptiness, forever.
  ENGINE=$(cfg harvestEngine auto)
  CURSOR_BIN=$(command -v cursor-agent || command -v agent || true)
  if [ "$ENGINE" = "auto" ]; then
    if command -v claude >/dev/null 2>&1; then ENGINE=claude
    elif [ -n "$CURSOR_BIN" ]; then ENGINE=cursor-agent
    else
      echo "$(date '+%F %T') no harvest engine (need claude or cursor-agent)" >> "$LOG_FILE"
      mkdir -p "$STATE_DIR" 2>/dev/null; date +%s > "$STATE_DIR/last_failure"
      notify "coding-brain" "No harvest engine found — install the Claude Code CLI (or Cursor's cursor-agent)."
      exit 1
    fi
  fi
  if [ "$ENGINE" = "cursor-agent" ]; then
    # Cursor's model ids differ from Anthropic's (a raw Anthropic id is
    # invalid there - learned the hard way); text output, cost not reported.
    CURSOR_MODEL=$(cfg cursorModel claude-sonnet-5-high)
    echo "$(date '+%F %T') engine=cursor-agent model=$CURSOR_MODEL" >> "$LOG_FILE"
    RAW=$("$CURSOR_BIN" -p "$(cat "$PROMPT_FILE")" --model "$CURSOR_MODEL" \
      --force --output-format text < /dev/null 2>>"$LOG_FILE")
    rc=$?
  else
    RAW=$(claude -p "$(cat "$PROMPT_FILE")" --model "$RUN_MODEL" \
      --setting-sources "" \
      --output-format json < /dev/null 2>>"$LOG_FILE")
    rc=$?
  fi
  rm -f "$PROMPT_FILE"

  # Apply the FILE: blocks ourselves — atomic, path-jailed. A model can only
  # ever name sessions/*.md, topics/*.md, or STATE.md; anything else is dropped.
  if [ "$rc" -eq 0 ]; then
    # RAW goes through a file, NOT a pipe: `python3 - <<heredoc` takes the
    # script itself on stdin, so a piped payload is silently lost (same bug
    # class as cursor-prompt-hook, caught twice in one day).
    RAW_FILE="$STATE_DIR/raw-$STEM.json"
    printf '%s' "$RAW" > "$RAW_FILE"
    APPLIED=$(python3 - "$BRAIN_DIR" "$RAW_FILE" <<'APPLY'
import json, os, re, sys
brain = sys.argv[1]
raw = open(sys.argv[2]).read()
try:
    result = json.loads(raw).get('result') or ''
except Exception:
    result = raw  # cursor-agent emits plain text, not claude's json envelope
n = 0
for part in re.split(r'^FILE:[ \t]*', result, flags=re.M)[1:]:
    nl = part.find('\n')
    if nl < 0: continue
    rel, body = part[:nl].strip(), part[nl + 1:].strip()
    m = re.fullmatch(r'(sessions|topics)/([A-Za-z0-9][A-Za-z0-9._-]*\.md)', rel)
    if m:
        dst = os.path.join(brain, m.group(1), m.group(2))
    elif rel == 'STATE.md':
        dst = os.path.join(brain, 'STATE.md')
    else:
        continue
    if not body: continue
    tmp = dst + '.tmp-' + str(os.getpid())
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(tmp, 'w').write(body + '\n')
    os.replace(tmp, dst)
    n += 1
print(n)
APPLY
)
    rm -f "$RAW_FILE"
    case "$APPLIED" in (*[!0-9]*|"") APPLIED=0;; esac
    echo "$(date '+%F %T') single-turn applied $APPLIED file(s)" >> "$LOG_FILE"
    if [ "$APPLIED" -eq 0 ]; then
      # A harvest that wrote nothing is a failure, not a quiet success.
      rc=96
    fi
  fi
fi

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
  # Record the failure even if the brain dir itself was destroyed mid-run -
  # the recreated marker is what makes the next session's receipt warn.
  mkdir -p "$STATE_DIR" 2>/dev/null
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
