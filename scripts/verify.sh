#!/bin/bash
# Gather workspace evidence for the coding-brain harvester.
# Transcript claims are candidates; this file is what the world currently shows.
# Called by distill.sh before the headless agent runs. Local-only, no network.
#
# Usage: verify.sh [WORKSPACE_ROOT]
# Writes: <brain>/.state/EVIDENCE.md  (brain = $BRAIN_DIR or <root>/.coding-brain)

set -u

WORKSPACE_ROOT="${1:-$PWD}"
cd "$WORKSPACE_ROOT" || exit 1
WORKSPACE_ROOT="$PWD"

BRAIN_DIR="${BRAIN_DIR:-$WORKSPACE_ROOT/.coding-brain}"
STATE_DIR="$BRAIN_DIR/.state"
OUT="$STATE_DIR/EVIDENCE.md"
mkdir -p "$STATE_DIR"

git_summary() {  # git_summary <dir> <label>
  local dir="$1" label="$2"
  local branch dirty untracked
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  dirty=$(git -C "$dir" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  untracked=$(git -C "$dir" status --porcelain 2>/dev/null | grep -c '^??' 2>/dev/null || true)
  case "$untracked" in (*[!0-9]*|"") untracked=0;; esac
  echo "- \`$label\`: branch=\`$branch\` dirty_paths=$dirty untracked_paths=$untracked"
  git -C "$dir" status -sb 2>/dev/null | head -3 | sed 's/^/    /'
  git -C "$dir" log --oneline -3 2>/dev/null | sed 's/^/    /'
}

{
  echo "# Coding Brain — Evidence Snapshot"
  echo "Generated: $(date '+%F %T %Z')"
  echo "Workspace: $WORKSPACE_ROOT"
  echo
  echo "Harvester: treat transcript claims as *candidates*. Prefer this file"
  echo "over chat narrative when they conflict. If evidence is missing or"
  echo "ambiguous, mark the STATE claim as uncertain — do not invent certainty."
  echo

  echo "## Git repos in this workspace"
  if [ -d "$WORKSPACE_ROOT/.git" ]; then
    git_summary "$WORKSPACE_ROOT" "workspace root"
  else
    echo "- workspace root: not a git repo"
  fi
  # First-level subproject repos (capped so huge workspaces don't stall).
  found=0
  for d in "$WORKSPACE_ROOT"/*/; do
    [ -d "$d/.git" ] || continue
    found=$((found + 1))
    [ "$found" -gt 40 ] && { echo "- (more repos omitted — cap 40)"; break; }
    git_summary "$d" "$(basename "$d")/"
  done
  [ "$found" -eq 0 ] && echo "- no first-level subproject git repos"
  echo

  echo "## Prior STATE open threads (for supersession check)"
  if [ -f "$BRAIN_DIR/STATE.md" ]; then
    # Extract open-threads bullets so the harvester can drop resolved ones.
    awk '
      /^## Open threads/ {p=1; next}
      /^## / {p=0}
      p && /^-/ {print}
    ' "$BRAIN_DIR/STATE.md" | head -40
  else
    echo "(no STATE.md yet)"
  fi
  echo

  echo "## Recent session digests (newest first)"
  ls -t "$BRAIN_DIR/sessions" 2>/dev/null | head -12 | sed 's/^/- /'
  echo

  echo "## How to use this file"
  echo "1. Before rewriting STATE.md, reconcile each candidate claim with evidence above."
  echo "2. If git shows dirty_paths=0 for a repo, do NOT say \"uncommitted\" for it."
  echo "3. If an open-thread bullet is contradicted by evidence, remove it from Open threads."
  echo "4. If you cannot verify (remote/deploy/third-party claims this file does not"
  echo "   cover), keep the claim only if a recent digest still asserts it, and prefix"
  echo "   with \"unverified:\" or keep soft wording (\"last known\", \"as of <date>\")."
  echo "5. Never invent deploy/remote status this file does not cover."
} > "$OUT"

echo "$OUT"
