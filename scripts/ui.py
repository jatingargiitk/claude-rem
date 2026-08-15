#!/usr/bin/env python3
"""claude-rem viewer — read-only local UI for a .claude-rem dir.

Shows the memory stream (one git commit per harvest), STATE, digests,
metrics, and the harvest log. Binds 127.0.0.1 only. python3 stdlib, no deps.
Runs only while you're looking at it — Ctrl-C stops it, nothing is resident.

Usage: ui.py [brain_dir] [--port N]
  brain_dir   defaults to $BRAIN_DIR, else walk-up discovery from cwd
  --port N    defaults to config.json uiPort (4180); 0 = OS-assigned;
              if the port is taken the next free one is used
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from shutil import which
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent


def _discover_brain(argv_dir: str | None) -> Path | None:
    if argv_dir:
        p = Path(argv_dir).resolve()
        return p if p.is_dir() else None
    env = os.environ.get("BRAIN_DIR")
    if env:
        p = Path(env).resolve()
        return p if p.is_dir() else None
    cur = Path.cwd()
    while True:
        cand = cur / ".claude-rem"
        if cand.is_dir():
            return cand
        if cur.parent == cur:
            return None
        cur = cur.parent


# ---- CLI args (stdlib-light: positional brain dir + --port) ----
_brain_arg: str | None = None
_port_arg: int | None = None
_args = sys.argv[1:]
i = 0
while i < len(_args):
    if _args[i] == "--port" and i + 1 < len(_args):
        _port_arg = int(_args[i + 1])
        i += 2
        continue
    if not _args[i].startswith("-"):
        _brain_arg = _args[i]
    i += 1

BRAIN = _discover_brain(_brain_arg)
if BRAIN is None:
    print("ui.py: no .claude-rem found (pass a brain dir, set $BRAIN_DIR, or run inside a workspace with one)", file=sys.stderr)
    sys.exit(2)
STATE_DIR = BRAIN / ".state"
SESSIONS = BRAIN / "sessions"
TOPICS = BRAIN / "topics"


def _cfg_port() -> int:
    try:
        return int(json.load(open(BRAIN / "config.json")).get("uiPort") or 4180)
    except Exception:
        return 4180


def _read(path: Path, limit: int | None = None) -> str:
    if not path.exists():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""
    if limit is not None and len(text) > limit:
        return text[:limit] + "\n\n… truncated"
    return text


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _age_label(mtime: float | None) -> str:
    if mtime is None:
        return "missing"
    secs = max(0, int(time.time() - mtime))
    if secs < 60:
        return f"{secs}s ago"
    if secs < 3600:
        return f"{secs // 60}m ago"
    if secs < 86400:
        return f"{secs // 3600}h ago"
    return f"{secs // 86400}d ago"


def _receipt() -> str:
    """Freshness line for the page — plain language, no internal vocabulary.

    (The recall hooks keep their own agent-facing wording; this is display
    copy only.)"""
    ts = 0
    try:
        ts = int((STATE_DIR / "last_success").read_text().strip())
    except (OSError, ValueError):
        pass
    if ts:
        mins = max(0, int(time.time()) - ts) // 60
        if mins < 60:
            freshness = f"{mins}m ago"
        elif mins < 1440:
            freshness = f"{mins // 60}h ago"
        else:
            freshness = f"{mins // 1440}d ago"
    else:
        freshness = "not yet — it learns as you work"
    subject = ""
    try:
        subject = subprocess.check_output(
            ["git", "-C", str(BRAIN), "log", "-1", "--format=%s"],
            text=True, timeout=5, stderr=subprocess.DEVNULL).strip()
    except Exception:
        pass
    if subject.startswith("harvest: "):
        mid = f" · learned: {subject[9:]}"
    elif subject.startswith("init: lite STATE") or subject.startswith("init: brain compiled"):
        mid = " · learned: your starter briefing"
    elif subject.startswith("baseline:"):
        mid = ""
    else:
        mid = f" · learned: {subject}" if subject else ""
    # Harvest subjects occasionally get polluted with a markdown fence; fall
    # back to the newest session note's own title.
    if "```" in mid:
        title = ""
        if SESSIONS.is_dir():
            notes = sorted(SESSIONS.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True)
            if notes:
                title = _note_title(notes[0])
        mid = f" · learned: {title}" if title else ""
    warn = " · WARNING: last update failed — see .claude-rem/.state/harvest.log" \
        if (STATE_DIR / "last_failure").exists() else ""
    return f"🧠 updated {freshness}{mid}{warn}"


def _metrics_summary(days: int = 7) -> dict:
    path = STATE_DIR / "metrics.jsonl"
    totals = {"misses": 0, "hits": 0, "evidence_fixes": 0, "wrong_path": 0, "harvests": 0}
    by_day: dict[str, dict] = {}
    recent_misses: list[str] = []
    recent_hits: list[str] = []
    recent_fixes: list[str] = []
    if not path.exists():
        return {"totals": totals, "by_day": [], "miss_notes": [], "hit_notes": [],
                "fix_notes": [], "days": days, "verdict": "No harvests yet."}

    cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - days * 86400))
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("date", "") < cutoff:
                continue
            totals["harvests"] += 1
            for k in ("misses", "hits", "evidence_fixes", "wrong_path"):
                totals[k] += int(rec.get(k) or 0)
            d = rec.get("date") or "?"
            slot = by_day.setdefault(d, {"date": d, "misses": 0, "hits": 0, "evidence_fixes": 0, "wrong_path": 0})
            for k in ("misses", "hits", "evidence_fixes", "wrong_path"):
                slot[k] += int(rec.get(k) or 0)
            recent_misses.extend(rec.get("miss_notes") or [])
            recent_hits.extend(rec.get("hit_notes") or [])
            recent_fixes.extend(rec.get("fix_notes") or [])

    m, h, f = totals["misses"], totals["hits"], totals["evidence_fixes"]
    if totals["harvests"] == 0:
        verdict = "No harvests yet."
    elif m == 0 and (h > 0 or f > 0):
        verdict = "Working — no re-explaining; brain context is used and drift is caught."
    elif m > 0 and h == 0 and f == 0:
        verdict = "Weak — still re-explaining, nothing credited or corrected."
    elif m > h + f:
        verdict = "Mixed — more misses than hits+corrections."
    else:
        verdict = "Positive — hits and corrections outpace misses."

    return {
        "totals": totals,
        "by_day": [by_day[d] for d in sorted(by_day)],
        "miss_notes": recent_misses[-8:],
        "hit_notes": recent_hits[-8:],
        "fix_notes": recent_fixes[-8:],
        "days": days,
        "verdict": verdict,
    }


def _note_title(path: Path) -> str:
    """First heading of a note, cleaned for display."""
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            s = line.strip()
            if not s or s.startswith("```"):        # skip blank + fence lines
                continue
            s = s.lstrip("# ").strip()
            if s:
                return re.sub(r"^(Session|Topic):\s*", "", s)[:140]
    except OSError:
        pass
    return path.stem


def _unfence(text: str) -> str:
    """Harvests sometimes wrap a whole file in a ```markdown fence — unwrap it."""
    t = text.strip()
    m = re.match(r"^```[a-zA-Z]*\n([\s\S]*?)\n?```$", t)
    return m.group(1) if m else text


# ---------------------------------------------------------------- briefing
# The page's hero is not the STATE file — it's the brain TALKING: a compiled,
# second-person brief generated by the same engine the harvester uses. Cached
# by brain git-head, so it costs one small model call per brain change.

_brief_lock = threading.Lock()
_brief_running = False


def _brief_cache_path() -> Path:
    return STATE_DIR / "ui_briefing.json"


def _brain_head() -> str:
    try:
        return subprocess.check_output(
            ["git", "-C", str(BRAIN), "rev-parse", "HEAD"],
            text=True, timeout=5, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return f"mtime:{int(_mtime(BRAIN / 'STATE.md') or 0)}"


def _engine() -> tuple[str, str] | None:
    if which("claude"):
        return ("claude", "claude")
    if which("cursor-agent"):
        return ("cursor-agent", "cursor")
    if which("agent"):
        return ("agent", "cursor")
    return None


def _strip_md(s: str) -> str:
    s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
    return re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", s).strip()


def _fallback_brief(state: str) -> dict:
    """No engine / model failure: a deterministic parse of STATE, still framed
    as a brief rather than a file dump."""
    lines = state.splitlines()
    headline, narrative, left_off = "", [], []
    section = ""
    for ln in lines:
        if ln.startswith("## "):
            section = ln[3:].strip().lower()
            continue
        if not ln.strip() or ln.startswith("#"):
            continue
        if not headline and ln.lower().startswith("last updated"):
            headline = ln.strip()
        if section.startswith(("what this workspace is", "summary")) and len(" ".join(narrative)) < 400:
            narrative.append(_strip_md(ln))
        if section.startswith(("open threads", "next steps")) and len(left_off) < 5:
            item = _strip_md(ln)
            if item:
                left_off.append(item)
    return {
        "headline": headline or "Here's where your work stands.",
        "narrative": " ".join(narrative)[:800] or "Fresh brain — it fills in as you work.",
        "left_off": left_off, "wins": [], "watch": [],
    }


def _sanitize_brief(d: dict) -> dict:
    def strs(key, n):
        return [str(x)[:220] for x in (d.get(key) or []) if str(x).strip()][:n]
    return {
        "headline": str(d.get("headline") or "")[:220],
        "narrative": str(d.get("narrative") or "")[:900],
        "left_off": strs("left_off", 5),
        "wins": strs("wins", 5),
        "watch": strs("watch", 5),
    }


def _generate_brief(head: str) -> None:
    global _brief_running
    try:
        state = _unfence(_read(BRAIN / "STATE.md", 12000))
        topics = []
        if TOPICS.is_dir():
            for p in sorted(TOPICS.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True)[:8]:
                topics.append(f"--- topic: {p.name} ---\n" + _unfence(_read(p, 2500)))
        prompt = (
            "[claude-rem:meta]\n"
            "You are the voice of a developer's coding memory. Below is the compiled "
            "state of their workspace. Write a briefing that makes them feel 'this "
            "thing KNOWS my work'. Second person ('you'), concrete — name real "
            "projects, files, versions, numbers from the notes. No preamble, no "
            "markdown headers; backticks for code/paths are fine.\n\n"
            "Reply with ONLY strict JSON, no code fence:\n"
            '{"headline": "one punchy sentence — the single most important current fact",\n'
            ' "narrative": "2-3 sentences: what they are building and where it stands today",\n'
            ' "left_off": ["up to 4 unfinished threads, each actionable, <=16 words"],\n'
            ' "wins": ["up to 3 recent shipped/verified things, <=12 words"],\n'
            ' "watch": ["up to 3 risks/warnings worth attention, <=14 words"]}\n\n'
            f"STATE:\n{state}\n\n" + "\n\n".join(topics))
        eng = _engine()
        if eng is None:
            data = _fallback_brief(state)
        else:
            binname, kind = eng
            argv = [binname, "-p", prompt] + (
                ["--model", "claude-sonnet-5-high", "--force", "--output-format", "text"]
                if kind == "cursor" else
                ["--model", "claude-haiku-4-5-20251001", "--setting-sources", "", "--output-format", "json"])
            env = dict(os.environ, CLAUDE_REM_HARVEST="1")
            out = subprocess.check_output(argv, text=True, timeout=150, env=env,
                                          stderr=subprocess.DEVNULL)
            if kind != "cursor":
                out = json.loads(out).get("result", "")
            txt = re.sub(r"^```(?:json)?\s*|\s*```$", "", out.strip())
            data = _sanitize_brief(json.loads(txt))
            if not data["headline"] and not data["narrative"]:
                data = _fallback_brief(state)
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        _brief_cache_path().write_text(json.dumps(
            {"head": head, "at": int(time.time()), "data": data}), encoding="utf-8")
    except Exception:
        try:
            data = _fallback_brief(_unfence(_read(BRAIN / "STATE.md", 12000)))
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            _brief_cache_path().write_text(json.dumps(
                {"head": head, "at": int(time.time()), "data": data, "fallback": True}),
                encoding="utf-8")
        except Exception:
            pass
    finally:
        _brief_running = False


def api_briefing() -> dict:
    global _brief_running
    head = _brain_head()
    cache: dict = {}
    try:
        cache = json.loads(_brief_cache_path().read_text(encoding="utf-8"))
    except Exception:
        pass
    if cache.get("head") == head and cache.get("data"):
        return {"ready": True, "data": cache["data"], "at": cache.get("at")}
    started = False
    with _brief_lock:
        if not _brief_running:
            _brief_running = True
            started = True
    if started:
        threading.Thread(target=_generate_brief, args=(head,), daemon=True).start()
    return {"ready": False, "generating": True, "data": cache.get("data")}


def _open_threads(state: str) -> list[str]:
    threads: list[str] = []
    in_section = False
    for line in state.splitlines():
        if line.startswith("## Open threads"):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if in_section and line.startswith("- "):
            threads.append(line[2:].strip())
    return threads[:20]


def _counts() -> dict:
    digests = len(list(SESSIONS.glob("*.md"))) if SESSIONS.is_dir() else 0
    topics = len(list(TOPICS.glob("*.md"))) if TOPICS.is_dir() else 0
    harvested = 0
    if STATE_DIR.is_dir():
        for f in STATE_DIR.iterdir():
            if re.fullmatch(r"[0-9a-f-]{36}", f.name) or (f.name.startswith("rollout-") and "." not in f.name[8:]):
                harvested += 1
    return {"digests": digests, "topics": topics, "harvested": harvested}


def api_overview() -> dict:
    state_path = BRAIN / "STATE.md"
    harvest_log = STATE_DIR / "harvest.log"
    state = _read(state_path)
    last_updated = ""
    m = re.search(r"Last updated:\s*(.+)", state)
    if m:
        last_updated = m.group(1).strip()

    digests = []
    if SESSIONS.is_dir():
        for p in sorted(SESSIONS.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True)[:8]:
            digests.append({
                "name": p.name,
                "age": _age_label(_mtime(p)),
                "title": (p.read_text(encoding="utf-8", errors="ignore").splitlines() or [""])[0].lstrip("# ").strip(),
            })

    harvest_tail = ""
    if harvest_log.exists():
        lines = harvest_log.read_text(encoding="utf-8", errors="ignore").splitlines()
        harvest_tail = "\n".join(lines[-12:])

    return {
        "now": time.strftime("%Y-%m-%d %H:%M:%S"),
        "brain": str(BRAIN),
        "receipt": _receipt(),
        "state_age": _age_label(_mtime(state_path)),
        "state_updated": last_updated,
        "counts": _counts(),
        "open_threads": _open_threads(state),
        "recent_digests": digests,
        "metrics": _metrics_summary(7),
        "harvest_tail": harvest_tail,
    }


def api_feed(limit: int = 30) -> dict:
    """Memory stream: one entry per brain git commit (harvests + baseline)."""
    try:
        out = subprocess.check_output(
            ["git", "-C", str(BRAIN), "log", f"-{limit}",
             "--pretty=format:%h|%at|%s", "--name-only"],
            text=True, timeout=10, stderr=subprocess.DEVNULL)
    except Exception as e:
        return {"entries": [], "error": f"brain not under git yet ({e})"}
    entries: list[dict] = []
    cur: dict | None = None
    for line in out.splitlines():
        if re.match(r"^[0-9a-f]{7,40}\|\d+\|", line):
            h, ts, subj = line.split("|", 2)
            cur = {"hash": h, "ts": int(ts), "age": _age_label(float(ts)),
                   "subject": subj, "files": []}
            entries.append(cur)
        elif line.strip() and cur is not None:
            cur["files"].append(line.strip())
    # Display title: the session note's own heading beats the commit subject
    # (subjects occasionally get polluted with markdown fences).
    for e in entries:
        note = next((f for f in e["files"] if f.startswith("sessions/")), None)
        if note and (SESSIONS / Path(note).name).is_file():
            e["title"] = _note_title(SESSIONS / Path(note).name)
    return {"entries": entries}


def api_search(q: str) -> dict:
    """Proxy to search.sh — the same pull retrieval the agents use.

    Returns the raw text plus structured, navigable results parsed from it,
    so the UI can render clickable citation cards instead of a grep dump."""
    words = [w for w in q.split() if w][:6]
    if not words:
        return {"text": "", "results": []}
    script = HERE / "search.sh"
    env = dict(os.environ, BRAIN_DIR=str(BRAIN))
    try:
        out = subprocess.check_output(
            ["bash", str(script), *words],
            text=True, timeout=15, env=env, stderr=subprocess.STDOUT)
    except Exception as e:
        out = f"(search failed: {e})"
    results = []
    cur = None
    for line in out.splitlines():
        m = re.match(r"^── (.+?)\s+\(words", line)
        if m:
            p = Path(m.group(1))
            kind = "note"
            if "/topics/" in m.group(1):
                kind = "project"
            elif p.name == "STATE.md":
                kind = "briefing"
            cur = {"kind": kind, "name": p.name, "title": _note_title(p) if p.is_file() else p.stem,
                   "age": _age_label(_mtime(p)), "lines": []}
            results.append(cur)
            continue
        m = re.match(r"^\s+(\d+):[-–]?\s?(.*)$", line)
        if m and cur is not None and len(cur["lines"]) < 4:
            cur["lines"].append(m.group(2).strip())
    return {"text": out, "results": results}


def api_digest(name: str) -> dict:
    # Prevent path traversal: basename only, strict allowlist pattern.
    safe = Path(name).name
    if safe != name or not re.match(r"^[\w.\-]+\.md$", safe) or ".." in safe:
        return {"error": "bad name"}
    path = SESSIONS / safe
    if not path.is_file() or path.resolve().parent != SESSIONS.resolve():
        return {"error": "not found"}
    return {"name": safe, "age": _age_label(_mtime(path)), "text": _read(path)}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter
        pass

    def _json(self, code: int, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _text(self, code: int, text: str, ctype: str = "text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/", "/index.html"):
            return self._text(200, _read(HERE / "ui.html"), "text/html; charset=utf-8")

        if path == "/api/overview":
            return self._json(200, api_overview())

        if path == "/api/feed":
            return self._json(200, api_feed())

        if path == "/api/search":
            q = (qs.get("q") or [""])[0].strip()
            return self._json(200, api_search(q))

        if path == "/api/briefing":
            return self._json(200, api_briefing())

        if path == "/api/state":
            return self._json(200, {
                "text": _read(BRAIN / "STATE.md"),
                "age": _age_label(_mtime(BRAIN / "STATE.md")),
            })

        if path == "/api/metrics":
            try:
                days = int((qs.get("days") or ["7"])[0])
            except ValueError:
                days = 7
            return self._json(200, _metrics_summary(days))

        if path == "/api/digests":
            items = []
            if SESSIONS.is_dir():
                for p in sorted(SESSIONS.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
                    title = ""
                    try:
                        title = (p.read_text(encoding="utf-8", errors="ignore").splitlines() or [""])[0].lstrip("# ").strip()
                    except OSError:
                        pass
                    items.append({"name": p.name, "age": _age_label(_mtime(p)), "title": title})
            return self._json(200, {"digests": items})

        if path.startswith("/api/digest/"):
            name = path[len("/api/digest/"):]
            return self._json(200, api_digest(name))

        if path.startswith("/api/project/"):
            slug = Path(path[len("/api/project/"):]).name.replace(".md", "")
            if not re.match(r"^[\w.\-]+$", slug):
                return self._json(200, {"error": "bad name"})
            tp = TOPICS / f"{slug}.md"
            topic_text = _read(tp) if tp.is_file() else ""
            toks = [w for w in slug.lower().replace("_", "-").split("-") if len(w) >= 4]
            state = _unfence(_read(BRAIN / "STATE.md"))
            threads = [th for th in _open_threads(state)
                       if any(w in th.lower() for w in toks + [slug.lower()])]
            sessions = []
            if SESSIONS.is_dir():
                for p in sorted(SESSIONS.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
                    hay = (p.name + " " + _read(p, 4000)).lower()
                    if any(w in hay for w in toks + [slug.lower()]):
                        sessions.append({"name": p.name, "title": _note_title(p),
                                         "age": _age_label(_mtime(p))})
                    if len(sessions) >= 10:
                        break
            return self._json(200, {"slug": slug, "topic": topic_text,
                                    "threads": threads[:8], "sessions": sessions})

        if path == "/api/topics":
            items = []
            if TOPICS.is_dir():
                for p in sorted(TOPICS.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
                    items.append({"name": p.name, "age": _age_label(_mtime(p)),
                                  "title": _note_title(p)})
            return self._json(200, {"topics": items})

        if path.startswith("/api/topic/"):
            name = path[len("/api/topic/"):]
            safe = Path(name).name
            if safe != name or not re.match(r"^[\w.\-]+\.md$", safe) or ".." in safe:
                return self._json(200, {"error": "bad name"})
            tp = TOPICS / safe
            if not tp.is_file() or tp.resolve().parent != TOPICS.resolve():
                return self._json(200, {"error": "not found"})
            return self._json(200, {"name": safe, "age": _age_label(_mtime(tp)),
                                    "text": _read(tp)})

        if path == "/api/harvest-log":
            log = STATE_DIR / "harvest.log"
            lines = _read(log).splitlines()[-80:] if log.exists() else []
            return self._json(200, {"lines": lines, "age": _age_label(_mtime(log))})

        self._json(404, {"error": "not found"})


def _bind(port: int) -> ThreadingHTTPServer:
    """Bind 127.0.0.1:<port>; if taken, walk forward to the next free port
    (0 = let the OS pick)."""
    if port == 0:
        return ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    for candidate in range(port, port + 20):
        try:
            return ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
        except OSError:
            continue
    return ThreadingHTTPServer(("127.0.0.1", 0), Handler)


def main():
    port = _port_arg if _port_arg is not None else _cfg_port()
    server = _bind(port)
    actual = server.server_address[1]
    print(f"claude-rem viewer → http://127.0.0.1:{actual}", flush=True)
    print(f"  brain: {BRAIN}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
