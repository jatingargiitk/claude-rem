#!/usr/bin/env node
// coding-brain — a compiled brain for Claude Code, Cursor & Codex.
// CLI entry. Node >= 18, ZERO npm dependencies.
//
// Subcommands:
//   init       inventory -> consent -> lite STATE -> hook install
//   status     brain location, freshness, counts, last commits
//   search     ranked lexical search over the brain (delegates to search.sh)
//   log        git log of the brain repo
//   harvest    force-harvest the newest unharvested transcript now
//   uninstall  remove hooks (leaves the brain dir untouched)
//
// Env overrides (used by tests; defaults are the real locations):
//   CODING_BRAIN_CLAUDE_DIR   default ~/.claude
//   CODING_BRAIN_CURSOR_DIR   default ~/.cursor
//   CODING_BRAIN_CODEX_DIR    default ~/.codex
//   CODING_BRAIN_SETTINGS     default ~/.claude/settings.json

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const PKG_SCRIPTS = path.join(PKG_ROOT, 'scripts');
const TEMPLATES = path.join(PKG_ROOT, 'templates');

// Hooks must reference a STABLE path. When run via `npx`, PKG_ROOT lives in
// the npx cache, which npm can evict at any time — hooks pointing there die
// silently weeks later. So we copy scripts/ to ~/.coding-brain/runtime/ and
// point every installed hook at that copy (refreshed on each init/run).
const RUNTIME_DIR = process.env.CODING_BRAIN_RUNTIME
  || path.join(os.homedir(), '.coding-brain', 'runtime');
const SCRIPTS = path.join(RUNTIME_DIR, 'scripts');

const GLOBAL_DIR = process.env.CODING_BRAIN_GLOBAL_DIR || path.join(os.homedir(), '.coding-brain');

function ensureRuntime() {
  fs.mkdirSync(SCRIPTS, { recursive: true });
  // Seed the global rules file (the ~/.gitconfig layer): personal conventions
  // injected into EVERY workspace. All-comments template = inactive until the
  // user writes a first rule.
  const globalRules = path.join(GLOBAL_DIR, 'RULES.md');
  if (!fs.existsSync(globalRules)) {
    fs.mkdirSync(GLOBAL_DIR, { recursive: true });
    fs.writeFileSync(globalRules, `# Global rules — injected into every workspace's sessions (all tools).
# Like ~/.gitconfig next to a repo's .git/config: put conventions about YOU
# here (identity, style, hard nos); workspace facts belong in each brain.
# One rule per line, "- " prefix. Delete these comments as you like.
# Examples:
# - Commit personal repos as <name> <email>; never override per-commit.
# - Never force-push a default branch.
`);
  }
  for (const f of fs.readdirSync(PKG_SCRIPTS)) {
    const src = path.join(PKG_SCRIPTS, f);
    const dst = path.join(SCRIPTS, f);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }
}

const CLAUDE_DIR = process.env.CODING_BRAIN_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const CURSOR_DIR = process.env.CODING_BRAIN_CURSOR_DIR || path.join(os.homedir(), '.cursor');
const CODEX_DIR = process.env.CODING_BRAIN_CODEX_DIR || path.join(os.homedir(), '.codex');
const SETTINGS_PATH = process.env.CODING_BRAIN_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');

// ------------------------------------------------------------------ helpers

function readJsonSoft(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function findBrain(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const cand = path.join(dir, '.coding-brain');
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function ago(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function countFiles(dir, ext) {
  try {
    return fs.readdirSync(dir).filter((f) => !ext || f.endsWith(ext)).length;
  } catch { return 0; }
}

async function ask(question, def) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return (answer || '').trim() || def;
}

function die(msg) {
  console.error(`coding-brain: ${msg}`);
  process.exit(1);
}

function findFreePort(start) {
  // Walk forward from `start` until a 127.0.0.1 port binds; 0 on give-up
  // (ui.py then lets the OS pick and prints whatever it got).
  const net = require('net');
  return new Promise((resolve) => {
    const tryPort = (p, attempts) => {
      if (attempts <= 0) return resolve(0);
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1, attempts - 1));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(p)));
    };
    tryPort(start, 20);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'linux' ? 'xdg-open' : null;
  if (!cmd) return;
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* best-effort */ }
}

// --------------------------------------------------------------- inventory
// Scan Claude Code (~/.claude/projects/*/) and Cursor
// (~/.cursor/projects/*/agent-transcripts/) for transcripts whose session cwd
// is under this workspace. Free — no LLM, no network.

function mungeCursor(p) {
  // /Users/me/dev/ws -> Users-me-dev-ws (Cursor project dir naming)
  return p.replace(/^\//, '').replace(/\//g, '-');
}

function claudeCwdOf(jsonlPath) {
  // Cheap: read the head of the file and regex out the first "cwd" field.
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return JSON.parse('"' + m[1] + '"');
  } catch { /* unreadable — skip */ }
  return null;
}

function codexCwdOf(jsonlPath) {
  // Codex rollouts: line 1 is session_meta with payload.cwd. Read only the
  // head and only the first line — cheap enough to scan every rollout.
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let head = buf.toString('utf8', 0, n);
    const nl = head.indexOf('\n');
    if (nl !== -1) head = head.slice(0, nl);
    const m = head.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return JSON.parse('"' + m[1] + '"');
  } catch { /* unreadable — skip */ }
  return null;
}

function walkJsonl(dir, depth) {
  // Codex nests sessions as YYYY/MM/DD/rollout-*.jsonl; walk with a depth cap.
  const out = [];
  if (depth < 0) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(p, depth - 1));
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Transcripts produced by coding-brain itself — harvester runs, backfill
// compiles, ab/eval probes — land in the same stores as real sessions and
// carry the same cwd. Left in, they inflate the corpus (measured: 131 of 339
// "sessions" in one workspace were exhaust) and the backfill then spends real
// model budget compiling the brain's own diary. Sniff the head and skip.
const META_MARKERS = [
  'You are the coding-brain harvester',
  'You are initializing a coding brain',
  '[coding-brain:meta]',
];
function isMetaTranscript(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    return META_MARKERS.some((m) => head.includes(m));
  } catch { return false; }
}

function inventory(workspace) {
  const sessions = []; // {path, mtime, source, project}
  const wsPrefix = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;

  // Claude Code transcripts carry the real cwd inside the JSONL.
  const cProjects = path.join(CLAUDE_DIR, 'projects');
  for (const dir of fs.existsSync(cProjects) ? fs.readdirSync(cProjects) : []) {
    const full = path.join(cProjects, dir);
    let files;
    try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = path.join(full, f);
      const cwd = claudeCwdOf(p);
      if (!cwd || (cwd !== workspace && !cwd.startsWith(wsPrefix))) continue;
      const rel = cwd === workspace ? '.' : path.relative(workspace, cwd).split(path.sep)[0];
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
      if (isMetaTranscript(p)) continue;
      sessions.push({ path: p, mtime, source: 'claude', project: rel || '.' });
    }
  }

  // Cursor transcripts have no cwd field; the project dir name encodes the
  // workspace path (slashes -> dashes).
  const munged = mungeCursor(workspace);
  const uProjects = path.join(CURSOR_DIR, 'projects');
  for (const dir of fs.existsSync(uProjects) ? fs.readdirSync(uProjects) : []) {
    if (dir !== munged && !dir.startsWith(munged + '-')) continue;
    const sub = dir === munged ? '.' : dir.slice(munged.length + 1);
    const tDir = path.join(uProjects, dir, 'agent-transcripts');
    let entries;
    try { entries = fs.readdirSync(tDir); } catch { continue; }
    for (const e of entries) {
      const p = path.join(tDir, e, e + '.jsonl');
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
      if (isMetaTranscript(p)) continue;
    sessions.push({ path: p, mtime, source: 'cursor', project: sub });
    }
  }

  // Codex rollouts carry the workspace cwd in their session_meta first line.
  const xSessions = path.join(CODEX_DIR, 'sessions');
  for (const p of walkJsonl(xSessions, 6)) {
    if (!path.basename(p).startsWith('rollout-')) continue;
    const cwd = codexCwdOf(p);
    if (!cwd || (cwd !== workspace && !cwd.startsWith(wsPrefix))) continue;
    const rel = cwd === workspace ? '.' : path.relative(workspace, cwd).split(path.sep)[0];
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch { continue; }
    if (isMetaTranscript(p)) continue;
    sessions.push({ path: p, mtime, source: 'codex', project: rel || '.' });
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// ------------------------------------------------------------ hook install
// Idempotent merge into Claude Code settings: never duplicate (checked by
// command string), never remove existing entries.

const CC_HOOKS = [
  { event: 'Stop', command: `bash "${path.join(SCRIPTS, 'harvest-hook.sh')}"`, marker: 'scripts/harvest-hook.sh' },
  { event: 'UserPromptSubmit', command: `bash "${path.join(SCRIPTS, 'recall-hook.sh')}"`, marker: 'scripts/recall-hook.sh' },
];

function hasHookCommand(settings, event, marker) {
  const groups = (settings.hooks && settings.hooks[event]) || [];
  for (const g of groups) {
    for (const h of (g.hooks || [])) {
      if (typeof h.command === 'string' && h.command.includes(marker)) return true;
    }
  }
  return false;
}

function installClaudeHooks(opts) {
  const settings = readJsonSoft(SETTINGS_PATH, {});
  settings.hooks = settings.hooks || {};
  const added = [];
  for (const { event, command, marker } of CC_HOOKS) {
    if (hasHookCommand(settings, event, marker)) continue;
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({ hooks: [{ type: 'command', command }] });
    added.push(event);
  }
  if (opts.dryRun) {
    console.log(`[dry-run] would ${added.length ? 'add ' + added.join(', ') + ' hook(s) to' : 'leave unchanged'}: ${SETTINGS_PATH}`);
    return added;
  }
  if (added.length) writeJsonAtomic(SETTINGS_PATH, settings);
  console.log(added.length
    ? `Installed Claude Code hooks (${added.join(', ')}) in ${SETTINGS_PATH}`
    : `Claude Code hooks already installed in ${SETTINGS_PATH}`);
  return added;
}

function uninstallClaudeHooks(opts) {
  const settings = readJsonSoft(SETTINGS_PATH, null);
  if (!settings || !settings.hooks) { console.log('No Claude Code hooks to remove.'); return; }
  const markers = CC_HOOKS.map((h) => h.marker);
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !(typeof h.command === 'string' && markers.some((m) => h.command.includes(m))));
      removed += before - g.hooks.length;
    }
    settings.hooks[event] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (opts.dryRun) { console.log(`[dry-run] would remove ${removed} hook entr${removed === 1 ? 'y' : 'ies'} from ${SETTINGS_PATH}`); return; }
  if (removed) writeJsonAtomic(SETTINGS_PATH, settings);
  console.log(`Removed ${removed} coding-brain hook entr${removed === 1 ? 'y' : 'ies'} from ${SETTINGS_PATH}`);
}

