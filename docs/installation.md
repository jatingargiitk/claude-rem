# Installation

## Quick install

```bash
cd ~/your-workspace        # the directory you open your coding agent in
npx claude-rem init
```

`init` does five things, in order:

1. **Inventory** (free, no model calls): scans your past Claude Code, Cursor,
   and Codex transcripts for sessions that belong to this workspace.
2. **Consent**: shows what it found and asks before compiling anything.
   Answer `l` to list projects and exclude some.
3. **Compile**: builds the starting brain from those sessions: session
   digests, a rolling note per project, and the STATE briefing. Prints a
   cost receipt at the end.
4. **Hooks**: installs the session hooks for your tools (see below).
5. **Viewer**: opens the local dashboard once so the install ends on the
   briefing, not terminal text.

## Flags

| Flag | Effect |
|---|---|
| `--yes` | skip the consent prompt (CI / scripted installs) |
| `--dry-run` | inventory only: show what would be compiled, change nothing |
| `--hooks-only` | install hooks, skip the starting compile |
| `--no-hooks` | scaffold the brain only, touch no editor config |
| `--cursor` | also install Cursor hooks |
| `--codex` | also install Codex support (`AGENTS.md` block + `notify` hook) |
| `--no-ui` | don't open the viewer at the end |

## From the Claude Code plugin marketplace

```
/plugin marketplace add jatingargiitk/claude-rem
/plugin install claude-rem
```

## Requirements

- macOS or Linux
- Node ≥ 18, python3, git
- The [Claude Code](https://claude.com/claude-code) CLI logged in to your
  subscription, **or** Cursor's `cursor-agent` CLI (used automatically as
  the harvest engine when `claude` isn't installed)

## Uninstall

```bash
npx claude-rem uninstall
```

Removes the hooks from your editor config. Your brain files
(`.claude-rem/` in each workspace) are left untouched: they're plain
markdown in a git repo, and they're yours.
