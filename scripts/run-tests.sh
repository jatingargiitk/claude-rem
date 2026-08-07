#!/bin/bash
# coding-brain no-LLM test suite.
#
# Exercises everything that can be tested WITHOUT a real model call: filter,
# search ranking, recall injection, harvest debounce/backoff/guard, the full
# distill pipeline (with `claude` stubbed on PATH), metrics, hook-install
# idempotency (against a throwaway settings.json copy — the real
# ~/.claude/settings.json is never touched), uninstall, the init flow, and
# the Codex integration (rollout filter, inventory, notify hook, config.toml
# notify insertion, AGENTS.md managed block).
#
# Everything runs inside <repo>/.testws/ (recreated on every run, gitignored).
# Prints PASS/FAIL per check; exit 1 if any check fails.

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPTS="$ROOT/scripts"
TESTWS="$ROOT/.testws"
WS="$TESTWS/ws"
WS2="$TESTWS/ws2"
FAKEHOME="$TESTWS/fakehome"
# Keep the stable-runtime copy inside the test workspace, never the real HOME.
export CODING_BRAIN_RUNTIME="$TESTWS/runtime"
STUBBIN="$TESTWS/stubbin"
CLAUDE_STUB_LOG="$TESTWS/claude-calls.log"
export CLAUDE_STUB_LOG

UUID1="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"   # claude-side session
UUID2="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"   # cursor-side session
UUID3="cccccccc-cccc-cccc-cccc-cccccccccccc"   # codex-side session

PASS=0
FAIL=0
check() {  # check <name> <0|1 result (0=ok)>
  if [ "$2" -eq 0 ]; then
    echo "PASS  $1"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $1"
    FAIL=$((FAIL + 1))
  fi
}

claude_calls() { grep -c '^CALL' "$CLAUDE_STUB_LOG" 2>/dev/null || echo 0; }

wait_for() {  # wait_for <seconds> <shell-test...>
  local secs="$1"; shift
  local i=0
  while [ "$i" -lt $((secs * 10)) ]; do
    if eval "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
    i=$((i + 1))
  done
  eval "$@" >/dev/null 2>&1
}

# ------------------------------------------------------------------- setup

rm -rf "$TESTWS"
mkdir -p "$WS" "$WS2" "$STUBBIN" \
  "$FAKEHOME/.claude/projects/testproj" \
  "$FAKEHOME/.cursor/projects" \
  "$FAKEHOME/.codex/sessions/2026/08/07"

# Tiny fake git repo (the "workspace").
git -C "$WS" init -q
echo "hello world project" > "$WS/README.md"
git -C "$WS" -c user.name=t -c user.email=t@t add -A
git -C "$WS" -c user.name=t -c user.email=t@t commit -qm "init"

# Stub claude binary: logs the call, plays the harvester (writes brain files
# when BRAIN_DIR is set), emits a claude--p-shaped JSON result. NO model call.
cat > "$STUBBIN/claude" <<'STUB'
#!/bin/bash
echo "CALL $*" >> "$CLAUDE_STUB_LOG"
if [ -n "${BRAIN_DIR:-}" ]; then
  mkdir -p "$BRAIN_DIR/sessions" "$BRAIN_DIR/topics"
  cat > "$BRAIN_DIR/sessions/2026-01-01-stub-harvest.md" <<'EOF'
# Stub harvest digest
Date: 2026-01-01

## Gotchas / learnings
- brain hit: reused the deploy path convention from STATE
- STATE corrected via evidence: repo claimed dirty but git shows clean
EOF
  cat > "$BRAIN_DIR/STATE.md" <<'EOF'
# Coding Brain — Workspace State
Last updated: 2026-01-01

## Active projects
- **ws**: helloworldfact — hello-world script lives in hello.py

## Open threads
- none
EOF
  # Unique content per call so every stubbed run produces a committable diff.
  echo "- stub-run: $$-$RANDOM" >> "$BRAIN_DIR/STATE.md"
fi
echo '{"result":"stub ok","total_cost_usd":0,"num_turns":1,"duration_ms":10}'
exit 0
STUB
chmod +x "$STUBBIN/claude"
export PATH="$STUBBIN:$PATH"

# Fake transcripts (claude-code-shaped and cursor-shaped JSONL).
python3 - "$WS" "$FAKEHOME/.claude/projects/testproj/$UUID1.jsonl" \
  "$FAKEHOME/.cursor/projects" "$UUID2" <<'PY'
import json, os, sys
ws, claude_path, cursor_projects, uuid2 = sys.argv[1:5]

def cc(role, content, cwd):
    return {"type": role, "cwd": cwd, "sessionId": "s", "timestamp": "2026-08-01T10:00:00Z",
            "message": {"role": role, "content": content}}

