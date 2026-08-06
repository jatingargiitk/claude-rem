#!/bin/bash
# search.sh <query words...> — pull-based retrieval over the WHOLE brain
# (STATE, topics, all session digests, notes, learned rules).
#
# Layered like progressive disclosure: cheap ranked hits + matching lines
# first; read the listed file(s) for full detail. Zero deps beyond grep.
#
# Ranking: files matching more distinct query words first, then by total
# match count. Session digests carry their date in the filename — prefer
# newer when scores tie (ls -t ordering below handles this).
#
# Brain discovery: $BRAIN_DIR, else walk up from cwd (like git).

if [ -z "$BRAIN_DIR" ]; then
  root="$PWD"
  while [ "$root" != "/" ] && [ ! -d "$root/.coding-brain" ]; do
    root=$(dirname "$root")
  done
  BRAIN_DIR="$root/.coding-brain"
fi
if [ ! -d "$BRAIN_DIR" ]; then
  echo "search.sh: no .coding-brain found (walked up from $PWD; set \$BRAIN_DIR to override)" >&2
  exit 2
fi

# Rules live inside the brain dir — resolved relative to the brain, never cwd.
RULES_FILE="$BRAIN_DIR/RULES.md"

if [ $# -eq 0 ]; then
  echo "usage: search.sh <query words...>" >&2
  exit 2
fi

# Corpus: newest sessions first so tie-breaks favor recency.
corpus() {
  [ -f "$BRAIN_DIR/STATE.md" ] && echo "$BRAIN_DIR/STATE.md"
  [ -f "$BRAIN_DIR/NOTES.md" ] && echo "$BRAIN_DIR/NOTES.md"
  [ -f "$RULES_FILE" ] && echo "$RULES_FILE"
  ls -t "$BRAIN_DIR/topics/"*.md 2>/dev/null
  ls -t "$BRAIN_DIR/sessions/"*.md 2>/dev/null
}

# Score every file: "<distinct_words_matched> <total_matches> <path>"
scored=$(corpus | while IFS= read -r f; do
  distinct=0 total=0
  for w in "$@"; do
    c=$(grep -ic -- "$w" "$f" 2>/dev/null)  # prints 0 itself on no match
    case "$c" in (*[!0-9]*|"") c=0;; esac
    if [ "$c" -gt 0 ]; then
      distinct=$((distinct + 1))
      total=$((total + c))
    fi
  done
  [ "$distinct" -gt 0 ] && printf '%d %d %s\n' "$distinct" "$total" "$f"
done | sort -k1,1nr -k2,2nr)

if [ -z "$scored" ]; then
  echo "No matches for: $*"
  echo "(Corpus: STATE, $(ls "$BRAIN_DIR/topics" 2>/dev/null | wc -l | tr -d ' ') topics, $(ls "$BRAIN_DIR/sessions" 2>/dev/null | wc -l | tr -d ' ') digests. Try broader/alternate words.)"
  exit 0
fi

nfiles=$(echo "$scored" | wc -l | tr -d ' ')
echo "brain-search: $nfiles file(s) match '$*' — top hits with sample lines."
echo "For full context READ the top file(s); digests = raw history, topics/STATE = current truth."
echo

# grep -e args for sample-line extraction ($# >= 1 guaranteed above, so the
# array is never empty — safe on bash 3.2 even under set -u).
pattern_args=()
for w in "$@"; do pattern_args+=(-e "$w"); done

echo "$scored" | head -6 | while read -r distinct total f; do
  echo "── $f  (words: $distinct/$#, matches: $total)"
  grep -in "${pattern_args[@]}" -- "$f" 2>/dev/null | head -3 | sed 's/^/   /' | cut -c1-160
done

extra=$((nfiles - 6))
[ "$extra" -gt 0 ] && { echo; echo "(+$extra more file(s) — rerun with more specific words to narrow)"; }
exit 0
