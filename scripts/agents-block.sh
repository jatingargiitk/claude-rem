#!/bin/bash
# Create/refresh/remove the coding-brain managed block in <workspace>/AGENTS.md.
#
# Codex has no injection hook; it natively reads AGENTS.md at session start.
# So the brain's receipt + retrieval instructions live in a managed block
# between markers, refreshed after every harvest (cheap, no model call).
# Content outside the markers is NEVER touched.
#
# Usage: agents-block.sh <workspace_root> [brain_dir]     # create/refresh
#        agents-block.sh --remove <workspace_root>        # drop the block

START_MARK="<!-- coding-brain:start -->"
END_MARK="<!-- coding-brain:end -->"

if [ "$1" = "--remove" ]; then
  WORKSPACE_ROOT="$2"
  AGENTS="$WORKSPACE_ROOT/AGENTS.md"
  [ -f "$AGENTS" ] || exit 0
  python3 - "$AGENTS" "$START_MARK" "$END_MARK" <<'PY'
import os, re, sys
path, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
if start not in text:
    sys.exit(0)
pattern = re.compile(re.escape(start) + r".*?" + re.escape(end) + r"\n?", re.DOTALL)
out = pattern.sub("", text)
if out.strip():
    open(path, "w", encoding="utf-8").write(out)
else:
    os.remove(path)  # nothing but our block: the file was ours
PY
  exit 0
fi

WORKSPACE_ROOT="$1"
BRAIN_DIR="${2:-$WORKSPACE_ROOT/.coding-brain}"
AGENTS="$WORKSPACE_ROOT/AGENTS.md"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
[ -d "$BRAIN_DIR" ] || exit 0

# Freshness receipt (same math as the recall hooks).
last_ts=$(cat "$BRAIN_DIR/.state/last_success" 2>/dev/null)
case "$last_ts" in (*[!0-9]*|"") last_ts="";; esac
freshness="not yet (brain grows from your next sessions)"
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
ntopics=$(ls "$BRAIN_DIR/topics" 2>/dev/null | grep -c '\.md$')
GLOBAL_RULES="${CODING_BRAIN_GLOBAL_DIR:-$HOME/.coding-brain}/RULES.md"
GLOBAL_SECTION=""
if [ -f "$GLOBAL_RULES" ] && grep -v '^[[:space:]]*#' "$GLOBAL_RULES" 2>/dev/null | grep -q '[^[:space:]]'; then
  GLOBAL_SECTION="

=== Global rules (all workspaces — ~/.coding-brain/RULES.md) ===
$(grep -v '^[[:space:]]*#' "$GLOBAL_RULES")"
fi
receipt="🧠 brain → STATE.md · ${ntopics} topics indexed (harvest ${freshness})${warn}"

BLOCK="$START_MARK
## Coding brain (managed block — refreshed automatically, do not edit)
$receipt

Read \`.coding-brain/STATE.md\` FIRST — as LEADS, not findings: open threads are starting points to investigate, status claims need re-verification before repeating, and it is the compiled briefing
for this workspace, distilled and evidence-checked from previous sessions.
Anything not in it (past sessions, fixes, how-we-did-X) is searchable:
  bash $SCRIPT_DIR/search.sh <query words>
then READ the top file(s). Use it BEFORE re-deriving or asking the user about
anything that may have happened in a past session. Open your first reply with
the receipt line above so the user can see the brain is alive.$GLOBAL_SECTION
$END_MARK"

# Block content is passed via the environment so titles containing quotes,
# backslashes, or backticks can never break out of the string.
CODING_BRAIN_BLOCK="$BLOCK" python3 - "$AGENTS" "$START_MARK" "$END_MARK" <<'PY'
import os, re, sys
path, start, end = sys.argv[1], sys.argv[2], sys.argv[3]
block = os.environ["CODING_BRAIN_BLOCK"]
try:
    text = open(path, encoding="utf-8").read()
except FileNotFoundError:
    text = ""
pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
if start in text:
    out = pattern.sub(lambda m: block, text, count=1)
else:
    out = (text.rstrip() + "\n\n" if text.strip() else "") + block + "\n"
open(path, "w", encoding="utf-8").write(out)
PY
exit 0
