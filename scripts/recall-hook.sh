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
print('\t'.join(str(d.get(k) or '').replace('\t', ' ').replace('\n', ' ') for k in ('session_id', 'cwd', 'prompt')))
")
IFS=$'\t' read -r session_id cwd prompt <<EOF
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
FIRST=1
if [ -n "$session_id" ]; then
  MARKER="$MARKER_DIR/$session_id"
  [ -f "$MARKER" ] && FIRST=0
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

# --- Follow-up prompts: relevance-gated, or silent. ------------------------
# After the first prompt the full STATE dump is already in context, so re-sending
# it every turn is pure bloat. Instead, match THIS prompt against the topic notes
# and surface only what it's actually about. No match -> print nothing at all,
# so the brain is invisible when it has nothing to add.
#
# The receipt instruction below deliberately says "this reply" rather than "the
# first reply of the session": the earlier wording was injected on every prompt
# while telling the model it was the first, so the model kept re-printing it.
# Emitting the line only when we actually inject keeps instruction and reality
# in sync.
if [ "$FIRST" -eq 0 ]; then
  [ -d "$BRAIN_DIR/topics" ] || exit 0
  [ -n "$prompt" ] || exit 0

  matched=$(SEEN_DIR="$MARKER_DIR/$session_id.topics" BRAIN_DIR="$BRAIN_DIR" \
    PROMPT="$prompt" python3 - <<'PY'
import os, re, sys

brain, prompt = os.environ['BRAIN_DIR'], os.environ['PROMPT'].lower()
tdir = os.path.join(brain, 'topics')
STOP = {'the','and','for','this','that','with','from','what','when','where','have',
        'been','were','will','would','should','could','about','into','then','than',
        'they','them','your','yours','ours','just','like','make','made','does','done',
        'want','need','also','some','more','most','only','over','under','after','before',
        'here','there','which','while','because','still','again','file','files','code'}
# 4+ chars keeps 'api'/'ui' out, but those are noisy anyway; stopwords cut the rest.
words = {w for w in re.findall(r'[a-z0-9][a-z0-9._-]{3,}', prompt) if w not in STOP}
if not words:
    sys.exit(0)

scored = []
for fn in sorted(os.listdir(tdir)):
    if not fn.endswith('.md'):
        continue
    slug = fn[:-3].lower()
    try:
        body = open(os.path.join(tdir, fn), encoding='utf-8', errors='replace').read().lower()
    except OSError:
        continue
    # A hit on the topic's own name is worth far more than a passing mention in
    # its body — "herdr-memory" in the prompt should pick herdr-memory.md even if
    # another note happens to say the word a few times.
    score = 0
    for w in words:
        if w in slug or slug in w:
            score += 5
        elif w in body:
            score += 1
    if score >= 3:
        scored.append((score, fn))

scored.sort(reverse=True)
for score, fn in scored[:2]:
    print(fn)
PY
  )

  [ -n "$matched" ] || exit 0

  echo "[CODING BRAIN] This prompt matches what the brain already knows. Compiled from previous sessions — treat as a starting point and re-check when it matters."
  echo
  echo "Open THIS reply with the line below verbatim, then a blank line, then your answer. Do not print it in replies where it was not provided:"
  echo "$receipt"

  SEEN_DIR="$MARKER_DIR/$session_id.topics"
  mkdir -p "$SEEN_DIR"
  for fn in $matched; do
    # Inject a topic body at most once per session; after that just name it, so a
    # long conversation about one project doesn't re-send the same note each turn.
    if [ -f "$SEEN_DIR/$fn" ]; then
      echo
      echo "(already in context this session: topics/$fn)"
    else
      touch "$SEEN_DIR/$fn"
      echo
      echo "=== Relevant topic note: topics/$fn ==="
      cat "$BRAIN_DIR/topics/$fn"
    fi
  done
  echo
  echo "More: $SCRIPT_DIR/search.sh <query words>"
  exit 0
fi

echo "[CODING BRAIN] Persistent context for this workspace, distilled from previous sessions. Harvest reconciles claims against git/file evidence before promoting to STATE — still treat this as a starting point and re-check when it matters."
echo
echo "Open THIS reply with the line below verbatim, then a blank line, then your answer. Do not print it in replies where it was not provided:"
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
