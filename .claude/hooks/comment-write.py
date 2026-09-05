#!/usr/bin/env python3
"""PreToolUse[Edit|Write]: refuse text Gate 1 would reject — Vale over the fragment as its file
type, Vale again over it as raw text (string literals), plus comment-shape.py's structural checks.

Only the text being written is checked, never the resulting file, so trimming an oversize
comment across two edits is never blocked; the validate gate covers the whole file."""
import importlib.util
import json
import os
import subprocess
import sys

HOOKS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HOOKS))

spec = importlib.util.spec_from_file_location(
    "comment_shape", os.path.join(HOOKS, "comment-shape.py"))
comment_shape = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comment_shape)


def vale_hits(path, text):
    ext = os.path.splitext(path)[1]
    if not ext:
        return []
    install = subprocess.run(["bash", os.path.join(ROOT, ".claude/skills/validate/install-vale.sh")],
                             capture_output=True, text=True)
    if install.returncode != 0:
        print("comment discipline: Vale unavailable, structural checks only", file=sys.stderr)
        return []
    hits = []
    for config in (".vale.ini", ".vale-raw.ini"):
        run = subprocess.run([install.stdout.strip(), f"--config={config}", "--output=JSON", f"--ext={ext}"],
                             input=text, capture_output=True, text=True, cwd=ROOT)
        for file_alerts in json.loads(run.stdout or "{}").values():
            hits += [f"line {a['Line']}: {a['Message']}" for a in file_alerts if a["Severity"] == "error"]
    return list(dict.fromkeys(hits))


data = json.load(sys.stdin)
tool_input = data.get("tool_input", {})
path = tool_input.get("file_path", "")
text = tool_input.get("new_string") if data.get("tool_name") == "Edit" else tool_input.get("content")
text = text or ""
hits = [h.replace(path + ":", "line ") for h in comment_shape.check(path, text)] + vale_hits(path, text)
if hits:
    if any("ticket number" in h for h in hits):
        print("A ticket number belongs in the commit message, never in the code.", file=sys.stderr)
    else:
        print("A comment states a constraint from outside the code; a string states the current "
              "state.", file=sys.stderr)
        print("Delete it, or cut it to one present-tense sentence.", file=sys.stderr)
    for h in hits:
        print("  " + h, file=sys.stderr)
    sys.exit(2)