const CURSOR_HOOKS = [
  { event: 'stop', command: `"${path.join(SCRIPTS, 'cursor-harvest-hook.sh')}"`, marker: 'scripts/cursor-harvest-hook.sh', timeout: 10 },
  { event: 'sessionStart', command: `"${path.join(SCRIPTS, 'cursor-recall-hook.sh')}"`, marker: 'scripts/cursor-recall-hook.sh', timeout: 10 },

  { event: 'beforeSubmitPrompt', command: `"${path.join(SCRIPTS, 'cursor-prompt-hook.sh')}"`, marker: 'scripts/cursor-prompt-hook.sh', timeout: 10 },
];

function installCursorHooks(workspace, opts) {
  const hooksPath = path.join(workspace, '.cursor', 'hooks.json');
  const cfg = readJsonSoft(hooksPath, { version: 1, hooks: {} });
  cfg.version = cfg.version || 1;
  cfg.hooks = cfg.hooks || {};
  const added = [];
  for (const { event, command, marker, timeout } of CURSOR_HOOKS) {
    const arr = cfg.hooks[event] || [];
    if (arr.some((h) => typeof h.command === 'string' && h.command.includes(marker))) continue;
    arr.push({ command, timeout });
    cfg.hooks[event] = arr;
    added.push(event);
  }
  if (opts.dryRun) { console.log(`[dry-run] would ${added.length ? 'add ' + added.join(', ') + ' to' : 'leave unchanged'}: ${hooksPath}`); return; }
  if (added.length) writeJsonAtomic(hooksPath, cfg);
  console.log(added.length
    ? `Installed Cursor project hooks (${added.join(', ')}) in ${hooksPath}`
    : `Cursor project hooks already installed in ${hooksPath}`);
}

function uninstallCursorHooks(workspace, opts) {
  const hooksPath = path.join(workspace, '.cursor', 'hooks.json');
  const cfg = readJsonSoft(hooksPath, null);
  if (!cfg || !cfg.hooks) return;
  const markers = CURSOR_HOOKS.map((h) => h.marker);
  let removed = 0;
  for (const event of Object.keys(cfg.hooks)) {
    const arr = cfg.hooks[event];
    if (!Array.isArray(arr)) continue;
    const before = arr.length;
    cfg.hooks[event] = arr.filter((h) => !(typeof h.command === 'string' && markers.some((m) => h.command.includes(m))));
    removed += before - cfg.hooks[event].length;
    if (cfg.hooks[event].length === 0) delete cfg.hooks[event];
  }
  if (opts.dryRun) { console.log(`[dry-run] would remove ${removed} entr${removed === 1 ? 'y' : 'ies'} from ${hooksPath}`); return; }
  if (removed) writeJsonAtomic(hooksPath, cfg);
  if (removed) console.log(`Removed ${removed} coding-brain hook entr${removed === 1 ? 'y' : 'ies'} from ${hooksPath}`);
}

// ------------------------------------------------------------ codex support
// Codex has no hook system. Harvest side: its config.toml `notify` key runs
// an external program on events like agent-turn-complete — we point it at
// codex-notify-hook.sh (runtime copy). Recall side: Codex natively reads
// AGENTS.md from the workspace root, so init plants a managed block there
// (refreshed after every harvest by distill.sh).

const CODEX_NOTIFY_MARKER = 'codex-notify-hook.sh';
const CODEX_COMMENT = '# coding-brain harvest hook (managed by coding-brain; `npx coding-brain uninstall` removes it)';
// Pre-0.1.6 installs wrote the comment without the npx prefix — uninstall
// must still recognize and remove it.
const CODEX_COMMENT_LEGACY = '# coding-brain harvest hook (managed by coding-brain; `coding-brain uninstall` removes it)';

function installCodexNotify(opts) {
  const configPath = path.join(CODEX_DIR, 'config.toml');
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { /* fresh config */ }
  const hookPath = path.join(SCRIPTS, 'codex-notify-hook.sh');
  const notifyLine = `notify = ["bash", "${hookPath}"]`;
  const existing = text.match(/^[ \t]*notify[ \t]*=.*$/m);
  if (existing) {
    if (existing[0].includes(CODEX_NOTIFY_MARKER)) {
      console.log(`Codex notify hook already installed in ${configPath}`);
      return;
    }
    // Never clobber a foreign notify program — TOML allows only one.
    console.log(`Codex config.toml already has a notify entry (${existing[0].trim()}).`);
    console.log('Not overwriting it. To chain coding-brain manually, make your notify');
    console.log(`program also run: bash "${hookPath}" (it ignores its argument and exits fast).`);
    return;
  }
  if (opts.dryRun) { console.log(`[dry-run] would prepend notify entry to ${configPath}`); return; }
  // TOML top-level keys MUST appear before any [table] section, so the
  // notify line goes at the very top of the file.
  const out = `${CODEX_COMMENT}\n${notifyLine}\n\n${text}`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = configPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, configPath);
  console.log(`Installed Codex notify hook in ${configPath}`);
}

function uninstallCodexNotify(opts) {
  const configPath = path.join(CODEX_DIR, 'config.toml');
  let text = '';
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return; }
  const lines = text.split('\n');
  const kept = lines.filter((l) => {
    if (/^[ \t]*notify[ \t]*=/.test(l) && l.includes(CODEX_NOTIFY_MARKER)) return false;
    if (l.trim() === CODEX_COMMENT || l.trim() === CODEX_COMMENT_LEGACY) return false;
    return true;
  });
  const removed = lines.length - kept.length;
  if (!removed) return;
  if (opts.dryRun) { console.log(`[dry-run] would remove notify entry from ${configPath}`); return; }
  fs.writeFileSync(configPath, kept.join('\n').replace(/^\n+/, ''));
  console.log(`Removed coding-brain notify entry from ${configPath}`);
}

function installCodex(workspace, brain, opts) {
  installCodexNotify(opts);
  if (opts.dryRun) { console.log(`[dry-run] would write the managed block in ${path.join(workspace, 'AGENTS.md')}`); return; }
  const r = spawnSync('bash', [path.join(SCRIPTS, 'agents-block.sh'), workspace, brain], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status === 0) {
    console.log(`Managed brain block written to ${path.join(workspace, 'AGENTS.md')} (Codex reads it at session start).`);
  } else {
    console.log(`AGENTS.md block install failed: ${(r.stderr || '').toString().slice(0, 200)}`);
  }
}

