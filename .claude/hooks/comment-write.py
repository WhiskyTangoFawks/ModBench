#!/usr/bin/env python3
"""PreToolUse[Edit|Write]: refuse text Gate 1 would reject — Vale over the fragment as its file
type, Vale again over it as raw text (string literals), plus comment-shape.py's structural checks.
Gate 1 lints only what git tracks, so a gitignored file or one no repository holds passes.

Only the text being written is checked, never the resulting file, so trimming an oversize
comment across two edits is never blocked; the validate gate covers the whole file."""
import importlib.util
import json
import os
import re
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
    if ext == ".mjs":
        ext = ".js"
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


def gate_lints(path):
    target = os.path.join(ROOT, path)
    directory = os.path.dirname(target)
    while not os.path.isdir(directory):
        directory = os.path.dirname(directory)
    ignored = subprocess.run(["git", "-C", directory, "check-ignore", "-q", target], capture_output=True)
    return ignored.returncode == 1


SELF_EXPLAINED = re.compile("Ticket number|Cite the ADR")

data = json.load(sys.stdin)
tool_input = data.get("tool_input", {})
path = tool_input.get("file_path", "")
if not gate_lints(path):
    sys.exit(0)
text = tool_input.get("new_string") if data.get("tool_name") == "Edit" else tool_input.get("content")
text = text or ""
test_hits = comment_shape.comments_in_test(path, text)
shape_hits = comment_shape.check(path, text) + test_hits
hits = [h.replace(path + ":", "line ") for h in shape_hits] + vale_hits(path, text)
if hits:
    if not path.endswith(".md") and not test_hits and not all(SELF_EXPLAINED.search(h) for h in hits):
        print("A comment states a constraint from outside the code; a string states the current "
              "state.", file=sys.stderr)
        print("Delete it, or cut it to one present-tense sentence.", file=sys.stderr)
    for h in hits:
        print("  " + h, file=sys.stderr)
    sys.exit(2)
