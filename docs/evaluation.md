# Evaluation: the blind harness

claude-rem ships its own falsification harness instead of asking you to
trust it.

## One question

```bash
npx claude-rem ab "why is the deploy failing?"
```

Answers the question twice with the same model and tools: once with the
brain injected, once blind, side by side.

## The whole set

```bash
npx claude-rem eval
```

Runs every question in `.claude-rem/evals.json` through both arms, then a
third model grades the pair **without knowing which is which**, presentation
order randomized. Per-question transcripts and verdicts land in
`.claude-rem/.state/evals/`.

Two design details matter for honesty:

- **The blind arm is actually blind.** The brain directory is physically
  moved aside during the blind run, not just excluded by instruction:
  read-tool denials don't stop an agent from `cat`-ing a directory it can
  see.
- **The judge can be wrong.** Verdicts are graded claims, not ground truth;
  keep the per-question transcripts and check surprising losses. Both
  failure modes (judge error, ambiguous question) have shown up in real
  runs and led to fixes.

## What honest results look like

Run on the author's own workspace: the brain wins decisively on
debugging-with-history and architecture questions, and loses some status
questions to an agent that just reads the code. That boundary is real:
"where is feature X" is grep's job, and grep is already excellent at it.
The brain's value is what's *not* in the code: why you chose X, how you
fixed it last time, what's deployed versus local, what you left unfinished.

## Continuous signals

Every harvest also logs to `.state/metrics.jsonl`:

- **hits**: brain context visibly used by the session
- **misses**: things you had to re-explain (also teachable directly:
  `brain miss: ...`)
- **evidence fixes**: transcript claims corrected against git before they
  became memory

Misses that repeat across sessions auto-promote to binding rules.
