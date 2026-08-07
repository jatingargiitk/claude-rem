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

function ensureRuntime() {
  fs.mkdirSync(SCRIPTS, { recursive: true });
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
  const cap = cfg.liteStateCapChars || 300000;
  const maxSessions = cfg.liteStateSessions || 15;
  const perSession = cfg.liteStatePerSessionChars || 30000;

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

function runLiteState(brain, workspace, corpusPath, nSessions) {
  const cfg = readJsonSoft(path.join(brain, 'config.json'), {});
  const model = cfg.model || 'claude-sonnet-5';
  const prompt = `You are initializing a coding brain — a compiled memory for this workspace.

You are given a corpus of the ${nSessions} most recent coding-agent sessions in this workspace (pre-condensed to user messages, assistant text, and tool targets; newest session LAST — when sessions conflict, the newest wins). Read it at: ${corpusPath}

Read ${path.join(brain, 'INSTRUCTIONS.md')} for the STATE.md format (Step 3) and the privacy rules, then write ONE file: ${path.join(brain, 'STATE.md')}

Rules:
- STATE.md is a ~100-line current-truth dashboard: Active projects, Conventions, Open threads.
- ORDER BY RECENCY: list Active projects newest-activity-first; the project the user worked on most recently comes first and gets the most detail. A project whose sessions are all noticeably older than the rest (roughly 3+ weeks stale) is NOT active — give it a single line under a "Dormant" heading instead, no matter how much corpus text it has. Corpus volume is a sampling artifact, not importance.
- Compile, don't narrate. Facts and decisions only; date facts that can go stale.
- The corpus is historical: prefer the newest session's version of any fact; mark things you cannot confirm as "unverified:" or "as of <date>".
- Never store secrets/keys/tokens; reference env var names only.
- Write only that one file, then stop.`;
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

  // Brain scaffold (needed for hooks either way).
  const brain = scaffoldBrain(workspace);
  console.log(`Brain: ${brain}`);

  // c. Lite STATE — ONE model call over the most recent sessions.
  if (compile && sessions.length) {
    const cfg = readJsonSoft(path.join(brain, 'config.json'), {});
    const { corpusPath, sessions: n, chars } = buildCorpus(brain, workspace, sessions, cfg);
    if (n === 0) {
      console.log('No usable transcript content after filtering — skipping the starter briefing.');
    } else {
      console.log(`Reading your ${n} most recent sessions and writing your starter briefing (one model call, ~1-3 min)...`);
      const res = runLiteState(brain, workspace, corpusPath, n);
      if (res.ok && fs.existsSync(path.join(brain, 'STATE.md'))) {
        spawnSync('git', ['-C', brain, 'add', '-A'], { stdio: 'ignore' });
        spawnSync('git', ['-C', brain, '-c', 'user.name=coding-brain', '-c', 'user.email=coding-brain@local',
          'commit', '-qm', `init: lite STATE from ${n} sessions`], { stdio: 'ignore' });
        console.log('\n===== Your starter briefing =====\n');
        console.log(fs.readFileSync(path.join(brain, 'STATE.md'), 'utf8'));
        console.log('=================================\n');
      } else {
        console.log(`Starter briefing failed (${res.err || 'nothing was written'}) — continuing with hooks-only install. Run \`npx coding-brain harvest\` later to retry.`);
      }
    }
  } else if (!compile) {
    console.log('Skipping starter compile — brain starts empty and grows from your next sessions.');
  }

  // d. Hook install (idempotent).
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

// -------------------------------------------------------------------- main

const USAGE = `coding-brain — a compiled brain for Claude Code, Cursor & Codex

Usage: npx coding-brain <command>

  init        Scan past transcripts, compile a starter STATE (with consent),
              and install session hooks. Flags: --yes --dry-run --hooks-only
              --cursor --codex --no-ui
  ui          Open the local viewer (Stream/State/Digests/Metrics) in your
              browser. Foreground; Ctrl-C stops it. Flag: --no-open
  status      Brain location, last harvest age, counts, last 5 brain commits
  search <w>  Ranked lexical search over STATE + topics + digests
  log         git log of the brain (one commit per harvest)
  harvest     Force-harvest the newest unharvested transcript now
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
    case 'uninstall': cmdUninstall(args); break;
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
})().catch((e) => die(e.stack || String(e)));