big_blob = "{" + json.dumps({"tool_result": "BIGBLOBMARKER " + "x" * 3500})
records = [
    cc("user", [{"type": "text", "text": "Let's build a hello world script in python please"}], ws),
    cc("assistant", [{"type": "text", "text": "I'll create hello.py with a main guard."},
                     {"type": "tool_use", "name": "Write", "input": {"file_path": "hello.py"}}], ws),
    cc("user", [{"type": "text", "text":
        "my key is <private>SECRET_TOKEN_XYZ</private> and also <private>\nline2 SECRET2\n</private> ok?"}], ws),
    cc("user", [{"type": "text", "text": big_blob}], ws),
    cc("user", [{"type": "text", "text": "brain miss: I had to re-explain the deploy path"}], ws),
    cc("assistant", [{"type": "text", "text": "Done, hello.py created and tested."}], ws),
]
with open(claude_path, "w") as fh:
    for r in records:
        fh.write(json.dumps(r) + "\n")

# Cursor: project dir name encodes the workspace path (slashes -> dashes).
munged = ws.lstrip("/").replace("/", "-")
tdir = os.path.join(cursor_projects, munged, "agent-transcripts", uuid2)
os.makedirs(tdir, exist_ok=True)
cur = [
    {"role": "user", "message": {"role": "user", "content": [{"type": "text", "text": "add a --name flag to the hello script"}]}},
    {"role": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Added argparse with --name."}]}},
]
with open(os.path.join(tdir, uuid2 + ".jsonl"), "w") as fh:
    for r in cur:
        fh.write(json.dumps(r) + "\n")
PY

# Codex rollout fixture (session_meta cwd = the workspace; developer/env
# boilerplate that must be dropped; user/assistant text; a function_call).
CODEX_T="$FAKEHOME/.codex/sessions/2026/08/07/rollout-2026-08-07T10-00-00-$UUID3.jsonl"
python3 - "$WS" "$CODEX_T" "$UUID3" <<'PY'
import json, sys
ws, out, uuid3 = sys.argv[1:4]

def line(t, payload):
    return {"timestamp": "2026-08-07T10:00:00.000Z", "type": t, "payload": payload}

def msg(role, ctype, text):
    return line("response_item", {"type": "message", "role": role,
                                  "content": [{"type": ctype, "text": text}]})

records = [
    line("session_meta", {"id": uuid3, "cwd": ws, "originator": "codex_cli_rs",
                          "cli_version": "0.104.0", "source": "cli"}),
    msg("developer", "input_text", "DEVBOILERPLATE permissions and sandboxing rules"),
    msg("user", "input_text", "# AGENTS.md instructions for " + ws + "\nAGENTSDUMP skip me"),
    msg("user", "input_text", "<environment_context>\n  <cwd>" + ws + "</cwd>\n</environment_context>"),
    msg("user", "input_text", "codexuserword please add a farewell message to hello.py"),
    msg("user", "input_text", "token is <private>CODEXSECRET</private> ok"),
    line("event_msg", {"type": "task_started"}),
    line("response_item", {"type": "function_call", "name": "exec_command",
                           "arguments": "{\"cmd\":\"cat hello.py\"}", "call_id": "c1"}),
    line("turn_context", {"model": "gpt-5"}),
    msg("assistant", "output_text", "codexassistantword added a farewell print."),
]
with open(out, "w") as fh:
    for r in records:
        fh.write(json.dumps(r) + "\n")
PY

CLAUDE_T="$FAKEHOME/.claude/projects/testproj/$UUID1.jsonl"
MUNGED=$(echo "$WS" | sed 's|^/||; s|/|-|g')
CURSOR_T="$FAKEHOME/.cursor/projects/$MUNGED/agent-transcripts/$UUID2/$UUID2.jsonl"

# Brain fixture in WS (scaffold what init would create, plus test content).
BRAIN="$WS/.coding-brain"
mkdir -p "$BRAIN/sessions" "$BRAIN/topics" "$BRAIN/.state"
cp "$ROOT/templates/config.json" "$BRAIN/config.json"
cp "$ROOT/templates/INSTRUCTIONS.md" "$BRAIN/INSTRUCTIONS.md"
printf '.state/\n' > "$BRAIN/.gitignore"
cat > "$BRAIN/STATE.md" <<'EOF'
# Coding Brain — Workspace State
Last updated: 2026-01-01

## Active projects
- **ws**: STATEMARKER alphaword bravoword hello-world project.

## Open threads
- finish the greeting flag
EOF
printf '# Quick notes (pending harvest)\n\n- PENDINGNOTE remember the flag rename\n' > "$BRAIN/NOTES.md"
printf '# Learned rules\n\n- RULEMARKER always run tests before commit\n' > "$BRAIN/RULES.md"
printf '# topic\nalphaword only here\n' > "$BRAIN/topics/proj.md"
printf '# old digest\nbravoword only here\n' > "$BRAIN/sessions/2026-01-01-old.md"
git -C "$BRAIN" init -q
git -C "$BRAIN" -c user.name=t -c user.email=t@t add -A
git -C "$BRAIN" -c user.name=t -c user.email=t@t commit -qm "baseline: test fixture"

echo "== setup done =="

# ----------------------------------------------------------- filter.py

OUT="$TESTWS/filtered.txt"
python3 "$SCRIPTS/filter.py" "$CLAUDE_T" "$OUT" >/dev/null 2>&1
r=1
grep -q "\[USER\] Let's build" "$OUT" && grep -q "\[TOOL\] Write: hello.py" "$OUT" && r=0
check "filter: keeps user text + tool targets" $r

r=1
if ! grep -q "SECRET_TOKEN_XYZ" "$OUT" && ! grep -q "SECRET2" "$OUT" && grep -q "private content removed" "$OUT"; then r=0; fi
check "filter: strips <private> spans (incl. multiline)" $r

r=1
grep -q "BIGBLOBMARKER" "$OUT" || r=0
check "filter: drops big tool_result masquerade" $r

# Codex rollout format (auto-detected per line).
OUTX="$TESTWS/filtered-codex.txt"
python3 "$SCRIPTS/filter.py" "$CODEX_T" "$OUTX" >/dev/null 2>&1
r=1
grep -q "\[USER\] codexuserword" "$OUTX" \
  && grep -q "\[ASSISTANT\] codexassistantword" "$OUTX" \
  && grep -q "\[TOOL\] exec_command:" "$OUTX" && r=0
check "filter(codex): keeps user/assistant text + tool targets" $r

r=1
if ! grep -q "DEVBOILERPLATE" "$OUTX" && ! grep -q "AGENTSDUMP" "$OUTX" \
  && ! grep -q "environment_context" "$OUTX"; then r=0; fi
check "filter(codex): drops developer role + injected boilerplate" $r

r=1
if ! grep -q "CODEXSECRET" "$OUTX" && grep -q "private content removed" "$OUTX"; then r=0; fi
check "filter(codex): <private> stripping applies" $r

# ----------------------------------------------------------- search.sh

SR=$(BRAIN_DIR="$BRAIN" bash "$SCRIPTS/search.sh" alphaword bravoword 2>&1)
top=$(echo "$SR" | grep '^── ' | head -1)
r=1
echo "$top" | grep -q "STATE.md" && echo "$top" | grep -q "words: 2/2" && r=0
check "search: ranks file matching both words first" $r

r=1
echo "$SR" | grep -q "topics/proj.md\|sessions/2026-01-01-old.md" && r=0
check "search: single-word files still listed" $r

SR2=$(BRAIN_DIR="$BRAIN" bash "$SCRIPTS/search.sh" zzzznomatchzzz 2>&1)
r=1
echo "$SR2" | grep -q "No matches" && r=0
check "search: no-match message" $r

SR3=$(cd "$WS" && bash "$SCRIPTS/search.sh" alphaword 2>&1)
r=1
echo "$SR3" | grep -q "STATE.md" && r=0
check "search: brain discovery by walking up from cwd" $r

# ----------------------------------------------------------- recall-hook.sh

RC=$(printf '{"session_id":"sess-recall-1","cwd":"%s"}' "$WS" | bash "$SCRIPTS/recall-hook.sh")
r=1
echo "$RC" | grep -q "brain: last harvest" \
  && echo "$RC" | grep -q "STATEMARKER" \
  && echo "$RC" | grep -q "PENDINGNOTE" \
  && echo "$RC" | grep -q "RULEMARKER" \
  && echo "$RC" | grep -q "PULL RETRIEVAL" && r=0
check "recall: injects receipt + STATE + rules + notes + search instruction" $r

RC2=$(printf '{"session_id":"sess-recall-1","cwd":"%s"}' "$WS" | bash "$SCRIPTS/recall-hook.sh")
r=1
[ -z "$RC2" ] && r=0
check "recall: injects only once per session" $r

touch "$BRAIN/.state/last_failure"
RC3=$(printf '{"session_id":"sess-recall-2","cwd":"%s"}' "$WS" | bash "$SCRIPTS/recall-hook.sh")
r=1
echo "$RC3" | grep -q "LAST HARVEST FAILED" && r=0
check "recall: staleness warning after failed harvest" $r
rm -f "$BRAIN/.state/last_failure"

RC4=$(printf '{"session_id":"sess-recall-3","cwd":"%s"}' "$WS" | CODING_BRAIN_HARVEST=1 bash "$SCRIPTS/recall-hook.sh")
r=1
[ -z "$RC4" ] && r=0
check "recall: recursion guard (CODING_BRAIN_HARVEST)" $r

# ---------------------------------------------------- cursor-recall-hook.sh

CRC=$(cd "$WS" && echo '{}' | bash "$SCRIPTS/cursor-recall-hook.sh")
r=1
echo "$CRC" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ctx = d.get('additional_context', '')
assert 'STATEMARKER' in ctx and 'brain: last harvest' in ctx
" >/dev/null 2>&1 && r=0
check "cursor-recall: valid JSON with additional_context" $r

# ---------------------------------------------------- harvest-hook.sh

hook_json() { printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s"}' "$1" "$2" "$3"; }

# Guard: harvester's own session must never harvest.
hook_json "$UUID1" "$CLAUDE_T" "$WS" | CODING_BRAIN_HARVEST=1 bash "$SCRIPTS/harvest-hook.sh"
sleep 0.5
r=1
[ "$(claude_calls)" -eq 0 ] && r=0
check "harvest: recursion guard (CODING_BRAIN_HARVEST)" $r

# Debounce: small transcript (< threshold) must not spawn.
hook_json "$UUID1" "$CLAUDE_T" "$WS" | bash "$SCRIPTS/harvest-hook.sh"
sleep 1
r=1
[ "$(claude_calls)" -eq 0 ] && [ ! -f "$BRAIN/.state/$UUID1" ] && r=0
check "harvest: debounce below threshold (no spawn)" $r

# Pad the transcript past the 25KB threshold.
python3 - "$CLAUDE_T" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as fh:
    first = json.loads(fh.readline())
cwd = first["cwd"]
with open(path, "a") as fh:
    for i in range(40):
        rec = {"type": "assistant", "cwd": cwd, "sessionId": "s",
               "message": {"role": "assistant",
                           "content": [{"type": "text", "text": "filler analysis step %d " % i + "y" * 700}]}}
        fh.write(json.dumps(rec) + "\n")
PY

# Backoff: a fresh failure marker must suppress the spawn.
touch "$BRAIN/.state/last_failure"
hook_json "$UUID1" "$CLAUDE_T" "$WS" | bash "$SCRIPTS/harvest-hook.sh"
sleep 1
r=1
[ "$(claude_calls)" -eq 0 ] && r=0
check "harvest: backoff after recent failure (no spawn)" $r
rm -f "$BRAIN/.state/last_failure"

# Real spawn: debounced threshold crossed -> detached distill with stub claude.
SIZE_NOW=$(stat -f%z "$CLAUDE_T" 2>/dev/null || stat -c%s "$CLAUDE_T")
hook_json "$UUID1" "$CLAUDE_T" "$WS" | bash "$SCRIPTS/harvest-hook.sh"
wait_for 30 "[ -f '$BRAIN/.state/$UUID1' ]"
wait_for 10 "grep -q 'harvest done' '$BRAIN/.state/harvest.log'"
r=1
[ -f "$BRAIN/.state/$UUID1" ] && [ "$(cat "$BRAIN/.state/$UUID1")" = "$SIZE_NOW" ] && r=0
check "harvest: spawn + offset advances to size-at-start on success" $r

r=1
[ "$(claude_calls)" -eq 1 ] && r=0
check "harvest: exactly one claude call (stubbed, jailed args)" $r

r=1
grep -q -- '--setting-sources' "$CLAUDE_STUB_LOG" \
  && grep -q "Read(/$WS/\*\*)" "$CLAUDE_STUB_LOG" \
  && grep -q "Write(/$BRAIN/\*\*)" "$CLAUDE_STUB_LOG" && r=0
check "harvest: claude invoked with --setting-sources + //path/** jail" $r

r=1
git -C "$BRAIN" log --oneline | grep -q "harvest: Stub harvest digest" && [ -f "$BRAIN/sessions/2026-01-01-stub-harvest.md" ] && r=0
check "harvest: brain git commit per harvest + digest exists" $r

r=1
[ -f "$BRAIN/.state/last_success" ] && [ ! -f "$BRAIN/.state/last_failure" ] && r=0
check "harvest: last_success written, no failure marker" $r

# Metrics record from that harvest: transcript miss + digest hit + digest fix.
r=1
python3 - "$BRAIN/.state/metrics.jsonl" <<'PY' && r=0
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert rows, "no metrics records"
rec = rows[-1]
assert rec["misses"] >= 1, rec
assert rec["hits"] >= 1, rec
assert rec["evidence_fixes"] >= 1, rec
assert any("deploy path" in n for n in rec["miss_notes"]), rec
PY
check "metrics: harvest logged miss (transcript) + hit/fix (digest, CHANGED_DIGESTS-scoped)" $r

# Evidence snapshot was generated for the harvester.
r=1
grep -q "Evidence Snapshot" "$BRAIN/.state/EVIDENCE.md" 2>/dev/null \
  && grep -q "workspace root" "$BRAIN/.state/EVIDENCE.md" && r=0
check "verify: evidence snapshot written with git summary" $r

# ---------------------------------------------------- cursor-harvest-hook.sh

# Pad the cursor transcript past the threshold too.
python3 - "$CURSOR_T" <<'PY'
import json, sys
with open(sys.argv[1], "a") as fh:
    for i in range(40):
        rec = {"role": "assistant", "message": {"role": "assistant",
               "content": [{"type": "text", "text": "cursor filler %d " % i + "z" * 700}]}}
        fh.write(json.dumps(rec) + "\n")
PY
(cd "$WS" && printf '{"status":"completed","conversation_id":"%s","transcript_path":"%s"}' "$UUID2" "$CURSOR_T" \
  | bash "$SCRIPTS/cursor-harvest-hook.sh" >/dev/null)
wait_for 30 "[ -f '$BRAIN/.state/$UUID2' ]"
r=1
[ -f "$BRAIN/.state/$UUID2" ] && [ "$(claude_calls)" -eq 2 ] && r=0
check "cursor-harvest: debounced spawn feeds the same brain" $r

# ---------------------------------------------------- metrics.py direct

mkdir -p "$WS2/.coding-brain/.state"
T2="$TESTWS/t2.jsonl"
python3 - "$T2" "$WS2" <<'PY'
import json, sys
rec = {"type": "user", "cwd": sys.argv[2],
       "message": {"role": "user", "content": [{"type": "text", "text": "brain miss: metrics test alphaunique convention"}]}}
open(sys.argv[1], "w").write(json.dumps(rec) + "\n")
PY
python3 "$SCRIPTS/metrics.py" log "$T2" "$WS2" >/dev/null 2>&1
python3 "$SCRIPTS/metrics.py" log "$T2" "$WS2" >/dev/null 2>&1
r=1
python3 - "$WS2/.coding-brain/.state/metrics.jsonl" <<'PY' && r=0
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
assert len(rows) == 2, rows
assert rows[0]["misses"] == 1, rows[0]
assert rows[1]["misses"] == 0, rows[1]   # delta offset + dedupe: no recount
PY
check "metrics: offset delta-scan + dedupe (no double count)" $r

REP=$(python3 "$SCRIPTS/metrics.py" report "$WS2" 2>&1)
r=1
echo "$REP" | grep -q "Coding brain — last 7 days" && echo "$REP" | grep -q "alphaunique" && r=0
check "metrics: report renders totals + recent misses" $r

# ------------------------------------------- hook install / uninstall (CLI)

FAKE_SETTINGS="$TESTWS/settings-idem.json"
cat > "$FAKE_SETTINGS" <<'EOF'
{
  "model": "test-model",
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "echo existing-stop-hook" } ] } ]
  }
}
EOF