function uninstallCodex(workspace, opts) {
  uninstallCodexNotify(opts);
  if (opts.dryRun) { console.log('[dry-run] would remove the AGENTS.md managed block'); return; }
  const agents = path.join(workspace, 'AGENTS.md');
  if (fs.existsSync(agents) && fs.readFileSync(agents, 'utf8').includes('coding-brain:start')) {
    spawnSync('bash', [path.join(SCRIPTS, 'agents-block.sh'), '--remove', workspace], { stdio: 'ignore' });
    console.log(`Removed the coding-brain managed block from ${agents}`);
  }
}

// ----------------------------------------------------------- brain scaffold

function scaffoldBrain(workspace) {
  const brain = path.join(workspace, '.coding-brain');
  fs.mkdirSync(path.join(brain, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(brain, 'topics'), { recursive: true });
  fs.mkdirSync(path.join(brain, '.state'), { recursive: true });
  const copies = [
    ['INSTRUCTIONS.md', 'INSTRUCTIONS.md'],
    ['config.json', 'config.json'],
  ];
  for (const [src, dst] of copies) {
    const target = path.join(brain, dst);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(TEMPLATES, src), target);
  }
  const notes = path.join(brain, 'NOTES.md');
  if (!fs.existsSync(notes)) {
    fs.writeFileSync(notes, '# Quick notes (pending harvest)\n\nAdd bullets here mid-session; the next harvest folds them into STATE and clears them.\n');
  }
  // Create initial STATE.md so fresh brains don't look empty
  const stateFile = path.join(brain, 'STATE.md');
  if (!fs.existsSync(stateFile)) {
    const initialState = `# Brain State

**Created:** ${new Date().toISOString()}

## Summary
Fresh brain, ready to learn from your agent sessions.

## Next Steps
- Run agents (Claude Code, Cursor, Codex, etc.)
- Brain auto-saves on every session finish
- Optionally backfill past sessions to jump-start learning
`;
    fs.writeFileSync(stateFile, initialState);
  }
  const gi = path.join(brain, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.state/\n');
  // Version the brain from day one; one commit per harvest afterwards.
  if (!fs.existsSync(path.join(brain, '.git'))) {
    const git = (args) => spawnSync('git', ['-C', brain, '-c', 'user.name=coding-brain', '-c', 'user.email=coding-brain@local', ...args], { stdio: 'ignore' });
    git(['init', '-q']);
    git(['add', '-A']);
    git(['commit', '-qm', 'baseline: empty brain at init']);
  }
  return brain;
}

// -------------------------------------------------------------- lite STATE

function buildCorpus(brain, workspace, sessions, cfg) {
  const cap = cfg.liteStateCapChars || 600000;
  const perSession = cfg.liteStatePerSessionChars || 30000;

  // Budget = "everything from the last N days, but never fewer than M sessions".
  // A recency window alone starves a user who was away last week; a flat count
  // alone truncates a heavy week. Take whichever is larger. The char cap below
  // is the real backstop, so a busy fortnight can't blow up the one model call.
  const windowDays = cfg.liteStateWindowDays || 7;
  const minSessions = cfg.liteStateSessions || 30;
  const cutoff = Date.now() - windowDays * 86400 * 1000;
  const inWindow = sessions.filter((s) => s.mtime >= cutoff).length;
  const maxSessions = Math.max(inWindow, minSessions);

  // Selection = coverage + recency, in that order:
  //   Pass 1: ONE slot per project (its newest session) — every project gets
  //           seen exactly once, so a dormant project can never eat more
  //           than one slot (round-robin previously let a dormant project
  //           dominate once other queues ran dry).
  //   Pass 2: all remaining slots go to the globally newest sessions,
  //           regardless of project — the briefing is mostly about NOW.
  const picked = [];
  const seenProjects = new Set();
  for (const s of sessions) { // newest-first
    if (picked.length >= maxSessions) break;
    if (seenProjects.has(s.project)) continue;
    seenProjects.add(s.project);
    picked.push(s);
  }
  const pickedPaths = new Set(picked.map((s) => s.path));
  for (const s of sessions) {
    if (picked.length >= maxSessions) break;
    if (pickedPaths.has(s.path)) continue;
    picked.push(s);
    pickedPaths.add(s.path);
  }

  const stateDir = path.join(brain, '.state');
  const chunks = []; // newest-first budgeting
  let total = 0;
  for (const s of picked) {
    const out = path.join(stateDir, 'lite-' + path.basename(s.path, '.jsonl') + '.txt');
    const r = spawnSync('python3', [path.join(SCRIPTS, 'filter.py'), s.path, out,
      String(cfg.assistantCapChars || 2500), String(cfg.totalCapChars || 400000)], { stdio: 'ignore' });
    if (r.status !== 0) continue;
    let text = '';
    try { text = fs.readFileSync(out, 'utf8'); } catch { continue; }
    fs.rmSync(out, { force: true });
    if (!text.trim()) continue;
    if (text.length > perSession) {
      text = text.slice(0, perSession) + '\n[session slice capped]';
    }
    const header = `\n\n===== SESSION (${s.source}, project: ${s.project}, ${new Date(s.mtime).toISOString().slice(0, 10)}) =====\n\n`;
    if (total + text.length + header.length > cap) {
      const room = cap - total - header.length;
      if (room < 2000) break;
      text = text.slice(0, room) + '\n[corpus truncated at cap]';
    }
    chunks.push({ mtime: s.mtime, body: header + text });
    total += text.length;
    process.stdout.write(`  read ${s.project} · ${new Date(s.mtime).toISOString().slice(0, 10)} (${Math.round(text.length / 1024)}KB)\n`);
    if (total >= cap) break;
  }
  // Chronological order in the corpus (oldest first) so the newest facts win.
  chunks.sort((a, b) => a.mtime - b.mtime);
  const corpusPath = path.join(stateDir, 'coldstart-corpus.txt');
  fs.writeFileSync(corpusPath, chunks.map((c) => c.body).join(''));
  return { corpusPath, sessions: chunks.length, chars: total };
}

// ---------------------------------------------------------- fan-out compile
// Cold start as MANY single-turn calls, not one agentic loop. Measured basis:
// one agentic harvest averages $1.65 over 22 turns (27 receipts); the same
// digest work as a single turn with content inlined costs $0.20 (live receipt)
// - an 8x difference that decides whether cold start is ~$3 or ~$60. The
// orchestrator writes all files; the model only ever returns text.

let ENGINE_CACHE = null;
function resolveEngine() {
  if (ENGINE_CACHE) return ENGINE_CACHE;
  const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
  if (has('claude')) ENGINE_CACHE = { bin: 'claude', kind: 'claude' };
  else if (has('cursor-agent')) ENGINE_CACHE = { bin: 'cursor-agent', kind: 'cursor' };
  else if (has('agent')) ENGINE_CACHE = { bin: 'agent', kind: 'cursor' };
  else ENGINE_CACHE = null;
  return ENGINE_CACHE;
}

function claudeOnce(prompt, model) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const eng = resolveEngine();
    if (!eng) return resolve({ ok: false, err: 'no engine: install the Claude Code CLI or cursor-agent', ms: 0, cost: 0 });
    // Cursor's CLI: text out, its own model namespace, no cost reporting.
    const argv = eng.kind === 'cursor'
      ? ['-p', prompt, '--model', 'claude-sonnet-5-high', '--force', '--output-format', 'text']
      : ['-p', prompt, '--model', model, '--setting-sources', '', '--output-format', 'json'];
    const child = spawn(eng.bin, argv,
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODING_BRAIN_HARVEST: '1' } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      const ms = Date.now() - t0;
      if (code !== 0) return resolve({ ok: false, err: err.slice(0, 300), ms, cost: 0 });
      if (eng.kind === 'cursor') return resolve({ ok: true, text: out, cost: 0, ms });
      try {
        const d = JSON.parse(out);
        resolve({ ok: true, text: d.result || '', cost: d.total_cost_usd || 0, ms });
      } catch { resolve({ ok: false, err: 'unparseable output', ms, cost: 0 }); }
    });
  });
}

async function runPool(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}

