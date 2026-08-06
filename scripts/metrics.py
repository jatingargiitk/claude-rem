#!/usr/bin/env python3
"""Coding-brain effectiveness metrics.

Answers one question: is the brain actually saving work, or just writing notes?

Signals (outcome-based, not volume-based):
  misses         — user had to re-explain something the brain should know
                   (typed `brain miss: ...` in chat, or the harvester tagged
                   one in today's digest)
  hits           — brain-carried context got used without re-explanation
                   (user typed `brain hit: ...`, or the harvester tagged one
                   in today's digest — passive detection)
  evidence_fixes — harvest corrected a stale STATE claim using EVIDENCE
                   (`STATE corrected via evidence: ...` in today's digest)
  wrong_path     — known footguns recurred (identity/auth errors that a
                   remembered convention should have prevented)

Double-count protection:
  - user-text and footgun scans only cover the transcript delta since the
    last `log` run for that conversation (offsets in .state/metrics_state.json)
  - digest-derived notes are deduped against the last 3 days of records by
    normalized prefix + fuzzy word overlap, so in-place digest rewrites don't
    recount
  - a footgun label counts once per conversation

Usage:
  metrics.py log <transcript.jsonl> [WORKSPACE_ROOT]   # append one record
  metrics.py report [WORKSPACE_ROOT] [--days N]        # weekly rollup

Writes: <brain>/.state/metrics.jsonl (one record per harvest)
        <brain>/.state/metrics_state.json (scan offsets, seen footguns)
Brain dir = $BRAIN_DIR or <root>/.coding-brain. Python3 stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

MISS_RE = re.compile(r"brain\s*miss\s*:\s*(.+)", re.I)
HIT_RE = re.compile(r"brain\s*hit\s*:\s*(.+)", re.I)
CORRECTION_RE = re.compile(r"STATE corrected via evidence\s*:\s*(.+)", re.I)

# Footguns the brain is explicitly supposed to prevent. Recurrence = brain
# failed to surface a convention it already knows. Deliberately generic.
WRONG_PATH_PATTERNS = [
    (r"Repository not found", "wrong git identity/remote"),
    (r"Permission denied \(publickey\)", "wrong ssh key/identity"),
]

NOTE_MAX = 300
NOTES_PER_RECORD = 20


def _brain_dir(root: Path) -> Path:
    env = os.environ.get("BRAIN_DIR")
    return Path(env) if env else root / ".coding-brain"


def _state_dir(root: Path) -> Path:
    d = _brain_dir(root) / ".state"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _clip(s: str, n: int = NOTE_MAX) -> str:
    s = s.strip()
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0]
    return cut + "…"


def _norm_key(s: str) -> str:
    """Normalized prefix key for fuzzy dedupe across rewordings/truncations."""
    s = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    s = re.sub(r"\s+", " ", s).strip()
    return s[:60]


# ---------------------------------------------------------------- scan state

def _state_file(root: Path) -> Path:
    return _state_dir(root) / "metrics_state.json"


def _load_scan_state(root: Path) -> dict:
    path = _state_file(root)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("offsets", {})
                data.setdefault("wrong_path_seen", {})
                return data
        except (OSError, json.JSONDecodeError):
            pass
    # First run: seed offsets from the harvest-debounce files (session-id
    # named, containing the transcript size at last harvest) so history isn't
    # recounted the first time delta-scanning kicks in.
    state = {"offsets": {}, "wrong_path_seen": {}}
    for f in _state_dir(root).iterdir():
        if not re.fullmatch(r"[0-9a-f-]{36}", f.name):
            continue
        try:
            state["offsets"][f.name] = int(f.read_text().strip())
        except (OSError, ValueError):
            continue
    return state


def _save_scan_state(root: Path, state: dict) -> None:
    try:
        _state_file(root).write_text(json.dumps(state, indent=1), encoding="utf-8")
    except OSError:
        pass


# ------------------------------------------------------------- transcript IO

def _read_delta(transcript: Path, offset: int, cap_bytes: int = 4_000_000) -> str:
    """Read transcript from offset, aligned to the next full line."""
    try:
        with transcript.open("rb") as fh:
            if offset > 0:
                fh.seek(offset - 1)
                if fh.read(1) != b"\n":
                    # mid-line offset: skip the partial line
                    fh.readline()
            data = fh.read(cap_bytes)
        return data.decode("utf-8", errors="ignore")
    except OSError:
        return ""


def _iter_user_text(delta: str):
    """Yield user-authored text from transcript JSONL lines in the delta."""
    for line in delta.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        role = rec.get("role") or (rec.get("message") or {}).get("role")
        if role != "user":
            continue
        content = rec.get("content")
        if content is None:
            content = (rec.get("message") or {}).get("content")
        if isinstance(content, str):
            yield content
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    yield part["text"]


# ------------------------------------------------------------ digest signals

def _todays_digest_signals(
    root: Path, only: list[str] | None = None
) -> tuple[list[str], list[str], list[str]]:
    """Corrections, misses, and hits the harvester recorded in digests.

    `only` (from CHANGED_DIGESTS, set by distill.sh) restricts the scan to
    digests THIS harvest actually touched — without it, parallel sessions'
    digests get credited to whichever conversation harvests next. An empty
    `only` list means this harvest changed no digest: scan nothing.
    """
    sessions = _brain_dir(root) / "sessions"
    if not sessions.is_dir():
        return [], [], []
    today = datetime.now().strftime("%Y-%m-%d")
    corrections: list[str] = []
    misses: list[str] = []
    hits: list[str] = []
    if only is not None:
        paths = []
        for p in only:
            path = Path(p) if Path(p).is_absolute() else root / p
            if path.is_file():
                paths.append(path)
    else:
        paths = list(sessions.glob(f"{today}-*.md"))
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for m in CORRECTION_RE.finditer(text):
            corrections.append(_clip(m.group(1)))
        for m in MISS_RE.finditer(text):
            misses.append(_clip(m.group(1)))
        for m in HIT_RE.finditer(text):
            hits.append(_clip(m.group(1)))
    return corrections, misses, hits


_NOTE_STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "had", "has", "have", "was",
    "were", "are", "not", "but", "into", "from", "after", "before", "earlier",
    "later", "still", "then", "than", "when", "user", "session", "agent",
}


def _note_words(s: str) -> frozenset[str]:
    """Content words, lightly stemmed, so rewordings of the same signal
    ('re-explained' vs 're-explain', filler like 'had to') still overlap."""
    out = set()
    for w in re.findall(r"[a-z0-9]+", s.lower()):
        if len(w) < 3 or w in _NOTE_STOPWORDS:
            continue
        if len(w) > 4 and w.endswith("ing"):
            w = w[:-3]
        elif len(w) > 4 and w.endswith("ed"):
            w = w[:-2]
        elif len(w) > 3 and w.endswith("s"):
            w = w[:-1]
        out.add(w)
    return frozenset(out)


def _seen_note_keys(root: Path, days: int = 3) -> tuple[set[str], list[frozenset[str]]]:
    """Normalized keys + word sets of notes credited in recent records.

    Digests persist and get rewritten in place all day (sometimes across
    midnight for long sessions), so later harvests must not recount notes
    that were already credited — even if the wording drifted slightly.
    The word sets back a fuzzy (Jaccard) check, because the harvester rewords
    the same signal on every rewrite and defeats exact-prefix dedupe.
    """
    path = _state_dir(root) / "metrics.jsonl"
    seen: set[str] = set()
    word_sets: list[frozenset[str]] = []
    if not path.exists():
        return seen, word_sets
    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    try:
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
                for field in ("fix_notes", "miss_notes", "hit_notes"):
                    for n in rec.get(field) or []:
                        seen.add(_norm_key(n))
                        word_sets.append(_note_words(n))
    except OSError:
        pass
    return seen, word_sets


def _is_fuzzy_dup(words: frozenset[str], word_sets: list[frozenset[str]], thresh: float = 0.45) -> bool:
    if not words:
        return False
    for ws in word_sets:
        if not ws:
            continue
        inter = len(words & ws)
        if inter and inter / len(words | ws) >= thresh:
            return True
    return False


def _dedupe(notes: list[str], seen: set[str], word_sets: list[frozenset[str]]) -> list[str]:
    """Drop notes already seen (exact normalized key OR fuzzy word overlap)."""
    out: list[str] = []
    for n in notes:
        key = _norm_key(n)
        words = _note_words(n)
        if not key or key in seen or _is_fuzzy_dup(words, word_sets):
            continue
        seen.add(key)
        word_sets.append(words)
        out.append(n)
    return out


# --------------------------------------------------------------------- log

def cmd_log(argv: list[str]) -> int:
    if not argv:
        print("usage: metrics.py log <transcript.jsonl> [WORKSPACE_ROOT]", file=sys.stderr)
        return 2
    transcript = Path(argv[0])
    root = Path(argv[1] if len(argv) > 1 else os.getcwd()).resolve()

    scan = _load_scan_state(root)
    stem = transcript.stem
    offset = int(scan["offsets"].get(stem, 0) or 0)
    try:
        size = transcript.stat().st_size
    except OSError:
        size = 0
    delta = _read_delta(transcript, offset) if size > offset else ""

    misses: list[str] = []
    hits: list[str] = []
    for text in _iter_user_text(delta):
        for m in MISS_RE.finditer(text):
            misses.append(_clip(m.group(1)))
        for m in HIT_RE.finditer(text):
            hits.append(_clip(m.group(1)))

    # Footguns: scan only new transcript content, count each label once per
    # conversation for its lifetime.
    already_labels = set(scan["wrong_path_seen"].get(stem, []))
    wrong_paths = sorted(
        {label for pat, label in WRONG_PATH_PATTERNS if re.search(pat, delta, re.I)}
        - already_labels
    )
    scan["wrong_path_seen"][stem] = sorted(already_labels | set(wrong_paths))
    scan["offsets"][stem] = max(size, offset)

    # distill.sh always sets CHANGED_DIGESTS (possibly empty) so digest
    # signals are only read from files this harvest touched. Unset (manual
    # runs) falls back to scanning all of today's digests.
    only: list[str] | None = None
    if "CHANGED_DIGESTS" in os.environ:
        only = [p for p in os.environ["CHANGED_DIGESTS"].split(":") if p.strip()]
    corrections, digest_misses, digest_hits = _todays_digest_signals(root, only)

    seen, word_sets = _seen_note_keys(root)
    misses = _dedupe(misses + digest_misses, seen, word_sets)
    hits = _dedupe(hits + digest_hits, seen, word_sets)
    corrections = _dedupe(corrections, seen, word_sets)

    record = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "date": datetime.now().strftime("%Y-%m-%d"),
        "conversation": stem[:12],
        "misses": len(misses),
        "hits": len(hits),
        "evidence_fixes": len(corrections),
        "wrong_path": len(wrong_paths),
        "miss_notes": misses[:NOTES_PER_RECORD],
        "hit_notes": hits[:NOTES_PER_RECORD],
        "fix_notes": corrections[:NOTES_PER_RECORD],
        "wrong_path_notes": wrong_paths,
    }

    out = _state_dir(root) / "metrics.jsonl"
    with out.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record) + "\n")
    _save_scan_state(root, scan)
    print(str(out))
    return 0


# ------------------------------------------------------------------- report

def cmd_report(argv: list[str]) -> int:
    days = 7
    positional: list[str] = []
    i = 0
    while i < len(argv):
        if argv[i] == "--days" and i + 1 < len(argv):
            days = int(argv[i + 1])
            i += 2
            continue
        positional.append(argv[i])
        i += 1

    root = Path(positional[0] if positional else os.getcwd()).resolve()
    path = _state_dir(root) / "metrics.jsonl"
    if not path.exists():
        print("No metrics yet. Harvest at least once, then re-run.")
        return 0

    cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("date", "") >= cutoff:
                rows.append(rec)

    if not rows:
        print(f"No harvests in the last {days} days.")
        return 0

    totals = Counter()
    for r in rows:
        for k in ("misses", "hits", "evidence_fixes", "wrong_path"):
            totals[k] += int(r.get(k) or 0)

    per_day: dict[str, Counter] = {}
    for r in rows:
        d = per_day.setdefault(r["date"], Counter())
        for k in ("misses", "hits", "evidence_fixes", "wrong_path"):
            d[k] += int(r.get(k) or 0)

    print(f"Coding brain — last {days} days ({len(rows)} harvests)\n")
    print(f"  misses          {totals['misses']:>3}   (re-explained something it should know)")
    print(f"  hits            {totals['hits']:>3}   (brain context used without re-explaining)")
    print(f"  evidence_fixes  {totals['evidence_fixes']:>3}   (stale STATE claims corrected)")
    print(f"  wrong_path      {totals['wrong_path']:>3}   (known footguns recurred)")

    print("\nBy day:")
    for d in sorted(per_day):
        c = per_day[d]
        print(f"  {d}  miss={c['misses']} hit={c['hits']} fix={c['evidence_fixes']} wrong={c['wrong_path']}")

    notes = [n for r in rows for n in (r.get("miss_notes") or [])]
    if notes:
        print("\nRecent misses (fix these in STATE or a rule):")
        for n in notes[-8:]:
            print(f"  - {n}")

    hit_notes = [n for r in rows for n in (r.get("hit_notes") or [])]
    if hit_notes:
        print("\nRecent hits (brain context that got used):")
        for n in hit_notes[-8:]:
            print(f"  - {n}")

    fixes = [n for r in rows for n in (r.get("fix_notes") or [])]
    if fixes:
        print("\nStale claims caught by evidence:")
        for n in fixes[-8:]:
            print(f"  - {n}")

    m, h, f = totals["misses"], totals["hits"], totals["evidence_fixes"]
    print("\nRead:")
    if m == 0 and (h > 0 or f > 0):
        print("  Working — no re-explaining; brain context is being used and drift is caught.")
    elif m > 0 and h == 0 and f == 0:
        print("  Weak — you're still re-explaining and nothing is being credited or corrected.")
        print("  Check that misses are landing in STATE / conventions.")
    elif m > h + f:
        print("  Mixed — more misses than hits+corrections; brain is behind reality.")
    else:
        print("  Positive — hits and corrections outpace misses; keep going.")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd, rest = sys.argv[1], sys.argv[2:]
    if cmd == "log":
        return cmd_log(rest)
    if cmd == "report":
        return cmd_report(rest)
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