run_cli() {  # run_cli <settings-file> <args...>
  local settings="$1"; shift
  (cd "$WS" && CODING_BRAIN_SETTINGS="$settings" \
    CODING_BRAIN_CLAUDE_DIR="$FAKEHOME/.claude" \
    CODING_BRAIN_CURSOR_DIR="$FAKEHOME/.cursor" \
    CODING_BRAIN_CODEX_DIR="$FAKEHOME/.codex" \
    node "$ROOT/bin/coding-brain.js" "$@" 2>&1)
}

run_cli "$FAKE_SETTINGS" init --yes --hooks-only >/dev/null
run_cli "$FAKE_SETTINGS" init --yes --hooks-only >/dev/null
r=1
[ "$(grep -c 'scripts/harvest-hook.sh' "$FAKE_SETTINGS")" -eq 1 ] \
  && [ "$(grep -c 'scripts/recall-hook.sh' "$FAKE_SETTINGS")" -eq 1 ] \
  && grep -q "existing-stop-hook" "$FAKE_SETTINGS" \
  && grep -q '"model": "test-model"' "$FAKE_SETTINGS" && r=0
check "install: idempotent merge, existing entries + settings preserved" $r

FAKE_SETTINGS2="$TESTWS/settings-dry.json"
cat > "$FAKE_SETTINGS2" <<'EOF'
{ "model": "test-model", "hooks": {} }
EOF
cp "$FAKE_SETTINGS2" "$FAKE_SETTINGS2.orig"
run_cli "$FAKE_SETTINGS2" init --yes --hooks-only --dry-run >/dev/null
r=1
cmp -s "$FAKE_SETTINGS2" "$FAKE_SETTINGS2.orig" && r=0
check "install: --dry-run leaves settings untouched" $r

