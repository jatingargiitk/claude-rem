#!/usr/bin/env node
// coding-brain — a compiled brain for Claude Code & Cursor.
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
//   CODING_BRAIN_SETTINGS     default ~/.claude/settings.json

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync, spawn } = require('child_process');

const PKG_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(PKG_ROOT, 'scripts');
const TEMPLATES = path.join(PKG_ROOT, 'templates');

const CLAUDE_DIR = process.env.CODING_BRAIN_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const CURSOR_DIR = process.env.CODING_BRAIN_CURSOR_DIR || path.join(os.homedir(), '.cursor');
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
  const picked = sessions.slice(0, maxSessions);
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
    const header = `\n\n===== SESSION (${s.source}, project: ${s.project}, ${new Date(s.mtime).toISOString().slice(0, 10)}) =====\n\n`;
    if (total + text.length + header.length > cap) {
      const room = cap - total - header.length;
      if (room < 2000) break;
      text = text.slice(0, room) + '\n[corpus truncated at cap]';
    }
    chunks.push({ mtime: s.mtime, body: header + text });
    total += text.length;
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
      console.log('No usable transcript content after filtering — skipping lite STATE.');
    } else {
      console.log(`Compiling lite STATE from ${n} session(s) (${Math.round(chars / 1000)}KB condensed) — one model call, ~1-3 min...`);
      const res = runLiteState(brain, workspace, corpusPath, n);
      if (res.ok && fs.existsSync(path.join(brain, 'STATE.md'))) {
        spawnSync('git', ['-C', brain, 'add', '-A'], { stdio: 'ignore' });
        spawnSync('git', ['-C', brain, '-c', 'user.name=coding-brain', '-c', 'user.email=coding-brain@local',
          'commit', '-qm', `init: lite STATE from ${n} sessions`], { stdio: 'ignore' });
        console.log('\n===== STATE.md =====\n');
        console.log(fs.readFileSync(path.join(brain, 'STATE.md'), 'utf8'));
        console.log('====================\n');
      } else {
        console.log(`Lite STATE failed (${res.err || 'no STATE.md produced'}) — continuing with hooks-only install. Run \`coding-brain harvest\` later to retry.`);
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

  // e. Closing line.
  console.log('\nDone. Your next session in this workspace starts already knowing this —');
  console.log('every session end harvests new knowledge automatically (debounced, in the background).');
  console.log('Check anytime: coding-brain status | coding-brain search <words> | coding-brain log');
}

// ------------------------------------------------------------------ status

function cmdStatus() {
  const brain = findBrain(process.cwd());
  if (!brain) die('no .coding-brain found (run `coding-brain init` in your workspace root)');
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
  try { harvested = fs.readdirSync(stateDir).filter((f) => /^[0-9a-f-]{36}$/.test(f)).length; } catch { /* no state */ }
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
  if (!args.length) die('usage: coding-brain search <words...>');
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
  if (!brain) die('no .coding-brain found (run `coding-brain init` first)');
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
  if (brain) console.log(`Brain left untouched at ${brain} — delete it yourself if you want it gone.`);
}

// -------------------------------------------------------------------- main

const USAGE = `coding-brain — a compiled brain for Claude Code & Cursor

Usage: coding-brain <command>

  init        Scan past transcripts, compile a starter STATE (with consent),
              and install session hooks. Flags: --yes --dry-run --hooks-only --cursor
  status      Brain location, last harvest age, counts, last 5 brain commits
  search <w>  Ranked lexical search over STATE + topics + digests
  log         git log of the brain (one commit per harvest)
  harvest     Force-harvest the newest unharvested transcript now
  uninstall   Remove coding-brain hooks (brain dir is left untouched)
`;

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'init': await cmdInit(args); break;
    case 'status': cmdStatus(); break;
    case 'search': cmdSearch(args); break;
    case 'log': cmdLog(); break;
    case 'harvest': cmdHarvest(); break;
    case 'uninstall': cmdUninstall(args); break;
    default: console.log(USAGE); process.exit(cmd ? 1 : 0);
  }
})().catch((e) => die(e.stack || String(e)));
