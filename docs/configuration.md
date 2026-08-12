# Configuration

## `.coding-brain/config.json`

Per-workspace settings. All keys optional.

| Key | Default | Meaning |
|---|---|---|
| `model` | best available | model used for harvests (see FAQ for why the default is not a cheap tier) |
| `harvestEngine` | auto | pin `claude` or `cursor-agent` instead of auto-detection |
| `uiPort` | `4180` | viewer port (`0` = OS-assigned; taken ports walk forward) |
| `liteStateWindowDays` | `7` | recency window for the starting compile's session selection |
| `liteStateSessions` | `30` | minimum sessions the starting compile includes |
| `fanoutProjectFloor` | `3` | newest sessions each project contributes regardless of age (protects "where did I leave X" for older projects) |
| `fanoutClusterSize` | `3` | sessions per digest-compile call |
| `fanoutMaxClusters` | `50` | cap on digest calls in one compile |
| `fanoutParallel` | `4` | concurrent compile calls |

## Environment variables

Mostly useful for sandboxed installs, demos, and tests: every path the
tool touches can be redirected.

| Variable | Redirects |
|---|---|
| `CODING_BRAIN_CLAUDE_DIR` | where Claude Code transcripts are read from (default `~/.claude`) |
| `CODING_BRAIN_CURSOR_DIR` | where Cursor transcripts are read from (default `~/.cursor`) |
| `CODING_BRAIN_CODEX_DIR` | where Codex sessions are read from (default `~/.codex`) |
| `CODING_BRAIN_SETTINGS` | the Claude Code settings file hooks are installed into |
| `CODING_BRAIN_GLOBAL_DIR` | the global dir (`~/.coding-brain`) |
| `CODING_BRAIN_RUNTIME` | the runtime scripts dir hooks point at |
| `CODING_BRAIN_DIR` | pin recall to an explicit brain (used by `ab`/`eval`) |
| `CODING_BRAIN_NO_UI` | `1` = never auto-open the viewer after `init` |
| `CODING_BRAIN_HARVEST` | set by the harvester on its own model calls; recursion guard, don't set manually |

## `RULES.md`: the global layer

`~/.coding-brain/RULES.md` holds conventions about *you* (identity, style,
hard nos), one rule per line. It's injected into every workspace's
sessions across all tools: the `~/.gitconfig` of the system. Workspace
facts belong in each workspace's brain, not here.

Rules also get promoted automatically: a correction you've had to repeat
across sessions escalates into a binding rule (miss-escalation).

## Teaching it directly

Two in-session mechanisms, no config needed:

- `brain miss: <what you had to re-explain>` — one line in any session;
  becomes permanent memory.
- `<private>...</private>` — anything wrapped in these tags is stripped
  before any model call and never reaches memory.