run_cli "$FAKE_SETTINGS" uninstall >/dev/null
r=1
! grep -q 'scripts/harvest-hook.sh' "$FAKE_SETTINGS" \
  && ! grep -q 'scripts/recall-hook.sh' "$FAKE_SETTINGS" \
  && grep -q "existing-stop-hook" "$FAKE_SETTINGS" \
  && [ -d "$BRAIN" ] && r=0
check "uninstall: removes only its own entries; brain left untouched" $r

# ------------------------------------------------------------ init (full)

FAKE_SETTINGS3="$TESTWS/settings-init.json"
echo '{}' > "$FAKE_SETTINGS3"
INIT_OUT=$(run_cli "$FAKE_SETTINGS3" init --yes)
r=1
echo "$INIT_OUT" | grep -q "Found 3 past session(s) across 1 project(s)" && r=0
check "init: inventory finds claude + cursor + codex sessions for this workspace" $r

r=1
grep -q "helloworldfact" "$BRAIN/STATE.md" \
  && git -C "$BRAIN" log --oneline | grep -q "init: lite STATE" \
  && echo "$INIT_OUT" | grep -q "===== STATE.md =====" && r=0
check "init: lite STATE compiled (one stubbed model call) + committed + printed" $r

r=1
grep -q 'scripts/harvest-hook.sh' "$FAKE_SETTINGS3" && grep -q 'scripts/recall-hook.sh' "$FAKE_SETTINGS3" && r=0
check "init: hooks installed into (fake) settings.json" $r

