# Privacy

## Where your data lives

On your disk, in plain markdown, in a git repo you own:
`<workspace>/.claude-rem/`. There is no server, no telemetry, no account,
no API key.

## What leaves your machine

One thing: the harvest's distill call goes to your own Claude subscription
(or your Cursor account when `cursor-agent` is the engine), which is where
your sessions already go. Nothing else, nowhere else.

## Redaction

Wrap anything in `<private>...</private>` in any session and it is stripped
before the transcript reaches any model call. It never enters digests,
topics, STATE, or logs.

## Cloud and web sessions

By design, claude-rem is local. Local hooks deliver the brain, so every
local surface works: the terminal, the VS Code and JetBrains extensions,
the desktop app, Cursor, and the Codex CLI. Cloud sandboxes (claude.ai web
chat, claude.ai/code cloud sessions) can't reach your disk, so they neither
read nor feed the brain. Your memory stays on your machine; that's the
trade, and it's deliberate.

## Auditability

Every change to memory is a git commit (`claude-rem log`). If a harvest
ever writes something you don't like, revert it. A background process that
rewrites your data without an audit trail is how you lose data quietly,
which is why the brain is born as a git repo.
