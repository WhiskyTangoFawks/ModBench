#!/usr/bin/env python3
"""SessionStart|Stop: tell the user about each file the spec guard protects that changed since the last
report, committed or in the working tree, so a write the guard cannot see is still seen once. An approved
edit is reported too, as its receipt.

Stop runs every turn and must never fail one: on any error the hook stays silent and logs to stderr."""
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time

HOOKS = os.path.dirname(os.path.abspath(__file__))
PATHSPECS = ["docs/architecture", "docs/adr", "CONTEXT.md", ":(glob)**/CLAUDE.md", ".claude/hooks",
             ":(glob).claude/settings*.json"]
STATE_DIR = os.path.join(tempfile.gettempdir(), "claude-spec-watch")
STATE_LIFETIME = 7 * 86400


def load_guard():
    spec = importlib.util.spec_from_file_location("spec_guard", os.path.join(HOOKS, "spec-guard.py"))
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    return guard


def git(root, *args, stdin=None):
    return subprocess.run(["git", "-C", root, *args], input=stdin, capture_output=True, text=True,
                          check=True).stdout


def head_files(root, spec_guard):
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


def snapshot(root, spec_guard):
    head = head_files(root, spec_guard)
    return {"root": root, "head_sha": git(root, "rev-parse", "HEAD").strip(), "head": head,
            "tree": tree_files(root, head)}


def commit_of(root, old_sha, path):
    try:
        found = git(root, "log", "-1", "--format=%h %s", f"{old_sha}..HEAD", "--", path).strip()
    except subprocess.CalledProcessError:
        found = ""
    return f"committed in {found}" if found else "committed (HEAD moved)"


def report(old, new):
    lines, reported = [], dict(old["reported"])
    for path in sorted(old["head"].keys() | new["head"].keys() | old["tree"].keys() | new["tree"].keys()):
        blob, committed_blob = new["tree"].get(path), new["head"].get(path)
        committed = old["head"].get(path) != committed_blob and committed_blob != old["reported"].get(path)
        edited = old["tree"].get(path) != blob and not (committed and blob == committed_blob)
        if committed:
            lines.append(f"  {path}: {commit_of(new['root'], old['head_sha'], path)}")
        if edited:
            lines.append(f"  {path}: changed in the working tree")
            reported[path] = blob
    return ("Protected files changed since the last report:\n" + "\n".join(lines) if lines else None), reported


def read_state(path):
    try:
        with open(path) as f:
            state = json.load(f)
        return state if {"root", "head_sha", "head", "tree", "reported"} <= state.keys() else None
    except (OSError, ValueError, AttributeError):
        return None


def write_state(path, state):
    with tempfile.NamedTemporaryFile("w", dir=STATE_DIR, suffix=".tmp", delete=False) as f:
        json.dump(state, f)
    os.replace(f.name, path)


def prune_states():
    for name in os.listdir(STATE_DIR):
        entry = os.path.join(STATE_DIR, name)
        try:
            if time.time() - os.path.getmtime(entry) > STATE_LIFETIME:
                os.remove(entry)
        except FileNotFoundError:
            pass


def main(data, spec_guard):
    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, re.sub(r"[^\w-]", "_", data.get("session_id") or "unknown") + ".json")
    old = read_state(path)
    if data.get("hook_event_name") == "SessionStart":
        prune_states()
        if old:
            return
    root = old["root"] if old else git(data.get("cwd") or os.getcwd(), "rev-parse", "--show-toplevel").strip()
    new = snapshot(root, spec_guard) | {"reported": {}}
    message = None
    if old:
        message, new["reported"] = report(old, new)
    if message:
        print(json.dumps({"systemMessage": message}))
    write_state(path, new)


if __name__ == "__main__":
    try:
        main(json.load(sys.stdin), load_guard())
    except Exception as error:
        print(f"spec-watch: {error!r}", file=sys.stderr)