r=1
[ ! -f "$WS/.cursor/hooks.json" ] && r=0
check "init: cursor hooks NOT auto-installed without --cursor" $r

INIT_CURSOR_OUT=$(run_cli "$FAKE_SETTINGS3" init --yes --hooks-only --cursor)
r=1
[ -f "$WS/.cursor/hooks.json" ] \
  && grep -q 'cursor-harvest-hook.sh' "$WS/.cursor/hooks.json" \
  && grep -q 'cursor-recall-hook.sh' "$WS/.cursor/hooks.json" && r=0
check "init --cursor: workspace .cursor/hooks.json written" $r

run_cli "$FAKE_SETTINGS3" uninstall >/dev/null
r=1
! grep -q 'cursor-harvest-hook.sh' "$WS/.cursor/hooks.json" 2>/dev/null && r=0
check "uninstall: cursor hook entries removed too" $r

# ------------------------------------------------------------- CLI misc

ST=$(run_cli "$FAKE_SETTINGS3" status)
r=1
echo "$ST" | grep -q "Brain: $BRAIN" && echo "$ST" | grep -q "Digests:" && echo "$ST" | grep -q "Last 5 brain commits" && r=0
check "cli status: location + counts + commits" $r

LG=$(run_cli "$FAKE_SETTINGS3" log)
r=1
echo "$LG" | grep -q "harvest: Stub harvest digest" && r=0
check "cli log: shows harvest commits" $r

