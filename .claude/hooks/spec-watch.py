#!/usr/bin/env python3
"""SessionStart|Stop: tell the user about each protected spec file that changed since the last report,
committed or in the working tree, so a write the spec guard cannot see is still seen once. An approved
edit is reported too, as its receipt.

Stop runs every turn and must never fail one: on any error the hook stays silent and logs to stderr."""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile

HOOKS = os.path.dirname(os.path.abspath(__file__))
PATHSPECS = ["docs/architecture", "docs/adr", "CONTEXT.md", ":(glob)**/CLAUDE.md"]

spec = importlib.util.spec_from_file_location("spec_guard", os.path.join(HOOKS, "spec-guard.py"))
spec_guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spec_guard)


def git(root, *args, stdin=None):
    return subprocess.run(["git", "-C", root, *args], input=stdin, capture_output=True, text=True,
                          check=True).stdout


def head_files(root):
    files = {}
    for entry in git(root, "ls-tree", "-r", "-z", "HEAD").split("\0"):
        if entry:
            meta, path = entry.split("\t", 1)
            if spec_guard.protected(path):
                files[path] = meta.split()[2]
    return files


def tree_files(root, head):
    status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", *PATHSPECS)
    dirty = [entry[3:] for entry in status.split("\0") if entry]
    present = [path for path in dirty if os.path.isfile(os.path.join(root, path))]
    blobs = git(root, "hash-object", "--stdin-paths", stdin="".join(p + "\n" for p in present)).split() if present else []
    files = {path: blob for path, blob in head.items() if path not in dirty}
    return files | dict(zip(present, blobs))


def snapshot(root):
    head = head_files(root)
    return {"root": root, "head_sha": git(root, "rev-parse", "HEAD").strip(), "head": head,
            "tree": tree_files(root, head)}


def commit_of(root, old_sha, path):
    try:
        found = git(root, "log", "-1", "--format=%h %s", f"{old_sha}..HEAD", "--", path).strip()
    except subprocess.CalledProcessError:
        found = ""
    return f"committed in {found}" if found else "committed (HEAD moved)"


def report(old, new):
    lines = []
    for path in sorted(old["head"].keys() | new["head"].keys() | old["tree"].keys() | new["tree"].keys()):
        committed = old["head"].get(path) != new["head"].get(path)
        edited = old["tree"].get(path) != new["tree"].get(path)
        if committed:
            lines.append(f"  {path}: {commit_of(new['root'], old['head_sha'], path)}")
        if edited and not (committed and new["tree"].get(path) == new["head"].get(path)):
            lines.append(f"  {path}: changed in the working tree")
    if not lines:
        return None
    return "Protected spec files changed since the last report:\n" + "\n".join(lines)


def state_path(session_id):
    return os.path.join(tempfile.gettempdir(), "claude-spec-watch", re.sub(r"[^\w-]", "_", session_id) + ".json")


def main(data):
    path = state_path(data.get("session_id") or "unknown")
    old = None
    if os.path.exists(path):
        with open(path) as f:
            old = json.load(f)
    if old and data.get("hook_event_name") == "SessionStart":
        return
    root = old["root"] if old else git(data.get("cwd") or os.getcwd(), "rev-parse", "--show-toplevel").strip()
    new = snapshot(root)
    message = report(old, new) if old else None
    if message:
        print(json.dumps({"systemMessage": message}))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(new, f)


if __name__ == "__main__":
    try:
        main(json.load(sys.stdin))
    except Exception as error:
        print(f"spec-watch: {error!r}", file=sys.stderr)
