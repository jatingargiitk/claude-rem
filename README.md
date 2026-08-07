<div align="center">

# 🧠 coding-brain

**A compiled brain for Claude Code, Cursor & Codex. Your agent never starts from zero again.**

[![npm](https://img.shields.io/npm/v/coding-brain)](https://www.npmjs.com/package/coding-brain)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](#requirements)
[![api key](https://img.shields.io/badge/API%20key-not%20needed-brightgreen)](#faq)

</div>

I got tired of re-explaining my repos, my decisions, and my gotchas to every
new session. So I built a brain that remembers. It reads each session after
it ends, distills what mattered into a small briefing of your workspace, and
hands that briefing to your agent the moment the next session starts.

It compounds. Every session it works with you, it gets better at your
codebase, your conventions, your way of working.

## Quick Start

```bash
cd ~/your-workspace        # the directory you open Claude Code / Cursor / Codex in
npx coding-brain init
```

That's it. Init scans your past sessions (with your consent), compiles a
starter briefing in about 3 minutes, and wires up the hooks. From then on
everything is automatic. One command to install, zero commands to use.

## Features

- 🧠 **Compiled memory, not a log.** Every session gets distilled into a
  ~100-line STATE of what's true right now. New facts replace old ones.
  The store gets cleaner as it grows, not bigger.
- ✅ **Evidence-checked.** Before anything becomes memory, it's verified
  against your actual repos. If the transcript says "built the API" and git
  says otherwise, the brain believes git.
- 📊 **It measures itself.** Hits, misses, and corrections are logged per
  harvest. This is the only memory system I know of that reports its own
  hit rate instead of asking you to trust it.
- 🔁 **One brain, all three tools.** Claude Code, Cursor, and Codex sessions
  feed the same store. Explain something once in any of them and the other
  two know it.
- 📁 **Plain files + git.** Markdown you can read, grep, and diff. One git
  commit per harvest, so `coding-brain log` shows exactly what it learned
  and when. Anything wrong is one revert away.
- 🔒 **Local and private.** No server, no telemetry, no API key. Wrap
  anything in `<private>...</private>` and it never reaches a model.
- 🪶 **No daemon, no vector DB, no heavy deps.** Hooks fire, do their job,
  and exit. The only long-lived thing is the optional viewer, and only while
  you're looking at it.
- 👀 **A viewer you'll actually open.** `npx coding-brain ui` shows what it
  knows and what it's learned on one calm local page.

## What it looks like

Every session opens with a receipt from your brain:

```
🧠 brain: last harvest 33m ago · harvest: fixed slack polling + revisit-due bug
```

Behind it sits STATE.md, the briefing your agent reads before you type.
This is real output from a fresh install:

```markdown
## Active projects
- **tiny-api** (workspace root): toy Flask API (/health, /items CRUD via
  sqlite3). Planned in detail but not yet scaffolded; only README.md
  exists on disk/in git. See topics/tiny-api.md.

## Conventions
- tiny-api dev server: port 5057, not 5000 (5000 conflicts with macOS AirPlay).
- tiny-api: stdlib sqlite3 only, no SQLAlchemy/ORM.
```

Two things worth noticing. The transcript claimed the app was built. The
brain checked the repo, found only a README, and wrote "not yet scaffolded"
instead of believing the story. And that port-5057 rule exists because the
user typed one line, `brain miss: I had to re-explain we use port 5057`,
and it became permanent.

## See it

```bash
npx coding-brain ui
```

Opens one calm local page (127.0.0.1 only): a freshness line, a search box,
a collapsed "what it knows right now" card, and the feed of what it's
learned — click any row to read the full note inline. `init` opens it once
at the end so your install lands on a visual, not terminal text. It runs in
the foreground; Ctrl-C closes it.

## How it works

```
session ends ──► condense transcript (no LLM, <private> stripped)
             ──► evidence snapshot (git status of your repos)
             ──► one claude -p call: digest + topics + STATE rewrite
             ──► git commit

session starts ─► receipt + STATE injected, search available
```

The brain lives at `<workspace>/.coding-brain/`:

```
STATE.md          # the ~100-line briefing, injected every session
topics/<slug>.md  # rolling per-project detail, rewritten in place
sessions/         # immutable session digests (raw history)
RULES.md          # learned conventions, promoted from your corrections
.git/             # one commit per harvest
```

Harvests are debounced (about 25KB of new transcript before one fires), run
in the background, and never block your session. The harvester is jailed:
it can read your workspace and write only to the brain directory.

Most memory tools are diaries. They append every observation forever and
make you search the pile, and recall gets worse as the pile grows.
coding-brain rewrites its briefing in place instead, which is the same
conclusion OpenAI, Anthropic, and Google all landed on this year with their
background memory-consolidation passes. A bigger pile is not a better
memory. A cleaner one is.

## Commands

You only ever need the first one.

```
npx coding-brain init        # scan history, compile starter briefing, install hooks
npx coding-brain ui          # open the local viewer
npx coding-brain status      # is it alive, what does it hold, last commits
npx coding-brain search <w>  # ranked search over everything it knows
npx coding-brain log         # what it learned, when
npx coding-brain harvest     # force a harvest right now
npx coding-brain uninstall   # removes hooks; your brain files stay put
```

The rest exist so you can watch it work and leave whenever you want.

## FAQ

**What does it cost?**
Nothing beyond the Claude subscription you already pay for. One `claude -p`
call per debounced session-end, on your own logged-in CLI. No API key, no
separate billing, no background LLM stream burning tokens while you work.
And it's quota-friendly by default: routine sessions harvest on Haiku (the
cheapest model), and only big decision-heavy sessions escalate to Sonnet.
Both are configurable in `.coding-brain/config.json`.

**Does my code leave my machine?**
Only to your own Claude subscription for the distill call, which is where
your sessions already go. No server of mine, no telemetry, no uploads.

**Do I have to backfill my history?**
No. Init offers a starter briefing from your recent sessions, one model
call with a consent gate and per-project exclusions. Skip it and the brain
simply grows from your next session.

**What if a harvest writes something wrong?**
Every harvest is a git commit. Revert it. A background process that
rewrites your data without an audit trail is how you lose data quietly,
which is why the brain is born as a git repo.

**"No daemon" — so what is the viewer?**
A plain python3 http.server on 127.0.0.1 that runs while you're looking at
it: `npx coding-brain ui` holds your terminal until Ctrl-C, and the copy init
starts lives only until you stop it (`npx coding-brain uninstall`) or reboot.
Nothing else is ever resident — harvests are hook-triggered processes that
exit when done.

**Claude Code, Cursor, or Codex?**
All three, one brain. Claude Code and Cursor harvest through session hooks;
Codex harvests through its `notify` hook and reads the briefing through a
managed block in `AGENTS.md` (markers only — the rest of your AGENTS.md is
never touched). Enable it with `npx coding-brain init --codex`.

## Requirements

macOS or Linux · Node ≥ 18 · python3 · git · the
[Claude Code](https://claude.com/claude-code) CLI logged in to your
subscription.

## Roadmap

Weekly consolidation pass over old digests · miss-escalation (repeated
corrections auto-promote to rules) · live activity ticker · Windows.
(Codex CLI support: shipped.)

## Status

v0.1. Young and moving fast. I've been running it daily across a
15-project workspace for the past month; it's how this README knows what
it's talking about. Issues and war stories welcome.

## License

Apache-2.0