// Model output -> files. Blocks are "FILE: <name>.md" then content. Filenames
// are sanitized to a bare .md basename - the model names files, it never picks
// paths.
function writeFileBlocks(dir, text) {
  const written = [];
  const parts = String(text).split(/^FILE:[ \t]*/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    const name = path.basename(part.slice(0, nl).trim());
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) continue;
    const body = part.slice(nl + 1).trim();
    if (!body) continue;
    // Atomic: a recall hook reading mid-compile must never see a half-file.
    const dst = path.join(dir, name);
    const tmp = dst + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, body + '\n');
    fs.renameSync(tmp, dst);
    written.push(name);
  }
  return written;
}

function instructionsSection(brain, startRe, endRe) {
  try {
    const t = fs.readFileSync(path.join(brain, 'INSTRUCTIONS.md'), 'utf8');
    const lines = t.split('\n');
    const a = lines.findIndex((l) => startRe.test(l));
    if (a < 0) return '';
    let b = lines.slice(a + 1).findIndex((l) => endRe.test(l));
    b = b < 0 ? lines.length : a + 1 + b;
    return lines.slice(a, b).join('\n');
  } catch { return ''; }
}

// The same advisory lock distill.sh uses (<brain>/.state/harvest.lock).
// init must both RESPECT it (never scaffold/compile over a mid-flight harvest -
// the documented Aug-8 wipe was exactly that) and HOLD it (so a stop-hook
// harvest firing mid-backfill queues behind us instead of interleaving).
function acquireBrainLock(brain, staleMinutes) {
  const lockDir = path.join(brain, '.state', 'harvest.lock');
  fs.mkdirSync(path.join(brain, '.state'), { recursive: true });
  const tryOnce = () => { try { fs.mkdirSync(lockDir); return true; } catch { return false; } };
  if (!tryOnce()) {
    let stale = false;
    try { stale = (Date.now() - fs.statSync(lockDir).mtimeMs) > staleMinutes * 60 * 1000; } catch { stale = true; }
    if (stale) { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* raced */ } }
    if (!tryOnce()) return null;
  }
  return () => { try { fs.rmdirSync(lockDir); } catch { /* already gone */ } };
}

