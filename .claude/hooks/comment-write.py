#!/usr/bin/env python3
"""PreToolUse[Edit|Write]: refuse text that adds a comment comment-shape.py would reject.

Only the text being written is checked, never the resulting file, so trimming an oversize
comment across two edits is never blocked; the validate gate covers the whole file."""
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location(
    "comment_shape", os.path.join(os.path.dirname(__file__), "comment-shape.py"))
comment_shape = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comment_shape)

data = json.load(sys.stdin)
tool_input = data.get("tool_input", {})
path = tool_input.get("file_path", "")
text = tool_input.get("new_string") if data.get("tool_name") == "Edit" else tool_input.get("content")
hits = comment_shape.check(path, text or "")
if hits:
    if any("ticket number" in h for h in hits):
        print("A ticket number belongs in the commit message, never in the tree.", file=sys.stderr)
    else:
        print("A comment states a constraint from outside the code; a string states the current "
              "state.", file=sys.stderr)
        print("Delete it, or cut it to one present-tense sentence.", file=sys.stderr)
    for h in hits:
        print("  " + h.replace(path + ":", "line "), file=sys.stderr)
    sys.exit(2)
