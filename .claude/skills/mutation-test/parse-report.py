#!/usr/bin/env python3
"""
Parse the latest (or a given) Stryker mutation-report.json and print only
Survived and NoCoverage mutants with source context.

Usage (from MEditService/):
  python ../.claude/skills/mutation-test/parse-report.py
  python ../.claude/skills/mutation-test/parse-report.py path/to/mutation-report.json

Exit 0 if all mutants killed, 1 if any Survived/NoCoverage remain, 2 on error.
"""

import glob
import json
import os
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


def main() -> None:
    if len(sys.argv) > 1:
        report_path = Path(sys.argv[1])
        if not report_path.exists():
            print(f"ERROR: {report_path} not found", file=sys.stderr)
            sys.exit(2)
    else:
        report_path = find_latest_report(Path("."))
        if not report_path:
            print("ERROR: no mutation-report.json found under StrykerOutput/", file=sys.stderr)
            sys.exit(2)

    with open(report_path) as f:
        data = json.load(f)

    results = []
    for fp, fd in data.get("files", {}).items():
        src = fd.get("source", "").splitlines()
        for m in fd.get("mutants", []):
            status = m.get("status", "")
            if status in ("Survived", "NoCoverage"):
                sl = m["location"]["start"]["line"]
                el = m["location"]["end"]["line"]
                results.append((status, fp, sl, m.get("mutatorName", "?"),
                                m.get("description", m.get("replacement", "?")),
                                source_context(src, sl, el)))

    if not results:
        print("No issues found.")
        sys.exit(0)

    for status, fp, line, mutator, desc, ctx in results:
        display_path = fp.split("MEditService.Core/")[-1] if "MEditService.Core/" in fp else fp
        print(f"\n[{status}] {display_path}:{line} [{mutator}] {desc}\n{ctx}")

    sys.exit(1)


if __name__ == "__main__":
    main()
