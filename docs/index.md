# 🧠 coding-brain

**One brain for AI coding tools. Your agent never starts from zero again.**

coding-brain reads each session after it ends, distills what mattered into a
small briefing of your workspace, verifies it against your actual repos, and
hands that briefing to your agent the moment the next session starts. Claude
Code, Cursor, and Codex all feed the same store, and all three read from it.

```bash
cd ~/your-workspace
npx coding-brain init
```

## Where to go

- **[Installation](installation.md)**: quick start, flags, marketplace install
- **[How It Works](how-it-works.md)**: the harvest loop and the three memory layers
- **[Architecture](architecture.md)**: hooks, engines, corruption resistance
- **[Configuration](configuration.md)**: config keys, env vars, the rules layer
- **[Evaluation](evaluation.md)**: the blind brain-vs-no-brain harness
- **[Privacy](privacy.md)**: everything stays local, and how redaction works
- **[Troubleshooting](troubleshooting.md)**: health checks and failure modes

## The two ideas

**Compiled, not appended.** Most memory tools are diaries: they append every
observation forever and recall gets worse as the pile grows. coding-brain
rewrites a ~100-line briefing in place; the store gets cleaner as it grows.

**Evidence over claims.** A transcript is a set of claims, not a record.
Before anything becomes memory it's checked against your repos: if the
session says "built the API" and git says otherwise, the brain believes git.
