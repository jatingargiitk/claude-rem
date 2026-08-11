<div align="center">

# 🧠 coding-brain

**One brain for Claude Code, Cursor & Codex. Your agent never starts from zero again.**

[![npm](https://img.shields.io/npm/v/coding-brain)](https://www.npmjs.com/package/coding-brain)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](#requirements)
[![api key](https://img.shields.io/badge/API%20key-not%20needed-brightgreen)](#faq)

</div>

I got tired of re-explaining my repos, my decisions, and my gotchas to every
new session. So I built a brain that remembers. It reads each session after
it ends, distills what mattered into a small briefing of your workspace, and
hands that briefing to your agent the moment the next session starts.

Two things make it different from every memory tool I tried first:

**It's one brain across tools.** Claude Code, Cursor, and Codex sessions all
feed the same store, and all three read from it. Explain something once,
anywhere, and everywhere knows it. No vendor will ever build this for you —
none of them will compile a competitor's transcripts.

**It doesn't believe transcripts.** A transcript is a set of claims, not a
record. Agents confidently report things that didn't happen, so before
anything becomes memory it's checked against your actual repos — git status,
whether the artifact exists. If the session says "built the API" and git says
otherwise, the brain believes git.

## Quick Start

```bash
cd ~/your-workspace        # the directory you open Claude Code / Cursor / Codex in
npx coding-brain init
```

Init scans your past sessions (with your consent) and compiles a real
starting brain — not just a summary. Session digests, a rolling note per
project, and the briefing, built by parallel single-shot model calls with a
cost receipt at the end:

```
Brain compiled: 43 session digest(s), 14 topic note(s) in 434s · ~$5.35 of model time.
```

Typical workspaces land around $2–4 and a few minutes; it's once per
workspace, ever. From then on everything is automatic.

## What it looks like

The first prompt of a session gets the full briefing, with a receipt naming
exactly what was injected:

```
🧠 brain → STATE.md · 14 topics indexed (harvest 33m ago)
```

After that, the brain only speaks when your prompt matches something it
knows — it pulls the relevant project note and names it:

```
🧠 brain → tiny-api
```

No match, no injection, no receipt. The brain is invisible when it has
nothing to add.

Behind the receipt sits STATE.md, the briefing your agent reads before you
type. Real output from a fresh install:

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

One more thing the injected context always carries: an instruction that
memory is **leads, not findings**. Open threads are starting points to
investigate, not answers to recite; status claims get re-verified before
they're repeated. That instruction exists because blind testing (below)
showed a brain without it makes agents *passive* — knowing a problem is open
became a reason to stop working on it.

## It measures itself — and you can too

```bash
npx coding-brain ab "why is the deploy failing?"   # one question, blind vs brain
npx coding-brain eval                              # your whole question set, judged blind
```

`eval` answers every question in `.coding-brain/evals.json` twice — once
with the brain injected, once with the brain physically hidden from disk —
then a third model grades both answers without knowing which is which,
presentation order randomized. Per-question transcripts and verdicts land in
`.coding-brain/.state/evals/`.

I run this on my own workspace and publish the honest results: the brain
wins decisively on debugging-with-history and architecture questions, loses
some status questions to an agent that just reads the code, and every
failure mode we found this way became a fix. As far as I know this is the
only memory system that ships its own falsification harness instead of
asking you to trust it. Hits, misses, and evidence-corrections are also
logged per harvest.

## Features

- 🧠 **Compiled memory, not a log.** Every session gets distilled into a
  ~100-line STATE of what's true right now. New facts replace old ones.
  The store gets cleaner as it grows, not bigger.
- ✅ **Evidence-checked.** Transcript claims are reconciled against git and
  the filesystem before they're promoted to memory.
- 🔁 **One brain, all three tools.** Claude Code, Cursor, and Codex feed and
  read the same store. Also available as a [Herdr](https://herdr.dev) plugin
  (`herdr-memory`) that auto-builds the brain for every workspace you run
  agents in.
- 🎯 **Relevance-gated injection.** Full briefing on the first prompt; after
  that, only the project note your prompt is actually about — or nothing.
- 📊 **Self-measuring.** `ab` and `eval` run blind brain-vs-no-brain
  comparisons with an impartial judge; metrics log hits and corrections.
- 📁 **Plain files + git.** Markdown you can read, grep, and diff. One git
  commit per harvest, so `coding-brain log` shows exactly what it learned
  and when. Anything wrong is one revert away.
- 🔒 **Local and private.** No server, no telemetry, no API key. Wrap
  anything in `<private>...</private>` and it never reaches a model.
- 🛡️ **Hard to corrupt.** One lock shared by every writer, atomic
  file writes, and a harvest that can't report success unless the brain
  actually survived it. Each of these guards exists because the failure it
  prevents happened for real during development.
- 🪶 **No daemon, no vector DB, no heavy deps.** Hooks fire, do their job,
  and exit.

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
             ──► ONE model call: returns digest + topic + STATE as text
             ──► coding-brain applies the files itself (atomic, path-jailed)
             ──► git commit
session starts ─► receipt + briefing injected; later prompts get
                  relevance-matched topic notes, or silence
```

The model never touches your disk during a harvest. It returns text; the
orchestrator writes exactly three kinds of file — `sessions/*.md`,
`topics/*.md`, `STATE.md` — atomically, under a lock every writer shares.
One call per debounced session-end (about 40KB of new transcript before one
fires), roughly $0.30–0.50 of subscription quota, in the background, never
blocking your session.

The brain lives at `<workspace>/.coding-brain/`:

```
STATE.md          # the ~100-line briefing, injected at session start
topics/<slug>.md  # rolling per-project detail, rewritten in place
sessions/         # immutable session digests (raw history)
RULES.md          # learned conventions, promoted from your corrections
evals.json        # your blind-eval question set
.git/             # one commit per harvest
```

Most memory tools are diaries. They append every observation forever and
make you search the pile, and recall gets worse as the pile grows.
coding-brain rewrites its briefing in place instead, which is the same
conclusion OpenAI, Anthropic, and Google all landed on this year with their
background memory-consolidation passes. A bigger pile is not a better
memory. A cleaner one is.

## Commands

You only ever need the first one.

```
npx coding-brain init        # scan history, compile the starting brain, install hooks
npx coding-brain ui          # open the local viewer
npx coding-brain status      # is it alive, what does it hold, last commits
npx coding-brain search <w>  # ranked search over everything it knows
npx coding-brain log         # what it learned, when
npx coding-brain harvest     # force a harvest right now
npx coding-brain ab "<q>"    # one question: blind vs brain, side by side
npx coding-brain eval        # the whole question set, blind-judged
npx coding-brain uninstall   # removes hooks; your brain files stay put
```

## FAQ

**What does it cost?**
Nothing beyond the Claude subscription you already pay for. The one-time
starting compile prints its own receipt (typically $2–6 of quota). After
that, one single-turn call per debounced session-end, ~$0.30–0.50
equivalent. No API key, no separate billing, no background stream burning
tokens while you work.

**Why no cheap-model tier?** Because a shallow digest is worse than no
digest. The brain's whole job is to be the thing later sessions trust —
a cheap model writes confident-sounding wrong facts into STATE, and every
session after it inherits them. Every harvest runs on the best model the
host offers. Cost is controlled by *frequency* (debounce) and by doing each
harvest in one turn instead of an agentic loop, not by degrading quality.
Pin something else with `model` in `.coding-brain/config.json` if you
disagree.

**Does my code leave my machine?**
Only to your own Claude subscription for the distill call, which is where
your sessions already go. No server of mine, no telemetry, no uploads.

**What if a harvest writes something wrong?**
Every harvest is a git commit. Revert it. A background process that
rewrites your data without an audit trail is how you lose data quietly,
which is why the brain is born as a git repo.

**Can the brain eat its own output?**
No — its own background runs, backfills, and eval probes tag themselves,
and the session scanner skips them. Your brain compiles your work, not its
own diary. (Found the hard way: an early version spent real model budget
digesting its own eval answers.)

**"No daemon" — so what is the viewer?**
A plain python3 http.server on 127.0.0.1 that runs while you're looking at
it. Nothing else is ever resident — harvests are hook-triggered processes
that exit when done.

**Claude Code, Cursor, or Codex?**
All three, one brain. Claude Code and Cursor get injection hooks (session
start + per-prompt); Codex reads the briefing through a managed block in
`AGENTS.md` (markers only — the rest of your AGENTS.md is never touched)
and harvests through its `notify` hook. Enable with
`npx coding-brain init --cursor --codex`.

**I use Cursor but not Claude Code — does it work?**
Yes. Harvesting prefers the Claude Code CLI when it's installed and falls
back to Cursor's own `cursor-agent` CLI when it isn't — so a Cursor-only
machine gets the full loop. Pin either with `harvestEngine` in
`.coding-brain/config.json`.

## Requirements

macOS or Linux · Node ≥ 18 · python3 · git · the
[Claude Code](https://claude.com/claude-code) CLI logged in to your
subscription.

## Roadmap

More transcript readers (Gemini CLI and friends) · MCP server so non-hooked
tools can pull from the brain · Windows.
(Shipped: Codex CLI support · blind eval harness · cursor-agent harvest
fallback · weekly digest consolidation · miss-escalation, where a correction
repeated across sessions auto-promotes to a binding rule.)

## Status

v0.1.x. Young and moving fast. I've been running it daily across a
40-project workspace for weeks; it's how this README knows what it's
talking about — including the parts where it lost. Issues and war stories
welcome.

## License

Apache-2.0