async function fanoutCompile(brain, workspace, sessions, cfg) {
  const model = cfg.model || 'claude-sonnet-5';
  const clusterSize = cfg.fanoutClusterSize || 3;
  const maxClusters = cfg.fanoutMaxClusters || 50;
  const width = cfg.fanoutParallel || 4;
  const perSession = cfg.liteStatePerSessionChars || 30000;
  const stateDir = path.join(brain, '.state');
  const costLog = path.join(stateDir, 'cost.jsonl');
  const t0 = Date.now();
  let spent = 0;
  const logCost = (stage, r) => {
    spent += r.cost || 0;
    try { fs.appendFileSync(costLog, JSON.stringify({ stage, cost_usd: r.cost, ms: r.ms, ok: r.ok }) + '\n'); } catch { /* best-effort */ }
  };

  // Filter each session to condensed text (deterministic, free).
  const texts = [];
  for (const sess of sessions) {
    const out = path.join(stateDir, 'lite-' + path.basename(sess.path, '.jsonl') + '.txt');
    const r = spawnSync('python3', [path.join(SCRIPTS, 'filter.py'), sess.path, out,
      String(cfg.assistantCapChars || 2500), String(cfg.totalCapChars || 400000)], { stdio: 'ignore' });
    if (r.status !== 0) continue;
    let t = '';
    try { t = fs.readFileSync(out, 'utf8'); } catch { continue; }
    fs.rmSync(out, { force: true });
    if (!t.trim()) continue;
    if (t.length > perSession) t = t.slice(0, perSession) + '\n[capped]';
    texts.push({ sess, t });
  }
  if (!texts.length) return { digests: 0, topics: 0, cost: 0, secs: 0, err: 'no usable content' };

  // Cluster newest-first in groups of clusterSize, hard-capped. The cap is the
  // cost ceiling: maxClusters * (one single-turn call) regardless of workspace size.
  const clusters = [];
  for (let i = 0; i < texts.length && clusters.length < maxClusters; i += clusterSize) {
    clusters.push(texts.slice(i, i + clusterSize));
  }
  const dropped = texts.length - clusters.reduce((n, c) => n + c.length, 0);
  console.log(`Compiling ${texts.length - dropped} session(s) in ${clusters.length} call(s), ${width}-way parallel${dropped > 0 ? ` (${dropped} oldest dropped by the ${maxClusters}-cluster cap)` : ''}...`);

  const digestFmt = instructionsSection(brain, /^## Step 1:/, /^## Step 1\.5/);
  let done = 0;
  const digestResults = await runPool(clusters, width, async (cluster) => {
    const corpus = cluster.map((c, i) =>
      `===== SESSION ${i + 1} (${c.sess.source}, project: ${c.sess.project}, ${new Date(c.sess.mtime).toISOString().slice(0, 10)}) =====\n${c.t}`).join('\n\n');
    const prompt = `[coding-brain:meta]\nYou are compiling session digests for a coding workspace's memory. Below are ${cluster.length} condensed session transcripts. Write one digest per session - EXCEPT sessions sharing the same date and project, which merge into one digest.\n\nFormat and rules:\n${digestFmt}\n\nStart each digest with a line exactly like:\nFILE: YYYY-MM-DD-<2-4-word-slug>.md\n(date = that session's date from its header). Never store secrets or tokens. Do not attempt to use any tools - reply with the digests as plain text only.\n\nTRANSCRIPTS:\n\n${corpus}`;
    const r = await claudeOnce(prompt, model);
    logCost('digest', r);
    done++;
    process.stdout.write(`  digest call ${done}/${clusters.length}${r.ok ? '' : ' FAILED'}\n`);
    return r;
  });
  let digestCount = 0;
  for (const r of digestResults) {
    if (r && r.ok) digestCount += writeFileBlocks(path.join(brain, 'sessions'), r.text).length;
  }
  if (!digestCount) return { digests: 0, topics: 0, cost: spent, secs: (Date.now() - t0) / 1000, err: 'no digests produced' };

  // Topics: one call over all digests (they are compact). The model groups by
  // project itself - transcript cwd is a bad proxy for project in practice.
  const digestFiles = fs.readdirSync(path.join(brain, 'sessions')).filter((f) => f.endsWith('.md'));
  let digestBlob = digestFiles.map((f) => `----- ${f} -----\n` + fs.readFileSync(path.join(brain, 'sessions', f), 'utf8')).join('\n');
  if (digestBlob.length > 350000) digestBlob = digestBlob.slice(0, 350000) + '\n[capped]';
  const topicFmt = instructionsSection(brain, /^## Step 1\.5/, /^## Step 2/);
  console.log('Compiling topic notes...');
  const tr = await claudeOnce(`[coding-brain:meta]\nBelow are all session digests for one workspace. Group them into project/topic notes - the compiled current truth per project, per the format:\n${topicFmt}\n\nStart each topic note with a line exactly like:\nFILE: <project-slug>.md\nNewest digests win when they conflict. Never store secrets. Do not attempt to use tools - plain text only.\n\nDIGESTS:\n\n${digestBlob}`, model);
  logCost('topics', tr);
  let topicCount = 0;
  if (tr.ok) topicCount = writeFileBlocks(path.join(brain, 'topics'), tr.text).length;

  // STATE last, from topics + digest titles, observations-not-conclusions.
  const stateFmt = instructionsSection(brain, /^## Step 3/, /^## Step 4/);
  let topicBlob = '';
  try {
    topicBlob = fs.readdirSync(path.join(brain, 'topics')).filter((f) => f.endsWith('.md'))
      .map((f) => `----- topics/${f} -----\n` + fs.readFileSync(path.join(brain, 'topics', f), 'utf8')).join('\n');
  } catch { /* none */ }
  if (topicBlob.length > 250000) topicBlob = topicBlob.slice(0, 250000) + '\n[capped]';
  console.log('Compiling STATE...');
  const sr = await claudeOnce(`[coding-brain:meta]\nWrite the workspace STATE file - a ~100-line current-truth dashboard - from the topic notes below, per the format:\n${stateFmt}\n\nOrder Active projects newest-activity-first. Record observations with their evidence and date, never interpretive conclusions. Never store secrets. Reply with ONLY the STATE file content - no FILE: header, no tools.\n\nTOPIC NOTES:\n\n${topicBlob}\n\nDIGEST LIST: ${digestFiles.join(', ')}`, model);
  logCost('state', sr);
  if (sr.ok && sr.text.trim()) {
    const dst = path.join(brain, 'STATE.md');
    const tmp = dst + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, sr.text.trim() + '\n');
    fs.renameSync(tmp, dst);
  }

  return { digests: digestCount, topics: topicCount, cost: spent, secs: (Date.now() - t0) / 1000 };
}

function runLiteState(brain, workspace, corpusPath, nSessions) {
  const cfg = readJsonSoft(path.join(brain, 'config.json'), {});
  const model = cfg.model || 'claude-sonnet-5';
  const prompt = `You are initializing a coding brain — a compiled memory for this workspace.

You are given a corpus of the ${nSessions} most recent coding-agent sessions in this workspace (pre-condensed to user messages, assistant text, and tool targets; newest session LAST — when sessions conflict, the newest wins). Read it at: ${corpusPath}

Each session in the corpus is delimited by a line of the form:
  ===== SESSION (<source>, project: <project>, YYYY-MM-DD) =====

Read ${path.join(brain, 'INSTRUCTIONS.md')} first — it defines the privacy rules and the exact format for all three file types. Then build the FULL brain, in this order:

1. SESSION DIGESTS (INSTRUCTIONS.md Step 1) — write to ${path.join(brain, 'sessions')}/YYYY-MM-DD-<short-slug>.md
   One digest per session block in the corpus, dated by that block's date.
   EXCEPTION: if several blocks share the same date AND project, merge them into a single digest for that day — don't emit near-duplicate files.
   Skip a block entirely if it has no durable content (trivial one-off questions, no decisions, nothing shipped). A skipped session is better than a padded digest.

2. TOPIC NOTES (INSTRUCTIONS.md Step 1.5) — write to ${path.join(brain, 'topics')}/<project>.md
   One rolling note per project that appears in the corpus, compiled across ALL of that project's sessions (not per-session). This is the layer future sessions actually read — spend your effort here.

3. STATE.md (INSTRUCTIONS.md Step 3) — write to ${path.join(brain, 'STATE.md')}
   Write this LAST, so it summarizes what you just compiled.
   A ~100-line current-truth dashboard: Active projects, Conventions, Open threads.
   ORDER BY RECENCY: Active projects newest-activity-first; the most recently worked project comes first and gets the most detail. A project whose sessions are all noticeably older than the rest (roughly 3+ weeks stale) is NOT active — give it a single line under a "Dormant" heading, no matter how much corpus text it has. Corpus volume is a sampling artifact, not importance.

Rules that apply to every file:
- Compile, don't narrate. Facts and decisions only; date facts that can go stale.
- The corpus is historical: prefer the newest session's version of any fact; mark anything you cannot confirm as "unverified:" or "as of <date>".
- Never store secrets/keys/tokens; reference env var names only.
- Write only inside ${brain}. Do not touch anything else, then stop.`;
  // `< /dev/null` equivalent: stdin ignored — claude -p eats inherited stdin.
  const r = spawnSync('claude', ['-p', prompt,
    '--model', model,
    '--setting-sources', '',
    '--allowedTools', `Read(/${workspace}/**),Write(/${brain}/**),Edit(/${brain}/**),Grep,Glob`,
    '--output-format', 'json',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODING_BRAIN_HARVEST: '1', BRAIN_DIR: brain }, encoding: 'utf8' });
  if (r.error) return { ok: false, err: String(r.error.message || r.error) };
  if (r.status !== 0) return { ok: false, err: `claude exited ${r.status}: ${(r.stderr || '').slice(0, 400)}` };
  return { ok: true };
}

// -------------------------------------------------------------------- init

async function cmdInit(args) {
  const workspace = process.cwd();
  const yes = args.includes('--yes') || args.includes('-y');
  const dryRun = args.includes('--dry-run');
  const hooksOnly = args.includes('--hooks-only');
  // For hosts that drive harvests themselves (e.g. the herdr plugin, which fires
  // on herdr's own agent events). Scaffolds the brain without touching the user's
  // editor config, so the host stays the single trigger.
  const noHooks = args.includes('--no-hooks');
  const withCursor = args.includes('--cursor');
  const withCodex = args.includes('--codex');

  console.log(`coding-brain init — workspace: ${workspace}\n`);

  // a. Inventory (free, no LLM)
  let sessions = inventory(workspace);
  const projects = new Set(sessions.map((s) => s.project));
  if (sessions.length) {
    console.log(`Found ${sessions.length} past session(s) across ${projects.size} project(s), newest ${ago(Date.now() - sessions[0].mtime)}.`);
  } else {
    console.log('No past transcripts found for this workspace (fresh start — the brain will grow from your next sessions).');
  }

  // b. Consent gate
  let compile = sessions.length > 0 && !hooksOnly;
  if (compile && !yes) {
    const a = (await ask('Compile a starter brain from these? [Y/n/l=list projects] ', 'y')).toLowerCase();
    if (a === 'n' || a === 'no') compile = false;
    else if (a === 'l' || a === 'list') {
      const groups = [...projects];
      groups.forEach((p, i) => {
        const n = sessions.filter((s) => s.project === p).length;
        console.log(`  [${i + 1}] ${p === '.' ? '(workspace root)' : p} — ${n} session(s)`);
      });
      const ex = await ask('Exclude any? (comma-separated numbers, empty = none) ', '');
      const excluded = new Set(ex.split(',').map((s) => groups[parseInt(s.trim(), 10) - 1]).filter(Boolean));
      if (excluded.size) sessions = sessions.filter((s) => !excluded.has(s.project));
      const a2 = (await ask(`Compile from the remaining ${sessions.length} session(s)? [Y/n] `, 'y')).toLowerCase();
      if (a2 === 'n' || a2 === 'no') compile = false;
    }
  }

  // Never scaffold or compile over a mid-flight harvest: the lock check must
  // come BEFORE scaffoldBrain touches anything in an existing brain.
  const preLock = path.join(workspace, '.coding-brain', '.state', 'harvest.lock');
  if (fs.existsSync(preLock)) {
    let fresh = true;
    try { fresh = (Date.now() - fs.statSync(preLock).mtimeMs) < 30 * 60 * 1000; } catch { fresh = false; }
    if (fresh) die('a harvest is in progress on this brain (found .state/harvest.lock) - retry in a minute');
  }
  // Brain scaffold (needed for hooks either way).
  const brain = scaffoldBrain(workspace);
  console.log(`Brain: ${brain}`);
  const releaseLock = acquireBrainLock(brain, 30);
  if (!releaseLock) die('a harvest grabbed this brain first - retry in a minute');
  process.on('exit', releaseLock);

  // c. Lite STATE — ONE model call over the most recent sessions.
  if (compile && sessions.length) {
    const cfg = readJsonSoft(path.join(brain, 'config.json'), {});
    // Selection: recency window ∪ per-project floor ∪ global floor.
    // The window alone fails "where did I leave X" questions - X is often 2-3
    // weeks old (measured: the iris export, shipped 14 days back, fell outside
    // a 7-day window and the brain could only punt). So every project also
    // contributes its newest K sessions regardless of age.
    const windowDays = cfg.liteStateWindowDays || 7;
    const minSessions = cfg.liteStateSessions || 30;
    const projectFloor = cfg.fanoutProjectFloor || 3;
    const cutoff = Date.now() - windowDays * 86400 * 1000;
    const chosen = new Set();
    sessions.forEach((x, i) => { if (x.mtime >= cutoff) chosen.add(i); });
    const perProj = {};
    sessions.forEach((x, i) => {
      perProj[x.project] = (perProj[x.project] || 0);
      if (perProj[x.project] < projectFloor) { chosen.add(i); perProj[x.project]++; }
    });
    for (let i = 0; i < sessions.length && chosen.size < minSessions; i++) chosen.add(i);
    const selected = sessions.filter((_, i) => chosen.has(i));
    const n = selected.length;
    if (n === 0) {
      console.log('No usable transcript content after filtering — skipping the starter briefing.');
    } else {
      console.log(`Compiling your brain from ${n} session(s) - digests, topic notes, and the briefing...`);
      const res = await fanoutCompile(brain, workspace, selected, cfg);
      if (res.digests > 0 && fs.existsSync(path.join(brain, 'STATE.md'))) {
        spawnSync('git', ['-C', brain, 'add', '-A'], { stdio: 'ignore' });
        spawnSync('git', ['-C', brain, '-c', 'user.name=coding-brain', '-c', 'user.email=coding-brain@local',
          'commit', '-qm', `init: brain compiled from ${n} sessions`], { stdio: 'ignore' });
        const costNote = res.cost > 0.005 ? ` · ~$${res.cost.toFixed(2)} of model time` : '';
        console.log(`\nBrain compiled: ${res.digests} session digest(s), ${res.topics} topic note(s) in ${Math.round(res.secs)}s${costNote}.`);
        console.log('\n===== Your starter briefing =====\n');
        console.log(fs.readFileSync(path.join(brain, 'STATE.md'), 'utf8'));
        console.log('=================================\n');
      } else {
        console.log(`Starter compile failed (${res.err || 'nothing was written'}) — continuing with hooks-only install. Run \`npx coding-brain harvest\` later to retry.`);
      }
    }
  } else if (!compile) {
    console.log('Skipping starter compile — brain starts empty and grows from your next sessions.');
  }

  releaseLock();

  // d. Hook install (idempotent).
  if (noHooks) {
    console.log('Skipped hook install (--no-hooks) — whatever installed this drives the saving.');
  } else {
  installClaudeHooks({ dryRun });
  if (fs.existsSync(CURSOR_DIR)) {
    let doCursor = withCursor;
    if (!doCursor && !yes) {
      const a = (await ask('Cursor detected — also install Cursor project hooks for this workspace? [y/N] ', 'n')).toLowerCase();
      doCursor = a === 'y' || a === 'yes';
    }
    if (doCursor) installCursorHooks(workspace, { dryRun });
    else console.log('Skipped Cursor hooks (rerun with --cursor to add them).');
  }
  if (fs.existsSync(CODEX_DIR)) {
    let doCodex = withCodex;
    if (!doCodex && !yes) {
      const a = (await ask('Codex detected — also enable Codex support (notify hook + AGENTS.md block)? [y/N] ', 'n')).toLowerCase();
      doCodex = a === 'y' || a === 'yes';
    }
    if (doCodex) installCodex(workspace, brain, { dryRun });
    else console.log('Skipped Codex support (rerun with --codex to add it).');
  }
  }

  // e. Closing line.
  console.log('\nDone. Your next session in this workspace starts already knowing this —');
  console.log('after every session it quietly updates what it knows (in the background).');
  console.log('Check anytime: npx coding-brain status | npx coding-brain search <words> | npx coding-brain log');

  // f. Post-install viewer — the install ends on a visual, not terminal text.
  // Detached so init can exit; killed by `uninstall`, gone on reboot, and
  // `coding-brain ui` reopens it any time. Suppressed when non-interactive.
  const noUi = args.includes('--no-ui') || process.env.CODING_BRAIN_NO_UI === '1'
    || dryRun || !process.stdout.isTTY;
  if (!noUi) {
    try {
      const uiCfg = readJsonSoft(path.join(brain, 'config.json'), {});
      const port = await findFreePort(uiCfg.uiPort || 4180);
      if (port) {
        const child = spawn('python3', [path.join(SCRIPTS, 'ui.py'), brain, '--port', String(port)],
          { detached: true, stdio: 'ignore' });
        child.unref();
        fs.writeFileSync(path.join(brain, '.state', 'ui.pid'), String(child.pid));
        const url = `http://127.0.0.1:${port}`;
        console.log(`\nViewer: ${url} (\`npx coding-brain ui\` to reopen later)`);
        // Give the server a beat to bind before the browser hits it.
        setTimeout(() => openBrowser(url), 700);
      }
    } catch { /* the viewer is a nicety — never fail init over it */ }
  }
}

// ------------------------------------------------------------------ status

function cmdStatus() {
  const brain = findBrain(process.cwd());
  if (!brain) die('no .coding-brain found (run `npx coding-brain init` in your workspace root)');
  console.log(`Brain: ${brain}`);
  const stateDir = path.join(brain, '.state');
  let ts = 0;
  try { ts = parseInt(fs.readFileSync(path.join(stateDir, 'last_success'), 'utf8').trim(), 10) * 1000 || 0; } catch { /* none yet */ }
  console.log(`Last harvest: ${ts ? ago(Date.now() - ts) : 'never'}`);
  if (fs.existsSync(path.join(stateDir, 'last_failure'))) {
    console.log('WARNING: last harvest FAILED — see .coding-brain/.state/harvest.log');
  }
  const digests = countFiles(path.join(brain, 'sessions'), '.md');
  const topics = countFiles(path.join(brain, 'topics'), '.md');
  let harvested = 0;
  try { harvested = fs.readdirSync(stateDir).filter((f) => /^([0-9a-f-]{36}|rollout-[^.]+)$/.test(f)).length; } catch { /* no state */ }
  console.log(`Digests: ${digests} · Topics: ${topics} · Sessions harvested: ${harvested}`);
  console.log(`STATE.md: ${fs.existsSync(path.join(brain, 'STATE.md')) ? 'present' : 'missing (first harvest will create it)'}`);
  const r = spawnSync('git', ['-C', brain, 'log', '--oneline', '-5'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) {
    console.log('\nLast 5 brain commits:');
    console.log(r.stdout.trim().split('\n').map((l) => '  ' + l).join('\n'));
  }
}

// ---------------------------------------------------------- search/log/etc

function cmdSearch(args) {
  const brain = findBrain(process.cwd());
  if (!brain) die('no .coding-brain found');
  if (!args.length) die('usage: npx coding-brain search <words...>');
  const r = spawnSync('bash', [path.join(SCRIPTS, 'search.sh'), ...args],
    { stdio: 'inherit', env: { ...process.env, BRAIN_DIR: brain } });
  process.exit(r.status || 0);
}

function cmdLog() {
  const brain = findBrain(process.cwd());
  if (!brain) die('no .coding-brain found');
  const r = spawnSync('git', ['-C', brain, 'log', '--oneline', '-20'], { stdio: 'inherit' });
  process.exit(r.status || 0);
}

function cmdConsolidate() {
  const brain = findBrain(process.cwd());
  if (!brain) die('no .coding-brain found (run `npx coding-brain init` first)');
  const workspace = path.dirname(brain);
  console.log('Consolidating old digests (month+project groups older than 30 days)...');
  const r = spawnSync('bash', [path.join(SCRIPTS, 'distill.sh'), '--consolidate', workspace],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, BRAIN_DIR: brain } });
  if (r.status === 0) {
    const g = spawnSync('git', ['-C', brain, 'log', '--oneline', '-3'], { encoding: 'utf8' });
    console.log('Done. Recent brain commits:\n' + (g.stdout || '').trim());
  } else die('consolidation failed - see .coding-brain/.state/harvest.log');
}

