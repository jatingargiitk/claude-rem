<h1 align="center">
  <br>
  🧠
  <br>
  claude-rem
  <br>
</h1>

<h4 align="center">A brain that remembers your decisions, fixes, and gotchas. One memory for all your AI coding tools.</h4>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-rem">
    <img src="https://img.shields.io/npm/v/claude-rem?color=green" alt="npm">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License">
  </a>
  <a href="#requirements">
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg" alt="Node">
  </a>
  <a href="#faq">
    <img src="https://img.shields.io/badge/API%20key-not%20needed-brightgreen" alt="No API key">
  </a>
</p>

<p align="center">
  <a href="https://claude.com/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-supported-d97757" alt="Claude Code"></a>
  <a href="https://cursor.com"><img src="https://img.shields.io/badge/Cursor-supported-111111" alt="Cursor"></a>
  <a href="https://github.com/openai/codex"><img src="https://img.shields.io/badge/Codex%20CLI-supported-10a37f" alt="Codex CLI"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#works-with">Works With</a> •
  <a href="#what-it-looks-like">What It Looks Like</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#commands">Commands</a> •
  <a href="#faq">FAQ</a> •
  <a href="#license">License</a>
</p>

<p align="center">
  claude-rem reads each session after it ends, distills what mattered into a
  small briefing of your workspace, verifies it against your actual repos, and
  hands that briefing to your agent the moment the next session starts.
  Tell it something once, anywhere; every tool remembers it.
</p>

---

I got tired of re-explaining my repos, my decisions, and my gotchas to every
new session. So I built a brain that remembers. Two things make it different
from every memory tool I tried first:

**It's one brain across tools.** Claude Code, Cursor, and Codex sessions all
feed the same store, and all three read from it. No vendor will ever build
this for you, none of them will compile a competitor's transcripts.

**It doesn't believe transcripts.** A transcript is a set of claims, not a
record. Agents confidently report things that didn't happen, so before
anything becomes memory it's checked against your actual repos: git status,
whether the artifact exists. If the session says "built the API" and git says
otherwise, the brain believes git.

**Why "rem"?** REM sleep is when a brain replays the day and consolidates it
into long-term memory. That is this tool's entire job: after each session
ends it replays the transcript, checks it against reality, and consolidates
what mattered into memory your agent wakes up with.

---

## Quick Start

Install with a single command:

```bash
cd ~/your-workspace        # the directory you open your coding agent in
npx claude-rem init
```

Or install from the plugin marketplace inside Claude Code:

```bash
/plugin marketplace add jatingargiitk/claude-rem

/plugin install claude-rem
```

Init scans your past sessions (with your consent) and compiles a real
starting brain, not just a summary, so it remembers your history from day
one. Session digests, a rolling note per
project, and the briefing, built by parallel single-shot model calls with a
cost receipt at the end:

```
Brain compiled: 43 session digest(s), 14 topic note(s) in 434s.
```

A few minutes, once per workspace, ever. It runs on the Claude subscription
you already pay for and prints its own receipt. From then on everything is
automatic.

**Key Features:**

- 🧠 **Compiled memory, not a log**: every session is distilled into a ~100-line
  STATE of what's true right now; new facts replace old ones, so the store gets
  cleaner as it grows, not bigger
- ✅ **Evidence-checked**: transcript claims are reconciled against git and the
  filesystem before they're promoted to memory
- 🔁 **One brain, every tool**: Claude Code, Cursor, and Codex feed and read the
  same store
- 🎯 **Relevance-gated injection**: full briefing on the first prompt; after that,
  only the project note your prompt is actually about, or silence
- 📊 **Self-measuring**: `ab` and `eval` run blind brain-vs-no-brain comparisons
  with an impartial judge; hits, misses, and corrections are logged per harvest
- 🗞️ **A briefing, not a file dump**: the local viewer opens on a model-written
  brief of your work: headline, where you left off, recent wins, heads-up
- 📁 **Plain files + git**: markdown you can read, grep, and diff; one commit per
  harvest, so anything wrong is one revert away
- 🔒 **Local and private**: no server, no telemetry, no API key; wrap anything in
  `<private>...</private>` and it never reaches a model
- 🛡️ **Hard to corrupt**: one lock shared by every writer, atomic writes, and a
  harvest that can't report success unless the brain actually survived it
- 🪶 **No daemon, no vector DB, no heavy deps**: hooks fire, do their job, exit

---

## Works With

