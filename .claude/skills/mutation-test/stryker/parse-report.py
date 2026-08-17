#!/usr/bin/env python3
"""
Parse the latest (or a given) Stryker mutation-report.json and print only
Survived and NoCoverage mutants with source context.

Usage (from MEditService/ for .NET reports, modbench/ for StrykerJS reports):
  python ../.claude/skills/mutation-test/stryker/parse-report.py
  python ../.claude/skills/mutation-test/stryker/parse-report.py path/to/mutation-report.json
  python ../.claude/skills/mutation-test/stryker/parse-report.py --diff-only
  python ../.claude/skills/mutation-test/stryker/parse-report.py --diff-only --target main

--diff-only narrows the report (which the runners scope at the *file* level,
mutating every testable line in any touched file) down to survivors whose lines
actually intersect the git diff against --target (default: stryker-config.json's
since.target). Use it to check "did my diff introduce anything new" without
re-running Stryker; the unfiltered report remains the full-file entropy audit.

Exit 0 if all mutants killed, 1 if any Survived/NoCoverage remain, 2 on error —
including a report in which nothing was actually tested (see audit_or_die).
"""

import argparse
import collections
import glob
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Statuses that mean a mutant was actually put in front of the suite (or found to
# have no test in front of it at all). Everything else — Ignored, CompileError —
# means the mutant was never an observation.
AUDITED_STATUSES = ("Killed", "Survived", "Timeout", "NoCoverage")


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
            loc = m["location"]
            sl, sc = loc["start"]["line"], loc["start"]["column"]
            el, ec = loc["end"]["line"], loc["end"]["column"]
            if diff_only and not mutant_survives_diff(fp, sl, el, repo_root, target, diff_cache):
                continue
            results.append((status, fp, sl, sc, el, ec, m.get("mutatorName", "?"),
                            m.get("description", m.get("replacement", "?")),
                            source_context(src, sl, el)))
    return total, results


def audit_or_die(data: dict, report_path: Path) -> None:
    """A report in which no mutant was tested is a mis-scope, not a pass.

    This is the exact shape of #362: Stryker filtered all 5334 candidates out and
    exited 0, and "No issues found." read as a clean bill of health. Zero audited
    mutants must therefore be louder than any survivor, never quieter."""
    statuses = collections.Counter()
    reasons = collections.Counter()
    for fd in data.get("files", {}).values():
        for m in fd.get("mutants", []):
            status = m.get("status", "?")
            statuses[status] += 1
            if status == "Ignored":
                reasons[m.get("statusReason") or "(no reason given)"] += 1

    if sum(statuses[s] for s in AUDITED_STATUSES):
        return

    print(f"ERROR: nothing was audited — 0 of {sum(statuses.values())} mutants in "
          f"{report_path} were tested, so this run says nothing about the suite. "
          f"It is a mis-scope, not a clean pass.", file=sys.stderr)
    for status, count in statuses.most_common():
        print(f"  {count:6d}  {status}", file=sys.stderr)
    for reason, count in reasons.most_common(5):
        print(f"  {count:6d}  Ignored: {reason}", file=sys.stderr)
    print("Re-scope the run — name the files with --file, or check the diff target "
          "resolves against this working tree.", file=sys.stderr)
    sys.exit(2)


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

    audit_or_die(data, report_path)

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

    print("Location is file:line:startcol-endcol — the span is what distinguishes several "
          "mutants sharing one line and mutator. The value after the mutator is the "
          "REPLACEMENT Stryker substituted, NOT the original source; read the original "
          "from the file before calling anything equivalent.")

    for status, fp, sl, sc, el, ec, mutator, desc, ctx in results:
        display_path = fp.split("MEditService.Core/")[-1] if "MEditService.Core/" in fp else fp
        span = f"{sl}:{sc}-{ec}" if sl == el else f"{sl}:{sc}-{el}:{ec}"
        print(f"\n[{status}] {display_path}:{span} [{mutator}] {desc}\n{ctx}")

    sys.exit(1)


if __name__ == "__main__":
    main()
