#!/usr/bin/env python3
"""Condense a Claude Code / Cursor JSONL transcript for distillation.

Keeps: user messages (full), assistant text (truncated), file-edit targets,
command names. Drops: tool result dumps, diffs, metadata — the ~90% of bytes
with near-zero distill value. Deterministic, no LLM, stdlib only.

Privacy: strips <private>...</private> spans (multiline) BEFORE anything is
written, so private content never reaches a model. An unclosed <private> tag
drops the rest of that message.

Usage: filter.py <raw.jsonl> <out.txt> [assistant_cap_chars] [total_cap_chars]
"""
import json
import re
import sys

ASSISTANT_CAP = 2500   # chars per assistant message
TOTAL_CAP = 400_000    # chars overall (~100K tokens)

PRIVATE_RE = re.compile(r"<private>.*?</private>", re.DOTALL | re.IGNORECASE)
PRIVATE_OPEN_RE = re.compile(r"<private>.*\Z", re.DOTALL | re.IGNORECASE)


def strip_private(text):
    text = PRIVATE_RE.sub("[private content removed]", text)
    # Unclosed tag: drop everything from the tag to the end (fail closed).
    text = PRIVATE_OPEN_RE.sub("[private content removed]", text)
    return text


def parts(content):
    if isinstance(content, str):
        yield ("text", content)
        return
    if isinstance(content, list):
        for c in content:
            if not isinstance(c, dict):
                continue
            t = c.get("type")
            if t == "text" and c.get("text"):
                yield ("text", c["text"])
            elif t == "tool_use":
                inp = c.get("input")
                if isinstance(inp, dict):
                    target = inp.get("file_path") or inp.get("command") or inp.get("pattern") or ""
                else:
                    target = str(inp or "")
                yield ("tool", "%s: %s" % (c.get("name", "?"), str(target)[:200]))


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    raw, out_path = sys.argv[1], sys.argv[2]
    assistant_cap = int(sys.argv[3]) if len(sys.argv) > 3 else ASSISTANT_CAP
    total_cap = int(sys.argv[4]) if len(sys.argv) > 4 else TOTAL_CAP
    out = []
    total = 0
    for line in open(raw, encoding="utf-8", errors="ignore"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        msg = rec.get("message") if isinstance(rec.get("message"), dict) else rec
        role = msg.get("role") or rec.get("role")
        if role not in ("user", "assistant"):
            continue
        for kind, text in parts(msg.get("content")):
            text = strip_private(text).strip()
            if not text:
                continue
            if role == "user" and kind == "text":
                # tool_result blocks often masquerade as user turns; keep short ones only
                if text.startswith("{") and len(text) > 3000:
                    continue
                entry = "[USER] %s" % text
            elif role == "assistant" and kind == "text":
                entry = "[ASSISTANT] %s" % text[:assistant_cap]
            elif role == "assistant" and kind == "tool":
                entry = "[TOOL] %s" % text
            else:
                continue
            out.append(entry)
            total += len(entry)
            if total > total_cap:
                out.append("[FILTER] transcript truncated at cap")
                break
        if total > total_cap:
            break

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n\n".join(out))
    print("%s: %d entries, %d chars" % (raw, len(out), total))
    return 0


if __name__ == "__main__":
    sys.exit(main())