SC=$(run_cli "$FAKE_SETTINGS3" search helloworldfact)
r=1
echo "$SC" | grep -q "STATE.md" && r=0
check "cli search: delegates to search.sh with discovered brain" $r

# ---------------------------------------------------- codex-notify-hook.sh

CODEX_STEM=$(basename "$CODEX_T" .jsonl)
CALLS_BEFORE=$(claude_calls)

# Guard: harvester's own session must never spawn.
CODING_BRAIN_HARVEST=1 CODING_BRAIN_CODEX_DIR="$FAKEHOME/.codex" \
  bash "$SCRIPTS/codex-notify-hook.sh" '{}'
sleep 0.5
r=1
[ "$(claude_calls)" -eq "$CALLS_BEFORE" ] && r=0
check "codex-notify: recursion guard (CODING_BRAIN_HARVEST)" $r

# Debounce: rollout below threshold must not spawn.
CODING_BRAIN_CODEX_DIR="$FAKEHOME/.codex" \
  bash "$SCRIPTS/codex-notify-hook.sh" '{"type":"agent-turn-complete"}'
sleep 1
r=1
[ "$(claude_calls)" -eq "$CALLS_BEFORE" ] && [ ! -f "$BRAIN/.state/$CODEX_STEM" ] && r=0
check "codex-notify: debounce below threshold (no spawn)" $r

