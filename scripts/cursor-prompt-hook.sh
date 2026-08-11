#!/bin/bash
# Cursor beforeSubmitPrompt hook — per-prompt RETRIEVAL, relevance-gated.
#
# The Cursor sessionStart hook injects the full STATE dump once; this hook is
# the follow-up half (mirror of recall-hook.sh's follow-up branch): score THIS
# prompt against the topic notes and surface only what it is about, with a
# receipt naming what was pulled. No match -> emit {} so the brain is invisible
# when it has nothing to add. A topic body is injected at most once per
# conversation; later mentions just name it.
#
# Contract (same as the legacy brain-scope.py this replaces):
#   stdin:  {"prompt": ..., "conversation_id": ...}   (prompt_text also accepted)
#   stdout: {"additional_context": "..."} or {}

# Recursion guard: a harvester's internal agent call must inject nothing.
if [ -n "$CODING_BRAIN_HARVEST" ]; then
  cat > /dev/null
  echo '{}'
  exit 0
fi

# Slurp the payload BEFORE the python heredoc: `python3 - <<EOF` takes the
# script itself on stdin, so reading the payload from sys.stdin inside would
# get EOF - the exact bug this comment prevents from coming back.
CB_PAYLOAD="$(cat)"
export CB_PAYLOAD

exec python3 - <<'PY'
import json, os, re, sys

def out(obj):
    print(json.dumps(obj)); sys.exit(0)

try:
    payload = json.loads(os.environ.get('CB_PAYLOAD') or '{}')
except Exception:
    out({})
prompt = payload.get('prompt') or payload.get('prompt_text') or ''
conv = str(payload.get('conversation_id') or 'noconv')
if not isinstance(prompt, str) or not prompt.strip():
    out({})

# Find the workspace brain (walk up from cwd, like git discovery).
root = os.environ.get('CODING_BRAIN_DIR')
if root and os.path.isdir(root):
    brain = root
else:
    d = os.getcwd()
    brain = None
    while d != '/':
        cand = os.path.join(d, '.coding-brain')
        if os.path.isdir(cand):
            brain = cand; break
        d = os.path.dirname(d)
if not brain:
    out({})
tdir = os.path.join(brain, 'topics')
if not os.path.isdir(tdir):
    out({})

# Same matcher as recall-hook.sh: lexical, no model call. A hit on the topic's
# own slug outweighs body mentions 5:1; threshold 3; top 2.
STOP = {'the','and','for','this','that','with','from','what','when','where','have',
        'been','were','will','would','should','could','about','into','then','than',
        'they','them','your','yours','ours','just','like','make','made','does','done',
        'want','need','also','some','more','most','only','over','under','after','before',
        'here','there','which','while','because','still','again','file','files','code'}
words = {w for w in re.findall(r'[a-z0-9][a-z0-9._-]{3,}', prompt.lower()) if w not in STOP}
if not words:
    out({})
scored = []
for fn in sorted(os.listdir(tdir)):
    if not fn.endswith('.md'):
        continue
    slug = fn[:-3].lower()
    try:
        body = open(os.path.join(tdir, fn), encoding='utf-8', errors='replace').read()
    except OSError:
        continue
    low = body.lower()
    score = 0
    for w in words:
        if w in slug or slug in w:
            score += 5
        elif w in low:
            score += 1
    if score >= 3:
        scored.append((score, fn, body))
if not scored:
    out({})
scored.sort(key=lambda x: (-x[0], x[1]))
picked = scored[:2]

# Once-per-conversation dedup for topic bodies.
seen_dir = os.path.join(brain, '.state', 'injected', 'cursor-' + re.sub(r'[^A-Za-z0-9_-]', '', conv) + '.topics')
os.makedirs(seen_dir, exist_ok=True)

# Receipt names what was pulled; failure warning is the only telemetry kept.
warn = ''
if os.path.exists(os.path.join(brain, '.state', 'last_failure')):
    warn = ' · WARNING: LAST HARVEST FAILED — brain may be stale (.coding-brain/.state/harvest.log)'
names = ', '.join(fn[:-3] for _, fn, _ in picked)
lines = [
    '[CODING BRAIN] This prompt matches notes from previous sessions — LEADS, not findings. Use them to start the investigation, not to skip it; verify any status claim before repeating it; answer the question as asked, at the size asked.',
    '',
    'Open THIS reply with the line below verbatim, then a blank line, then your answer. Do not print it in replies where it was not provided:',
    f'\U0001F9E0 brain → {names}{warn}',
]
for _, fn, body in picked:
    mark = os.path.join(seen_dir, fn)
    if os.path.exists(mark):
        lines += ['', f'(already in context this conversation: topics/{fn})']
    else:
        open(mark, 'w').close()
        lines += ['', f'=== Relevant topic note: topics/{fn} ===', body.strip()]
out({'additional_context': '\n'.join(lines)})
PY
