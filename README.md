# 🧠 coding-brain

[![npm](https://img.shields.io/npm/v/coding-brain)](https://www.npmjs.com/package/coding-brain)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![no api key](https://img.shields.io/badge/API%20key-not%20required-brightgreen)](#faq)

**Your coding agent forgets everything between sessions. This fixes that — permanently.**

coding-brain gives Claude Code and Cursor a *compiled* memory: after every
session it distills what happened into a small, human-readable briefing of
your workspace — verified against your actual repos — and injects it back
when the next session starts. You never explain your codebase twice.

```
cd ~/your-workspace        # the directory you open Claude Code / Cursor in
npx coding-brain init
```

Three minutes later your agent has read your history and written its first
briefing. Every session after that makes it smarter.

---

## What it looks like

Every session opens with a receipt — your brain, announcing itself:

```
🧠 brain: last harvest 33m ago · harvest: fixed slack polling + revisit-due bug
```

And behind it, a ~100-line `STATE.md` your agent reads before you type —
real output from a fresh install:

```markdown
## Active projects
- **tiny-api** (workspace root): toy Flask API (/health, /items CRUD via
  sqlite3) — planned in detail but not yet scaffolded; only README.md
  exists on disk/in git. See topics/tiny-api.md.

## Conventions
- tiny-api dev server: port 5057, not 5000 (5000 conflicts with macOS AirPlay).
- tiny-api: stdlib sqlite3 only, no SQLAlchemy/ORM.
```

Notice two things no other memory tool does:

- *"planned in detail but not yet scaffolded"* — the session transcript
  **claimed** the app was built; the brain checked the actual repo, found
  only a README, and refused to believe the story. **Claims are verified
  against git before they become memory.**
- The port-5057 convention came from the user typing one line —
  `brain miss: I had to re-explain we use port 5057` — and it became a
  permanent rule. **Corrections compound.**

## Why "compiled" matters

Most memory tools are **diaries**: they append every observation forever and
make you search the pile. The pile grows, duplicates accumulate, last month's
decision contradicts this month's, and recall degrades — the opposite of
what a memory is for.

coding-brain is a **compiler**. Each harvest *rewrites* the briefing in
place: new facts supersede old ones, resolved threads close, repeated
mistakes get promoted to rules. The store gets **cleaner** as it grows, not
bigger. (The industry is converging on the same conclusion — OpenAI,
Anthropic, and Google now all ship background memory-consolidation passes;
OpenAI reports factual recall nearly doubling after switching ChatGPT from
accumulate-and-search to a maintained, self-correcting summary.)

|  | Diary-style memory | coding-brain |
|---|---|---|
| Same fact learned twice | Two entries, forever | Deduped into one line |
| Fact changes | Old + new coexist; search returns both | Rewritten; old version stays in git history |
| Transcript is wrong | Stored as truth | Checked against git/files first |
| "What do you know?" | A search box over thousands of rows | One readable STATE.md |
| Is it working? | Vibes | Measured hit/miss rate per harvest |
| Storage | Database + vector index + daemon | Plain markdown + git. No daemon. |

## How it works

```
session ends ──► condense transcript (no LLM, <private> stripped)
             ──► evidence snapshot (git status of your repos)
             ──► ONE claude -p call: digest + topics + STATE rewrite
             ──► git commit  ("coding-brain log" = what it learned, when)

session starts ─► receipt + STATE injected + search available
```

The brain lives at `<workspace>/.coding-brain/` — plain files:

```
STATE.md          # ~100-line current-truth dashboard (injected every session)
topics/<slug>.md  # rolling per-project detail, rewritten in place
sessions/         # immutable session digests (raw history)
RULES.md          # learned conventions, promoted from repeated misses
.git/             # one commit per harvest — every change is a readable diff
```

Harvests are debounced (~25KB of new transcript), run in the background,
never block your session, and are jailed: reads limited to your workspace,
writes limited to the brain directory.

**It measures itself.** Type `brain miss: <what you re-explained>` or
`brain hit: <what it knew>` in any session; the harvester also tags what it
detects. `coding-brain` is, to our knowledge, the only memory system that
reports its own hit rate instead of asking you to trust it.

## Commands

```
coding-brain init        # inventory → consent → starter STATE → hooks
coding-brain status      # last harvest age, counts, recent commits
coding-brain search <w>  # ranked search over STATE + topics + digests
coding-brain log         # git log of the brain
coding-brain harvest     # force-harvest the newest transcript now
coding-brain uninstall   # remove hooks; the brain (your files) stays
```

## FAQ

**What does it cost?**
Nothing beyond the Claude subscription you already have. Harvesting runs one
`claude -p` call per debounced session-end on your logged-in `claude` CLI —
no API key, no separate billing, no per-event LLM stream running in the
background. Transcript condensing is deterministic (free).

**Does my code leave my machine?**
Only to the same place it already goes: your own Claude subscription, for
the one distill call. No server of ours, no telemetry, no uploads. The brain
is plain markdown in your workspace.

**What about secrets and private content?**
Wrap anything in `<private>...</private>` in a session and a deterministic
filter strips it *before any transcript content reaches a model*. The
harvester's instructions require referencing credentials by env-var name
only, and its writes are jailed to `.coding-brain/`.

**Do I have to backfill my history?**
No. `init` offers to compile a starter STATE from your recent sessions (one
model call, ~3 minutes, with a consent gate and per-project exclusions) —
or skip it and the brain simply grows from your next session.

**Claude Code or Cursor?**
Both, one brain: install hooks for either or both; sessions from each tool
feed the same store. (Codex support is next — see Roadmap.)

**What if a harvest writes something wrong?**
Every harvest is one git commit. `git -C .coding-brain revert` — done. A
background process that rewrites your data without an audit trail is how you
lose data quietly; that's why the brain is born as a git repo.

## Requirements

macOS or Linux · Node ≥ 18 · python3 · git · the
[Claude Code](https://claude.com/claude-code) CLI logged in to your
subscription.

## Roadmap

Codex CLI support (transcript reader + AGENTS.md injection) · weekly
consolidation pass over old digests · miss-escalation (repeated corrections
auto-promote to rules) · live activity ticker · Windows.

## Status

v0.1 — young, moving fast, used daily by its author across a ~15-project
workspace for the past month. Issues and war stories welcome.

## License

Apache-2.0