# Pad the rollout past the threshold and notify again (arg schema is opaque
# to the hook — it relies on the recency scan, not the JSON payload).
python3 - "$CODEX_T" <<'PY'
import json, sys
with open(sys.argv[1], "a") as fh:
    for i in range(40):
        rec = {"timestamp": "t", "type": "response_item",
               "payload": {"type": "message", "role": "assistant",
                           "content": [{"type": "output_text", "text": "codex filler %d " % i + "w" * 700}]}}
        fh.write(json.dumps(rec) + "\n")
PY
CODING_BRAIN_CODEX_DIR="$FAKEHOME/.codex" \
  bash "$SCRIPTS/codex-notify-hook.sh" '{"type":"agent-turn-complete"}'
wait_for 30 "[ -f '$BRAIN/.state/$CODEX_STEM' ]"
r=1
[ -f "$BRAIN/.state/$CODEX_STEM" ] && [ "$(claude_calls)" -eq $((CALLS_BEFORE + 1)) ] && r=0
check "codex-notify: recency scan + debounced spawn feeds the same brain" $r

# ---------------------------------------- codex config.toml + AGENTS.md

CODEX_CONFIG="$FAKEHOME/.codex/config.toml"
cat > "$CODEX_CONFIG" <<'EOF'
[projects."/some/path"]
trust_level = "trusted"
EOF
printf 'USERCONTENT keep me\n' > "$WS/AGENTS.md"

run_cli "$FAKE_SETTINGS3" init --yes --hooks-only --codex >/dev/null
run_cli "$FAKE_SETTINGS3" init --yes --hooks-only --codex >/dev/null

r=1
[ "$(grep -c '^notify' "$CODEX_CONFIG")" -eq 1 ] \
  && grep -q 'codex-notify-hook.sh' "$CODEX_CONFIG" \
  && grep -q 'trust_level' "$CODEX_CONFIG" && r=0
check "codex install: notify added once (idempotent), existing config preserved" $r

# TOML top-level keys must precede any [table] section.
r=1
nline=$(grep -n '^notify' "$CODEX_CONFIG" | head -1 | cut -d: -f1)
tline=$(grep -n '^\[projects' "$CODEX_CONFIG" | head -1 | cut -d: -f1)
[ -n "$nline" ] && [ -n "$tline" ] && [ "$nline" -lt "$tline" ] && r=0
check "codex install: notify inserted at top of config.toml (before tables)" $r

r=1
[ "$(grep -c 'coding-brain:start' "$WS/AGENTS.md")" -eq 1 ] \
  && grep -q 'USERCONTENT keep me' "$WS/AGENTS.md" \
  && grep -q 'STATE.md' "$WS/AGENTS.md" \
  && grep -q 'brain: last harvest' "$WS/AGENTS.md" && r=0
check "codex install: AGENTS.md managed block created once, user content kept" $r

# A foreign notify entry must never be overwritten (TOML allows only one).
CODEX2="$TESTWS/codex2"
mkdir -p "$CODEX2/sessions"
printf 'notify = ["/usr/bin/true"]\n' > "$CODEX2/config.toml"
cp "$CODEX2/config.toml" "$CODEX2/config.toml.orig"
OUT_FOREIGN=$( (cd "$WS" && CODING_BRAIN_SETTINGS="$FAKE_SETTINGS3" \
  CODING_BRAIN_CLAUDE_DIR="$FAKEHOME/.claude" \
  CODING_BRAIN_CURSOR_DIR="$FAKEHOME/.cursor" \
  CODING_BRAIN_CODEX_DIR="$CODEX2" \
  node "$ROOT/bin/coding-brain.js" init --yes --hooks-only --codex 2>&1) )
r=1
cmp -s "$CODEX2/config.toml" "$CODEX2/config.toml.orig" \
  && echo "$OUT_FOREIGN" | grep -q "Not overwriting" && r=0
check "codex install: foreign notify entry respected (manual instruction printed)" $r

# ---------------------------------------------------- distill AGENTS refresh

# Tamper inside the managed block; the next successful harvest must repair it.
python3 - "$WS/AGENTS.md" <<'PY'
import sys
p = sys.argv[1]
t = open(p).read().replace("compiled current-truth briefing", "TAMPERED")
open(p, "w").write(t)
PY
python3 - "$CLAUDE_T" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as fh:
    first = json.loads(fh.readline())
cwd = first["cwd"]
with open(path, "a") as fh:
    for i in range(40):
        rec = {"type": "assistant", "cwd": cwd, "sessionId": "s",
               "message": {"role": "assistant",
                           "content": [{"type": "text", "text": "refresh filler %d " % i + "q" * 700}]}}
        fh.write(json.dumps(rec) + "\n")
