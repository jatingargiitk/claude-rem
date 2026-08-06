# 🧠 coding-brain

**A compiled brain for Claude Code & Cursor.**

Most memory tools for coding agents are diaries — they append everything that
happened and make you search the pile. coding-brain is a **compiler**: it
distills every session into a small, human-readable current-truth briefing
(plain markdown, versioned in git), verifies claims against your actual repos
before storing them, and **measures its own hit rate** so you know it's
working.

- One brain, both tools — Cursor and Claude Code feed the same store
- ~100-line STATE + rolling per-project topic notes, rewritten in place
- Evidence-checked: transcript claims are reconciled against git/files/deploys
- Self-measuring: hits, misses, and corrections logged per harvest
- Plain files + git — greppable, diffable, portable, yours
- No daemon, no vector DB, no heavy deps

## Install

Requirements: macOS or Linux, Node >= 18, python3, git, and the
[Claude Code](https://claude.com/claude-code) CLI (`claude`) logged in to your
existing Claude subscription. **No API key** — harvesting bills against the
subscription you already pay for.

```bash
cd ~/your-workspace        # the directory you open Claude Code / Cursor in
npx coding-brain init
```

`init` does four things, with your consent at each step:

1. **Inventory** (free, no model call): scans your local Claude Code and
   Cursor transcript stores for past sessions in this workspace and prints
   what it found.
2. **Consent gate**: asks before compiling anything; you can list and exclude
   project subdirectories, or skip entirely (hooks-only install — the brain
   starts empty).
3. **Lite STATE** (~1-3 min, one model call): deterministically condenses
   your ~15 most recent sessions and compiles the first `STATE.md` — your
   workspace's current-truth dashboard.
4. **Hook install**: wires the harvest + recall hooks into Claude Code
   (`~/.claude/settings.json`), and offers Cursor project hooks if Cursor is
   installed. Idempotent — existing hook entries are never duplicated or
   removed.

From then on it's automatic: every session end triggers a debounced
background harvest (digest → topic notes → STATE rewrite → one git commit →
a macOS notification); every session start injects a freshness receipt, the
STATE, and a search instruction.

## How it works

The brain lives at `<workspace>/.coding-brain/`:

```
.coding-brain/
  STATE.md          # ~100-line current-truth dashboard (injected every session)
  topics/<slug>.md  # rolling per-project detail, rewritten in place
  sessions/         # immutable session digests (raw history)
  RULES.md          # learned conventions, promoted from repeated misses
  NOTES.md          # quick notes pending harvest
  INSTRUCTIONS.md   # the harvester's spec (edit to tune what gets kept)
  config.json       # model, thresholds
  .state/           # machine state: offsets, logs, metrics (gitignored)
  .git/             # one commit per harvest — `coding-brain log` = what it learned
```

A harvest is: deterministic transcript condensing (no LLM) → a local
**evidence snapshot** (git status of your repos) → one headless `claude -p`
call that follows `INSTRUCTIONS.md`, reconciles transcript claims against
evidence, rewrites the brain files, and commits. The harvester runs isolated
(`--setting-sources ""`, tool access jailed to the workspace for reads and to
the brain dir for writes) and is debounced (~25KB of new transcript before it
fires), so trivial turns don't burn model calls.

**It measures itself.** Type `brain miss: <what you had to re-explain>` or
`brain hit: <what it knew>` in any session, and the harvester also tags
hits/misses/corrections it detects. `python3 scripts/metrics.py report`
answers the only question that matters: is the brain saving work, or just
writing notes?

## Commands

```
coding-brain init        # inventory -> consent -> lite STATE -> hooks
coding-brain status      # brain location, last harvest age, counts, last commits
coding-brain search <w>  # ranked lexical search over STATE + topics + digests
coding-brain log         # git log of the brain — what it learned, when
coding-brain harvest     # force-harvest the newest unharvested transcript now
coding-brain uninstall   # remove hooks; the brain dir is left untouched
```

## Privacy

- **Everything is local.** Plain markdown in your workspace, versioned in a
  local git repo. No server, no telemetry, no uploads.
- **`<private>` tags are honored**: wrap anything in
  `<private>...</private>` in a session and it is stripped by a
  deterministic filter *before* any transcript content reaches a model, and
  never stored in the brain.
- **Secrets never land in the brain**: the harvester's instructions require
  referencing credentials by env-var name only, and its writes are jailed to
  `.coding-brain/`.
- **Your subscription, your data**: harvesting uses your own logged-in
  `claude` CLI. No API key is collected or required.
- **Uninstall is clean**: `coding-brain uninstall` removes only its own hook
  entries; delete `.coding-brain/` whenever you like — it's just files.

## Status

v0.1 — in active development. Single-machine, macOS-first (Linux works minus
notifications). Windows, the viewer UI, and deep per-session backfill are not
in v0.1.

## License

Apache-2.0