function cmdHarvest() {
  const brain = findBrain(process.cwd());
  if (!brain) die('no .coding-brain found (run `npx coding-brain init` first)');
  const workspace = path.dirname(brain);
  const stateDir = path.join(brain, '.state');
  const sessions = inventory(workspace);
  if (!sessions.length) die('no transcripts found for this workspace');
  // Newest transcript with unharvested content (size beyond its offset).
  let target = null;
  for (const s of sessions) {
    const stem = path.basename(s.path, '.jsonl');
    let offset = 0;
    try { offset = parseInt(fs.readFileSync(path.join(stateDir, stem), 'utf8').trim(), 10) || 0; } catch { /* never harvested */ }
    let size = 0;
    try { size = fs.statSync(s.path).size; } catch { continue; }
    if (size > offset) { target = s; break; }
  }
  if (!target) { console.log('Nothing to harvest — all transcripts already harvested.'); return; }
  console.log(`Harvesting ${path.basename(target.path)} (${target.source}, project: ${target.project})...`);
  const r = spawnSync('bash', [path.join(SCRIPTS, 'distill.sh'), target.path, workspace],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, BRAIN_DIR: brain } });
  if (r.status === 0) {
    console.log('Harvest complete.');
    const g = spawnSync('git', ['-C', brain, 'log', '--oneline', '-1'], { encoding: 'utf8' });
    if (g.stdout) console.log('Latest brain commit: ' + g.stdout.trim());
  } else {
    die(`harvest failed (exit ${r.status}) — see ${path.join(stateDir, 'harvest.log')}`);
  }
}

function cmdUninstall(args) {
  const dryRun = args.includes('--dry-run');
  uninstallClaudeHooks({ dryRun });
  const brain = findBrain(process.cwd());
  const workspace = brain ? path.dirname(brain) : process.cwd();
  uninstallCursorHooks(workspace, { dryRun });
  uninstallCodex(workspace, { dryRun });
  if (brain) stopUi(brain, { dryRun });
  if (brain) console.log(`Brain left untouched at ${brain} — delete it yourself if you want it gone.`);
}

function stopUi(brain, opts) {
  const pidFile = path.join(brain, '.state', 'ui.pid');
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) || 0; } catch { return; }
  if (opts.dryRun) { console.log(`[dry-run] would stop viewer pid ${pid}`); return; }
  if (pid > 0) {
    try { process.kill(pid, 'SIGTERM'); console.log(`Stopped viewer (pid ${pid}).`); }
    catch { /* already gone */ }
  }
  fs.rmSync(pidFile, { force: true });
}