| Tool | Reads the brain | Feeds the brain |
|---|---|---|
| **[Claude Code](https://claude.com/claude-code)** | session-start + per-prompt injection hooks | Stop-hook harvest |
| **[Cursor](https://cursor.com)** | session-start + per-prompt injection hooks | stop-hook harvest (falls back to `cursor-agent` as the engine on machines without the Claude CLI) |
| **[Codex CLI](https://github.com/openai/codex)** | managed block in `AGENTS.md` (markers only; the rest of your file is never touched) | `notify`-hook harvest |

One store, three tools:

```bash
npx claude-rem init --cursor --codex
```

Something you explained in a Cursor session is already known to your next
Claude Code session, and vice versa. That cross-tool store is the point: your
memory belongs to you, not to whichever agent you happened to be using.

---

## What It Looks Like

The first prompt of a session gets the full briefing, with a receipt naming
exactly what was injected:

```
🧠 brain → STATE.md · 14 topics indexed (harvest 33m ago)
```

After that, the brain only speaks when your prompt matches something it
knows. It pulls the relevant project note and names it:

```
🧠 brain → tiny-api
```

No match, no injection, no receipt. The brain is invisible when it has
nothing to add.

Behind the receipt sits STATE.md, the briefing your agent reads before you
type. Real output, compiled from real sessions on a two-service workspace:

```markdown
## Active projects
- **webhook-relay** (`relay.py`): verifies Stripe HMAC-SHA256 signatures
  (constant-time compare), forwards to an internal queue, retries
  1s/2s/4s/8s/16s then dead-letters. Queue changed from unbounded to
  bounded (maxsize 1000) with HTTP 429 backpressure on 2026-08-12,
  root-caused as the fix for a same-day incident where a traffic spike
  OOM-killed the process and dropped in-flight events.
- **tiny-api** (`app.py`): Flask items API confirmed working both from
  shell and under launchd, on port 5057. DB path changed from relative to
  absolute, which resolved 500s that occurred only under launchd.

## Conventions
- webhook-relay: payload bodies are never logged (may contain customer
  PII) — only event ID + status, per explicit user instruction.
- tiny-api: port 5057 instead of 5000 — macOS AirPlay Receiver occupies
  5000, causing "address already in use".

## Open threads
- webhook-relay: no metrics/alerting on queue depth yet — flagged as
  needed to catch backpressure situations before they recur.
- Cross-project gotcha: launchd-run processes do not share the shell's
  working directory. This caused the tiny-api DB bug; webhook-relay has
  NOT yet been audited for the same relative-path assumption.
- Cross-project gotcha: an unbounded internal queue is a silent OOM risk
  that surfaces only under load. This caused the webhook-relay incident;
  other queues have not been checked for the same pattern.
```

Three things worth noticing. The PII logging rule exists because the user
said it once, mid-session, and it became a permanent convention. The
incident entry keeps the root cause and the fix rationale together, not
just the final code state. And the cross-project gotchas at the bottom are
the part grep can never give you: the brain generalized each incident into
a pattern and flagged the *other* service as unaudited for it. That is the
difference between storing your history and remembering it.

One more thing the injected context always carries: an instruction that
memory is **leads, not findings**. Open threads are starting points to
investigate, not answers to recite; status claims get re-verified before
they're repeated. That instruction exists because blind testing (below)
showed a brain without it makes agents *passive*: knowing a problem is open
became a reason to stop working on it.

### The viewer

```bash
npx claude-rem ui
```

Opens a local dashboard (127.0.0.1 only) that leads with the brain
*talking*: a model-written headline and narrative of where your work stands,
three columns (where you left off, recent wins, heads up), a search box
wired to the same retrieval your agents use, the topic index, and the feed
of everything it's learned. `init` opens it once at the end so your install
lands on an "it knows my work" moment, not terminal text. No daemon: it runs
while you look at it, Ctrl-C closes it.

---

## It Measures Itself

```bash
npx claude-rem ab "why is the deploy failing?"   # one question, blind vs brain
npx claude-rem eval                              # your whole question set, judged blind
```

`eval` answers every question in `.claude-rem/evals.json` twice, once
with the brain injected, once with the brain physically hidden from disk,
then a third model grades both answers without knowing which is which,
presentation order randomized. Per-question transcripts and verdicts land in
`.claude-rem/.state/evals/`.

I run this on my own workspace and publish the honest results: the brain
wins decisively on debugging-with-history and architecture questions, loses
some status questions to an agent that just reads the code, and every
failure mode we found this way became a fix. As far as I know this is the
only memory system that ships its own falsification harness instead of
asking you to trust it.

---

## How It Works

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
orchestrator writes exactly three kinds of file, `sessions/*.md`,
`topics/*.md`, `STATE.md`, atomically, under a lock every writer shares.
One call per debounced session-end (about 40KB of new transcript before one
fires), in the background, never blocking your session.

The brain lives at `<workspace>/.claude-rem/`:

```
STATE.md          # the ~100-line briefing, injected at session start
topics/<slug>.md  # rolling per-project detail, rewritten in place
sessions/         # immutable session digests (raw history)
RULES.md          # learned conventions, promoted from your corrections
evals.json        # your blind-eval question set
.git/             # one commit per harvest
```

Most memory tools are diaries. They append every observation forever and
make you search the pile, and recall gets worse as the pile grows. That is
storage, not remembering. claude-rem rewrites its briefing in place
instead, the way a brain consolidates during REM sleep, which is the same
conclusion OpenAI, Anthropic, and Google all landed on this year with their
background memory-consolidation passes. A bigger pile is not a better
memory. A cleaner one is.

---

## Commands

You only ever need the first one.

```
npx claude-rem init        # scan history, compile the starting brain, install hooks
npx claude-rem ui          # open the local dashboard
npx claude-rem status      # is it alive, what does it hold, last commits
npx claude-rem search <w>  # ranked search over everything it knows
npx claude-rem log         # what it learned, when
npx claude-rem harvest     # force a harvest right now
npx claude-rem ab "<q>"    # one question: blind vs brain, side by side
npx claude-rem eval        # the whole question set, blind-judged
npx claude-rem uninstall   # removes hooks; your brain files stay put
```

---

## Documentation

- **[Installation](docs/installation.md)**: quick start, flags, marketplace install, uninstall
- **[How It Works](docs/how-it-works.md)**: the harvest loop, the three memory layers, evidence-checking, injection
- **[Architecture](docs/architecture.md)**: per-tool hooks, harvest engines, corruption resistance, the viewer
- **[Configuration](docs/configuration.md)**: `config.json` keys, env vars, the global rules layer, teaching it directly
- **[Evaluation](docs/evaluation.md)**: the blind ab/eval harness and what honest results look like
- **[Privacy](docs/privacy.md)**: what stays local (everything), what leaves (one distill call), redaction
- **[Troubleshooting](docs/troubleshooting.md)**: health checks, common failure modes, starting over

---

## FAQ

**What does it cost?**
Nothing beyond the Claude subscription you already pay for. No API key, no
separate billing, no background stream burning tokens while you work. The
one-time starting compile prints its own cost receipt so you see exactly
what it used; after that it's one small single-turn call per session-end.

**Why no cheap-model tier?**
Because a shallow digest is worse than no digest. The brain's whole job is
to be the thing later sessions trust, a cheap model writes
confident-sounding wrong facts into STATE, and every session after it
inherits them. Every harvest runs on the best model the host offers. Cost is
controlled by *frequency* (debounce) and by doing each harvest in one turn
instead of an agentic loop, not by degrading quality. Pin something else
with `model` in `.claude-rem/config.json` if you disagree.

**Does my code leave my machine?**
Only to your own Claude subscription for the distill call, which is where
your sessions already go. No server of mine, no telemetry, no uploads.

**Does it work in claude.ai web / cloud sessions?**
No. By design it's local. The brain lives on your machine and is delivered
by local hooks, so every local surface works (terminal, VS Code / JetBrains
extensions, the desktop app, Cursor, Codex CLI), but cloud sandboxes can't
reach it. Your memory stays on your disk; that's the trade.

**What if a harvest writes something wrong?**
Every harvest is a git commit. Revert it. A background process that
rewrites your data without an audit trail is how you lose data quietly,
which is why the brain is born as a git repo.

**Can the brain eat its own output?**
No. Its own background runs, backfills, and eval probes tag themselves,
and the session scanner skips them. Your brain compiles your work, not its
own diary. (Found the hard way: an early version spent real model budget
digesting its own eval answers.)

**"No daemon", so what is the viewer?**
A plain python3 http.server on 127.0.0.1 that runs while you're looking at
it. Nothing else is ever resident, harvests are hook-triggered processes
that exit when done.

**I use Cursor but not Claude Code, does it work?**
Yes. Harvesting prefers the Claude Code CLI when it's installed and falls
back to Cursor's own `cursor-agent` CLI when it isn't, so a Cursor-only
machine gets the full loop. Pin either with `harvestEngine` in
`.claude-rem/config.json`.

---

## Requirements

macOS or Linux · Node ≥ 18 · python3 · git · the
[Claude Code](https://claude.com/claude-code) CLI logged in to your
subscription (or `cursor-agent` on Cursor-only machines).

## Roadmap

More transcript readers (Gemini CLI and friends) · MCP server so non-hooked
tools can pull from the brain · Windows.

## Status

v0.2.x. Young and moving fast. I've been running it daily across a
40-project workspace for weeks; it's how this README knows what it's
talking about, including the parts where it lost. Issues and war stories
welcome.

## License

Apache-2.0
