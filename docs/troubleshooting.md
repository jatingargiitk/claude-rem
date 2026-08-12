# Troubleshooting

## Is it alive?

```bash
npx claude-rem status     # brain location, last harvest age, counts
npx claude-rem log        # one line per harvest
```

The injection receipt is also a health signal: if your session's first
prompt shows no `🧠 brain →` line, the read side isn't firing.

## Harvests aren't happening

- Read `.claude-rem/.state/harvest.log`: every attempt logs there, with
  the reason it was skipped or failed.
- Short sessions are *supposed* to be skipped: harvests debounce until
  roughly 40KB of new transcript accumulates.
- `no engine`: install the Claude Code CLI (or `cursor-agent`); the
  harvester needs one of them.

## `a harvest is in progress` from init

A live harvest holds `.state/harvest.lock`. Wait a minute and retry. A
crashed harvest's lock goes stale and is ignored after 30 minutes.

## Hooks installed but nothing injects

Editors load hook config at startup: restart Claude Code / Cursor after
`init`. Check the hook entries exist (`~/.claude/settings.json`, workspace
`.cursor/hooks.json`) and point at `~/.claude-rem/runtime/scripts/`.

## The briefing says "0 topics"

Small corpora compile into STATE only: topic notes appear once a project
has enough distinct sessions. It fills in as you work.

## The viewer shows nothing

The viewer walks up from the current directory to find a `.claude-rem`:
run `npx claude-rem ui` from inside the workspace, or pass the brain dir
explicitly. Default port is 4180; a taken port walks forward automatically.

## Something wrong got memorized

```bash
cd .claude-rem && git log --oneline   # find the harvest
git revert <hash>                        # undo it
```

Or just edit the markdown: STATE and topics are plain files, and the next
harvest builds on what's there.

## Starting over

Delete `<workspace>/.claude-rem/` and run `npx claude-rem init` again.
Hooks are idempotent; re-running init is always safe.