// ---------------------------------------------------------------------- ui

async function cmdUi(args) {
  const brain = findBrain(process.cwd());
  if (!brain) die('no .coding-brain found here — run `npx coding-brain init` in your workspace first, then `npx coding-brain ui`');
  const cfg = readJsonSoft(path.join(brain, 'config.json'), {});
  const port = await findFreePort(cfg.uiPort || 4180);
  const url = port ? `http://127.0.0.1:${port}` : null;
  if (url) console.log(`Viewer: ${url} — Ctrl-C to stop (it only runs while you're looking at it).`);
  if (url && !args.includes('--no-open')) setTimeout(() => openBrowser(url), 700);
  // Foreground on purpose: no daemon, no LaunchAgent, nothing resident.
  const child = spawn('python3', [path.join(SCRIPTS, 'ui.py'), brain, '--port', String(port)],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  const code = await new Promise((res) => child.on('exit', res));
  process.exit(code || 0);
}

// ---------------------------------------------------------------------- ab
// Does the brain actually help? Run one question twice — once blind, once with
// the brain injected — with the SAME model and the SAME tools, so the injected
// context is the only variable.
//
// Both sides get read access to the workspace on purpose. The honest question
// isn't "does context beat nothing", it's "does context beat just reading the
// repo" — an agent that can grep its way to the answer doesn't need a brain.

function runProbe(question, context, workspace, model, allowTools, brainDir, strict) {
  // Self-tag so inventory() can exclude probe transcripts from future corpora.
  question = '[coding-brain:meta]\n' + question;
  const prompt = context
    ? `${context}\n\n---\n\n${question}`
    : question;
  const argv = ['-p', prompt, '--model', model, '--setting-sources', '', '--output-format', 'json'];
  if (allowTools) {
    argv.push('--allowedTools', `Read(/${workspace}/**),Grep,Glob,Bash(git *),Bash(ls *)`);
    // The blind run must not reach the brain on disk. Without this it simply
    // greps .coding-brain/ and answers from the same notes the other side was
    // handed — which measures injection-vs-retrieval, not brain-vs-no-brain.
    // Caught this the first time the command ran: side A cited "the brain notes".
    // Harness v3: brain DIRS are physically hidden by the caller during both
    // probes - Read denies could not stop Bash `cat` (measured: brain content
    // in 4/10 "blind" answers in run 2). What remains is only the strict-mode
    // deny on hand-written notes files; Bash can still cat those two, a known
    // residual flagged in reports.
    const deny = [];
    if (brainDir) {
      deny.push(`Read(${brainDir}/**)`,
        `Read(${path.join(workspace, '.cursor')}/**)`,
        `Read(${path.join(workspace, '.claude')}/**)`);
    }
    if (strict) deny.push('Read(**/CLAUDE.md)', 'Read(**/AGENTS.md)');
    if (deny.length) argv.push('--disallowedTools', deny.join(','));
  }
  const started = Date.now();
  const r = spawnSync('claude', argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // CODING_BRAIN_HARVEST stops this probe's own hooks from injecting or
    // harvesting — otherwise the blind run isn't blind.
    env: { ...process.env, CODING_BRAIN_HARVEST: '1' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  if (r.error) return { ok: false, err: String(r.error.message || r.error), ms };
  if (r.status !== 0) return { ok: false, err: (r.stderr || '').slice(0, 300), ms };
  try {
    const d = JSON.parse(r.stdout);
    return { ok: true, text: d.result || '', turns: d.num_turns, cost: d.total_cost_usd, ms };
  } catch {
    return { ok: true, text: (r.stdout || '').trim(), ms };
  }
}

function cmdAb(args) {
  const flags = args.filter((a) => a.startsWith('--'));
  const question = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!question) die('usage: npx coding-brain ab "<question>" [--strict] [--no-tools] [--model <m>]');

  const bi = args.indexOf('--brain');
  const brain = bi >= 0 ? path.resolve(args[bi + 1]) : findBrain(process.cwd());
  if (!brain || !fs.existsSync(brain)) die('no brain found (run `npx coding-brain init`, or pass --brain <path>)');
  const workspace = bi >= 0 ? process.cwd() : path.dirname(brain);
  const cfg = readJsonSoft(path.join(brain, 'config.json'), {});
  const mi = flags.indexOf('--model');
  const model = mi >= 0 ? args[args.indexOf('--model') + 1] : (cfg.model || 'claude-sonnet-5');
  const allowTools = !flags.includes('--no-tools');
  const strict = flags.includes('--strict');

  // Capture exactly what a real session would be given: run the recall hook
  // with a throwaway session id so it emits the full dump, not a follow-up.
  const hook = spawnSync('bash', [path.join(SCRIPTS, 'recall-hook.sh')], {
    input: JSON.stringify({ session_id: 'ab-probe-' + process.pid, cwd: workspace, prompt: question }),
    encoding: 'utf8',
    env: { ...process.env, CODING_BRAIN_DIR: brain },
  });
  const context = (hook.stdout || '').trim();
  if (!context) die('the recall hook produced nothing — is STATE.md present?');

  console.log(`Question: ${question}`);
  console.log(`Model: ${model} · tools: ${allowTools ? (strict ? 'source only for A (all notes denied)' : 'repo for A, brain dirs denied') : 'none'}`);
  console.log(`Injected context: ${context.length.toLocaleString()} chars\n`);

  console.log('Running A (blind) and B (with brain)...\n');
  // Side A is denied the brain on disk; side B gets it injected. Same model,
  // same everything else.
  const hidden = hideBrains(workspace, brain);
  let a, b;
  try {
    a = runProbe(question, null,    workspace, model, allowTools, null, strict);
    b = runProbe(question, context, workspace, model, allowTools, null, strict);
  } finally {
    restoreBrains(hidden);
  }

  const show = (label, r) => {
    console.log('='.repeat(72));
    console.log(label);
    console.log('='.repeat(72));
    console.log(r.ok ? r.text : `FAILED: ${r.err}`);
    const bits = [`${(r.ms / 1000).toFixed(1)}s`];
    if (r.turns != null) bits.push(`${r.turns} turns`);
    if (r.cost != null) bits.push(`$${Number(r.cost).toFixed(4)}`);
    console.log(`\n[${bits.join(' · ')}]\n`);
  };
  show('A — BLIND (no brain)', a);
  show('B — WITH BRAIN', b);

  console.log('='.repeat(72));
  console.log('Judge it on these, in order:');
  console.log('  1. Did B state anything true that A got wrong or missed entirely?');
  console.log('  2. Did B state anything FALSE that A did not? (stale brain is worse than no brain)');
  console.log('  3. Did A get there anyway by reading the repo — just slower?');
  console.log('If only 3 applies, the brain saved time, not correctness. That is a weaker claim.');
}

// -------------------------------------------------------------------- eval
// A/B across a whole question set, with a blind judge.
//
// One comparison tells you nothing — Sonnet is non-deterministic and a single
// question can favour either side by luck. This runs the set, randomises which
// answer the judge sees first (position bias is real and large), and reports
// per-category results, because the interesting finding is never "the brain is
// good/bad" — it's "the brain helps on X and hurts on Y".

const EVAL_SEED = {
  questions: [
    { q: 'The export file is not getting generated. Where do I start looking?', kind: 'debug' },
    { q: 'What version of coding-brain is live on npm, and is local ahead of it?', kind: 'status' },
    { q: 'How do I publish the coding-brain npm package without it silently failing?', kind: 'procedure' },
    { q: 'Where does the app get deployed, and what breaks if I deploy the obvious way?', kind: 'procedure' },
    { q: 'What is still unfinished on the newest feature?', kind: 'status' },
    { q: 'How should I add a new page to the app?', kind: 'architecture' },
  ],
};

// Physically remove the memory systems from disk for the duration of a probe
// pair. Rename-in-place (same parent) so restore is atomic; if a live hook
// recreated a dir while hidden, that recreation is a fresh scaffold - discard
// it and restore the original.
function hideBrains(workspace, brain) {
  const targets = [brain,
    path.join(workspace, '.cursor', 'brain'),
    path.join(workspace, '.claude', 'brain')];
  const hidden = [];
  for (const t of targets) {
    if (!t || !fs.existsSync(t)) continue;
    const away = t + '.eval-hidden-' + process.pid;
    fs.renameSync(t, away);
    hidden.push([t, away]);
  }
  return hidden;
}
function restoreBrains(hidden) {
  for (const [orig, away] of hidden) {
    try {
      if (fs.existsSync(orig)) fs.rmSync(orig, { recursive: true, force: true });
      fs.renameSync(away, orig);
    } catch (e) {
      console.error(`RESTORE FAILED for ${orig} - recover manually from ${away}: ${e.message}`);
    }
  }
}

function judge(question, ans1, ans2, model) {
  const prompt = `[coding-brain:meta]\nYou are grading two answers to the same question from an engineer's workspace. You do NOT have access to the workspace, so do not guess at ground truth — grade what you can actually assess.

QUESTION:
${question}

RESPONSE 1:
${ans1}

RESPONSE 2:
${ans2}

Grade on:
- responsive: does it answer the question ACTUALLY ASKED? Watch for an answer that is competent but quietly addresses a slightly different question.
- specific: concrete paths, commands, names — versus generic advice that would fit any codebase.
- honest: does it distinguish what it verified from what it is assuming? Unmarked confident claims are a defect, not a strength.

Reply with ONLY a JSON object, no prose:
{"winner": 1 | 2 | 0, "responsive": 1 | 2 | 0, "specific": 1 | 2 | 0, "honest": 1 | 2 | 0, "why": "<one sentence>", "wrong_frame": 1 | 2 | 0}
0 means tie. "wrong_frame" flags a response that answered a subtly different question than the one asked (0 if neither did).`;
  const r = spawnSync('claude', ['-p', prompt, '--model', model, '--setting-sources', '', '--output-format', 'json'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CODING_BRAIN_HARVEST: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    const text = JSON.parse(r.stdout).result || '';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

function cmdEval(args) {
  const flags = args.filter((a) => a.startsWith('--'));
  const bi = args.indexOf('--brain');
  const brain = bi >= 0 ? path.resolve(args[bi + 1]) : findBrain(process.cwd());
  if (!brain || !fs.existsSync(brain)) die('no brain found (run `npx coding-brain init`, or pass --brain <path>)');
  const workspace = bi >= 0 ? process.cwd() : path.dirname(brain);
  const cfg = readJsonSoft(path.join(brain, 'config.json'), {});
  const model = cfg.model || 'claude-sonnet-5';
  const strict = flags.includes('--strict');

  // The question set belongs to the WORKSPACE, not to whichever brain is under
  // test — otherwise --brain silently swaps the questions too and you compare
  // two brains on two different sets, which is worse than not measuring at all.
  const si = args.indexOf('--set');
  const wsBrain = findBrain(process.cwd());
  const setPath = si >= 0 ? path.resolve(args[si + 1])
    : path.join(wsBrain || brain, 'evals.json');
  if (!fs.existsSync(setPath)) {
    writeJsonAtomic(setPath, EVAL_SEED);
    console.log(`Seeded ${setPath} — edit it to match the questions you actually ask, then re-run.\n`);
  }
  const set = readJsonSoft(setPath, EVAL_SEED).questions || [];
  if (!set.length) die(`no questions in ${setPath}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(brain, '.state', 'evals', stamp);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Running ${set.length} question(s) · model ${model} · strict=${strict}`);
  console.log(`Transcripts: ${outDir}\n`);

  const rows = [];
  set.forEach((item, i) => {
    const q = item.q;
    process.stdout.write(`[${i + 1}/${set.length}] ${item.kind || '-'} · ${q.slice(0, 58)}...\n`);

    const hook = spawnSync('bash', [path.join(SCRIPTS, 'recall-hook.sh')], {
      input: JSON.stringify({ session_id: `eval-${stamp}-${i}`, cwd: workspace, prompt: q }),
      encoding: 'utf8',
      env: { ...process.env, CODING_BRAIN_DIR: brain },
    });
    const context = (hook.stdout || '').trim();

    const hidden = hideBrains(workspace, brain);
    let a, b;
    try {
      a = runProbe(q, null, workspace, model, true, null, strict);
      b = runProbe(q, context, workspace, model, true, null, strict);
    } finally {
      restoreBrains(hidden);
    }

    // Randomise presentation order — an LLM judge shown the same side first
    // every time will drift toward it regardless of content.
    const bFirst = Math.random() < 0.5;
    const v = judge(q, bFirst ? (b.text || '') : (a.text || ''), bFirst ? (a.text || '') : (b.text || ''), model);
    const decode = (n) => (n === 0 || n == null ? '-' : ((n === 1) === bFirst ? 'brain' : 'blind'));

    fs.writeFileSync(path.join(outDir, `q${i + 1}.md`),
      `# ${q}\n\nkind: ${item.kind}\nbFirst: ${bFirst}\n\n## A (blind) [${a.turns} turns, ${(a.ms / 1000).toFixed(1)}s]\n\n${a.text || a.err}\n\n## B (brain) [${b.turns} turns, ${(b.ms / 1000).toFixed(1)}s]\n\n${b.text || b.err}\n\n## Judge\n\n${JSON.stringify(v, null, 2)}\n`);

    rows.push({
      kind: item.kind || '-',
      winner: decode(v && v.winner),
      responsive: decode(v && v.responsive),
      wrongFrame: decode(v && v.wrong_frame),
      aTurns: a.turns, bTurns: b.turns,
      aMs: a.ms, bMs: b.ms,
      why: (v && v.why) || '',
    });
  });

  console.log('\n' + '='.repeat(78));
  console.log('kind          winner   responsive  wrong-frame   turns b/a     time b/a');
  console.log('-'.repeat(78));
  for (const r of rows) {
    console.log(
      `${r.kind.padEnd(13)} ${String(r.winner).padEnd(8)} ${String(r.responsive).padEnd(11)} ` +
      `${String(r.wrongFrame).padEnd(13)} ${String(r.bTurns ?? '?')}/${r.aTurns ?? '?'}`.padEnd(66 - 52 + 14) +
      `  ${(r.bMs / 1000).toFixed(0)}s/${(r.aMs / 1000).toFixed(0)}s`);
  }
  console.log('='.repeat(78));

  const tally = (k, v) => rows.filter((r) => r[k] === v).length;
  console.log(`\nwins        brain ${tally('winner', 'brain')} · blind ${tally('winner', 'blind')} · tie ${tally('winner', '-')}`);
  console.log(`wrong frame brain ${tally('wrongFrame', 'brain')} · blind ${tally('wrongFrame', 'blind')}`);
  const byKind = [...new Set(rows.map((r) => r.kind))];
  for (const k of byKind) {
    const sub = rows.filter((r) => r.kind === k);
    console.log(`  ${k.padEnd(13)} brain ${sub.filter((r) => r.winner === 'brain').length}/${sub.length}`);
  }
  console.log(`\nThe judge grades responsiveness and honesty, NOT ground truth — it cannot`);
  console.log(`see your workspace. Read ${outDir} before trusting any row.`);
}

// -------------------------------------------------------------------- main

const USAGE = `coding-brain — a compiled brain for Claude Code, Cursor & Codex

Usage: npx coding-brain <command>

  init        Scan past transcripts, compile a starter STATE (with consent),
              and install session hooks. Flags: --yes --dry-run --hooks-only --no-hooks
              --cursor --codex --no-ui
  ui          Open the local viewer (Stream/State/Digests/Metrics) in your
              browser. Foreground; Ctrl-C stops it. Flag: --no-open
  status      Brain location, last harvest age, counts, last 5 brain commits
  search <w>  Ranked lexical search over STATE + topics + digests
  log         git log of the brain (one commit per harvest)
  harvest     Force-harvest the newest unharvested transcript now
  consolidate Merge old digests (30d+) into per-month rollups now
  ab <q>      Ask one question twice — blind vs with the brain — same model and
              tools on both sides, so you can see what the brain is worth.
              Flags: --strict --no-tools --model <m> --brain <path>
  eval        Run the whole question set (.coding-brain/evals.json) A/B with a
              blind judge; reports per-category results.
              Flags: --strict --brain <path> --set <file>
  uninstall   Remove coding-brain hooks (brain dir is left untouched)
`;

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  try { ensureRuntime(); } catch { /* stable-copy is best-effort; package scripts remain the source */ }
  switch (cmd) {
    case 'init': await cmdInit(args); break;
    case 'ui': await cmdUi(args); break;
    case 'status': cmdStatus(); break;
    case 'search': cmdSearch(args); break;
    case 'log': cmdLog(); break;
    case 'harvest': cmdHarvest(); break;
    case 'consolidate': cmdConsolidate(); break;
    case 'ab': cmdAb(args); break;
    case 'eval': cmdEval(args); break;
    case 'uninstall': cmdUninstall(args); break;
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
})().catch((e) => die(e.stack || String(e)));
