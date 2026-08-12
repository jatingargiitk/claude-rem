# How it works

## The loop

```
session ends ──► condense transcript (no LLM, <private> stripped)
             ──► evidence snapshot (git status of your repos)
             ──► ONE model call: returns digest + topic + STATE as text
             ──► claude-rem applies the files itself (atomic, path-jailed)
             ──► git commit
session starts ─► receipt + briefing injected; later prompts get
                  relevance-matched topic notes, or silence
```

The model never touches your disk during a harvest. It returns text; the
orchestrator writes exactly three kinds of file (`sessions/*.md`,
`topics/*.md`, `STATE.md`), atomically, under a lock every writer shares.

Harvests are **debounced**: a session-end only triggers one after roughly
40KB of new transcript has accumulated, so short check-ins don't burn model
calls. Each harvest is a single-turn call, not an agentic loop.

## What the brain holds

```
<workspace>/.claude-rem/
  STATE.md          # the ~100-line briefing, injected at session start
  topics/<slug>.md  # rolling per-project detail, rewritten in place
  sessions/         # immutable session digests (raw history)
  RULES.md          # learned conventions, promoted from your corrections
  evals.json        # your blind-eval question set
  .git/             # one commit per harvest
```

Three layers with different lifetimes:

- **STATE.md** is current truth: rewritten every harvest, newest facts win.
- **topics/** are rolling per-project notes: rewritten in place as a project
  evolves.
- **sessions/** are immutable history: what actually happened, when.
  Digests older than 30 days can be merged into monthly rollups with
  `claude-rem consolidate`.

## Compiled, not appended

Most memory tools are diaries: they append every observation forever and
make you search the pile, and recall gets worse as the pile grows.
claude-rem rewrites its briefing in place instead. A bigger pile is not a
better memory. A cleaner one is.

## Evidence-checking

A transcript is a set of claims, not a record. Before a session becomes
memory, its claims are reconciled against an evidence snapshot of your
repos: git status, whether claimed artifacts exist. If the transcript says
"built the API" and git shows only a README, the brain records "planned,
not yet scaffolded".

## Injection

- **First prompt of a session**: the full STATE briefing, your RULES, the
  topic list, and a receipt line naming what was injected:
  `🧠 brain → STATE.md · 14 topics indexed (harvest 33m ago)`
- **Every later prompt**: scored lexically against topic notes (distinctive
  words weighted, slug matches weighted over body matches, no model call).
  Match: that topic note plus a receipt. No match: nothing at all.
- Weak, ambiguous matches are demoted and labeled as lexical guesses so the
  agent verifies the referent instead of trusting it blindly.

The injected context always carries one standing instruction: memory is
**leads, not findings**. Open threads are starting points to investigate,
not answers to recite.