PY
run_cli "$FAKE_SETTINGS3" harvest >/dev/null
r=1
! grep -q "TAMPERED" "$WS/AGENTS.md" \
  && grep -q 'coding-brain:start' "$WS/AGENTS.md" \
  && grep -q 'compiled current-truth briefing' "$WS/AGENTS.md" \
  && grep -q 'USERCONTENT keep me' "$WS/AGENTS.md" && r=0
check "distill: refreshes AGENTS.md managed block after harvest" $r

# ---------------------------------------------------- codex uninstall

run_cli "$FAKE_SETTINGS3" uninstall >/dev/null
r=1
! grep -q 'coding-brain:start' "$WS/AGENTS.md" \
  && grep -q 'USERCONTENT keep me' "$WS/AGENTS.md" \
  && ! grep -q '^notify' "$CODEX_CONFIG" \
  && grep -q 'trust_level' "$CODEX_CONFIG" && r=0
check "codex uninstall: notify + managed block removed, foreign content kept" $r

# ------------------------------------------------------------------- ui.py

UI_LOG="$TESTWS/ui.log"
python3 "$SCRIPTS/ui.py" "$BRAIN" --port 0 > "$UI_LOG" 2>&1 &
UI_PID=$!
wait_for 10 "grep -q 'http://127.0.0.1:' '$UI_LOG'"
UI_PORT=$(sed -n 's|.*http://127.0.0.1:\([0-9]*\).*|\1|p' "$UI_LOG" | head -1)
UI="http://127.0.0.1:$UI_PORT"
fetch() { curl -s -m 5 "$1"; }

r=1
[ -n "$UI_PORT" ] && fetch "$UI/" | grep -q "coding-brain" && r=0
check "ui: binds 127.0.0.1 free port + serves the page" $r

r=1
fetch "$UI/api/overview" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'brain: last harvest' in d['receipt'], d['receipt']
assert d['counts']['digests'] >= 1, d['counts']
assert d['metrics']['totals']['harvests'] >= 1, d['metrics']
assert d['state_age'] != 'missing', d['state_age']
" >/dev/null 2>&1 && r=0
check "ui: /api/overview has receipt + counts + metrics + STATE age" $r

r=1
fetch "$UI/api/state" | grep -q "helloworldfact" && r=0
check "ui: /api/state serves the live STATE.md" $r

r=1
fetch "$UI/api/feed" | grep -q "harvest:" && r=0
check "ui: /api/feed streams harvest commits with titles" $r

r=1
fetch "$UI/api/search?q=helloworldfact" | grep -q "STATE.md" && r=0
check "ui: /api/search proxies search.sh against this brain" $r

r=1
fetch "$UI/api/digests" | grep -q "2026-01-01-stub-harvest.md" \
  && fetch "$UI/api/digest/2026-01-01-stub-harvest.md" | grep -q "Stub harvest" && r=0
check "ui: digest list + single-digest fetch" $r

r=1
T1=$(curl -s -m 5 --path-as-is "$UI/api/digest/../config.json")
T2=$(fetch "$UI/api/digest/..%2F..%2Fconfig.json")
echo "$T1$T2" | grep -q '"error"' && ! echo "$T1$T2" | grep -q "uiPort" && r=0
check "ui: digest path traversal rejected" $r

kill "$UI_PID" 2>/dev/null
wait "$UI_PID" 2>/dev/null

# `coding-brain ui` with no brain anywhere above cwd: polite error, exit 1.
NOBRAIN=$(mktemp -d)
UIERR=$( (cd "$NOBRAIN" && node "$ROOT/bin/coding-brain.js" ui --no-open 2>&1) )
uirc=$?
r=1
[ "$uirc" -ne 0 ] && echo "$UIERR" | grep -q "no .coding-brain found" \
  && echo "$UIERR" | grep -q "coding-brain init" && r=0
check "cli ui: polite error when no brain exists" $r
rm -rf "$NOBRAIN"

# init with CODING_BRAIN_NO_UI=1 must not spawn the post-install viewer.
rm -f "$BRAIN/.state/ui.pid"
CODING_BRAIN_NO_UI=1 run_cli "$FAKE_SETTINGS3" init --yes --hooks-only >/dev/null
sleep 0.5
r=1
[ ! -f "$BRAIN/.state/ui.pid" ] && ! pgrep -f "ui.py $BRAIN" >/dev/null 2>&1 && r=0
check "init: CODING_BRAIN_NO_UI=1 suppresses the post-install viewer" $r

# ------------------------------------------------------------------ result

echo
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
