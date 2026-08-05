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

**Status: in development.** This package currently reserves the name and the
`coding-brain` CLI. The real release is coming — watch the repo.

## License

Apache-2.0
