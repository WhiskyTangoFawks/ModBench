#!/usr/bin/env python3
"""
Parse the latest (or a given) Stryker mutation-report.json and print only
Survived and NoCoverage mutants with source context.

Usage (from MEditService/):
  python ../.claude/skills/mutation-test/parse-report.py
  python ../.claude/skills/mutation-test/parse-report.py path/to/mutation-report.json
  python ../.claude/skills/mutation-test/parse-report.py --diff-only
  python ../.claude/skills/mutation-test/parse-report.py --diff-only --target main

--diff-only narrows the report (which Stryker's `since` scopes at the *file* level,
mutating every testable line in any touched file) down to survivors whose lines
actually intersect the git diff against --target (default: stryker-config.json's
since.target). Use it to check "did my diff introduce anything new" without
re-running Stryker; the unfiltered report remains the full-file entropy audit.

Exit 0 if all mutants killed, 1 if any Survived/NoCoverage remain, 2 on error.
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def find_latest_report(base: Path) -> Path | None:
    reports = glob.glob(str(base / "StrykerOutput" / "**" / "mutation-report.json"), recursive=True)
    return Path(max(reports, key=os.path.getmtime)) if reports else None


def source_context(lines: list[str], start: int, end: int, ctx: int = 3) -> str:
    parts = []
    for i in range(max(0, start - 1 - ctx), min(len(lines), end + ctx)):
        marker = ">>>" if start - 1 <= i <= end - 1 else "   "
        parts.append(f"{marker} {i + 1:4d}: {lines[i].rstrip()}")
    return "\n".join(parts)


def default_since_target(repo_root: Path) -> str:
    try:
        with open(repo_root / "MEditService" / "stryker-config.json") as f:
            cfg = json.load(f)
        return cfg["stryker-config"]["since"]["target"]
    except (OSError, KeyError, json.JSONDecodeError):
        return "main"


def changed_lines(repo_root: Path, target: str, file_path: str) -> set[int] | None:
    """Changed (added/modified) line numbers in the new version of file_path, per
    `git diff target -- file_path`. None means "treat as fully changed" (file is
    untracked/new, so it has no meaningful diff against target)."""
    rel = os.path.relpath(file_path, repo_root)
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", rel],
        cwd=repo_root, capture_output=True, text=True,
    ).returncode == 0
    if not tracked:
        return None

    diff = subprocess.run(
        ["git", "diff", target, "--", rel],
        cwd=repo_root, capture_output=True, text=True,
    ).stdout

    lines: set[int] = set()
    new_line = None
    for line in diff.splitlines():
        hunk = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@", line)
        if hunk:
            new_line = int(hunk.group(1))
            continue
        if new_line is None or line.startswith("\\"):
            continue
        if line.startswith("+") and not line.startswith("+++"):
            lines.add(new_line)
            new_line += 1
        elif line.startswith("-") and not line.startswith("---"):
            continue  # removed line has no home in the new file; don't advance
        else:
            new_line += 1
    return lines


def resolve_report_path(report_arg: str | None) -> Path:
    if report_arg:
        report_path = Path(report_arg)
        if not report_path.exists():
            print(f"ERROR: {report_path} not found", file=sys.stderr)
            sys.exit(2)
        return report_path
    report_path = find_latest_report(Path("."))
    if not report_path:
        print("ERROR: no mutation-report.json found under StrykerOutput/", file=sys.stderr)
        sys.exit(2)
    return report_path


def mutant_survives_diff(fp: str, sl: int, el: int, repo_root: Path, target: str,
                          diff_cache: dict[str, set[int] | None]) -> bool:
    if fp not in diff_cache:
        diff_cache[fp] = changed_lines(repo_root, target, fp)
    file_changed_lines = diff_cache[fp]
    return file_changed_lines is None or any(l in file_changed_lines for l in range(sl, el + 1))


def collect_results(data: dict, diff_only: bool, repo_root: Path | None, target: str | None) -> tuple[int, list[tuple]]:
    total = 0
    results = []
    diff_cache: dict[str, set[int] | None] = {}
    for fp, fd in data.get("files", {}).items():
        src = fd.get("source", "").splitlines()
        for m in fd.get("mutants", []):
            status = m.get("status", "")
            if status not in ("Survived", "NoCoverage"):
                continue
            total += 1
            sl = m["location"]["start"]["line"]
            el = m["location"]["end"]["line"]
            if diff_only and not mutant_survives_diff(fp, sl, el, repo_root, target, diff_cache):
                continue
            results.append((status, fp, sl, m.get("mutatorName", "?"),
                            m.get("description", m.get("replacement", "?")),
                            source_context(src, sl, el)))
    return total, results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("report_path", nargs="?", help="Path to mutation-report.json (default: latest under StrykerOutput/)")
    parser.add_argument("--diff-only", action="store_true",
                         help="Only show survivors whose lines intersect the git diff vs --target")
    parser.add_argument("--target", default=None,
                         help="Git ref to diff against for --diff-only (default: stryker-config.json's since.target)")
    args = parser.parse_args()

    report_path = resolve_report_path(args.report_path)
    with open(report_path) as f:
        data = json.load(f)

    repo_root, target = None, args.target
    if args.diff_only:
        repo_root = Path(subprocess.run(
            ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True,
        ).stdout.strip())
        if target is None:
            target = default_since_target(repo_root)

    total, results = collect_results(data, args.diff_only, repo_root, target)

    if args.diff_only:
        print(f"Filtered {total - len(results)} file-level survivors outside the diff ({total} -> {len(results)})")

    if not results:
        print("No issues found.")
        sys.exit(0)

    for status, fp, line, mutator, desc, ctx in results:
        display_path = fp.split("MEditService.Core/")[-1] if "MEditService.Core/" in fp else fp
        print(f"\n[{status}] {display_path}:{line} [{mutator}] {desc}\n{ctx}")

    sys.exit(1)


if __name__ == "__main__":
    main()
