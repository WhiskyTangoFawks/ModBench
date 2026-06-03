#!/usr/bin/env python3
"""
Run Stryker.NET mutation tests against MEditService.Core.

Usage (from MEditService/):
  python stryker-report.py          # scope to files changed since main (via stryker-config since)
  python stryker-report.py --all    # scope to all of MEditService.Core
  python stryker-report.py --mutant-ids 42 57  # rerun specific mutant IDs

The script:
  1. Runs `dotnet stryker` (--all and --mutant-ids temporarily patch the config)
  2. Prints a structured report: summary + each survivor/NoCoverage with
     source context and suppression snippet
  3. Exits 0 if all mutants killed, 1 if any survivors or NoCoverage remain
"""

import contextlib
import glob
import json
import os
import subprocess
import sys
import time
from pathlib import Path


FALLBACK_MUTATE = ["**/MEditService.Core/**/*.cs"]


def committed_config(config_path: Path, repo_root: Path) -> str:
    """Return the committed (HEAD) text of stryker-config.json via git."""
    rel = config_path.relative_to(repo_root)
    r = subprocess.run(
        ["git", "show", f"HEAD:{rel}"],
        capture_output=True, text=True, cwd=repo_root,
    )
    if r.returncode != 0:
        raise RuntimeError(f"Could not read committed config: {r.stderr.strip()}")
    return r.stdout


@contextlib.contextmanager
def patched_config(config_path: Path, repo_root: Path, *, mutant_ids: list[int] | None = None):
    """Temporarily patch stryker-config.json to disable since and optionally pin mutant IDs, restore to HEAD on exit."""
    original = committed_config(config_path, repo_root)
    config = json.loads(original)
    config["stryker-config"]["since"] = {"enabled": False}
    if mutant_ids:
        config["stryker-config"]["mutant-id"] = mutant_ids
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    try:
        yield
    finally:
        config_path.write_text(original)


def find_latest_report(base_dir: Path) -> str | None:
    pattern = str(base_dir / "StrykerOutput" / "**" / "mutation-report.json")
    reports = glob.glob(pattern, recursive=True)
    return max(reports, key=os.path.getmtime) if reports else None


def source_context(source_lines: list[str], start_line: int, end_line: int, context: int = 3) -> str:
    total = len(source_lines)
    first = max(0, start_line - 1 - context)
    last = min(total, end_line + context)
    parts = []
    for i in range(first, last):
        marker = ">>>" if (start_line - 1) <= i <= (end_line - 1) else "   "
        parts.append(f"{marker} {i + 1:4d}: {source_lines[i].rstrip()}")
    return "\n".join(parts)


def print_mutants(label: str, items: list) -> None:
    if not items:
        return
    print(f"\n{'=' * 70}")
    print(f"{label}  ({len(items)})")
    print("=" * 70)
    for file_path, mutant, source_lines in items:
        loc = mutant.get("location", {})
        start_line = loc.get("start", {}).get("line", 1)
        end_line = loc.get("end", {}).get("line", start_line)
        mutator = mutant.get("mutatorName", "?")
        description = mutant.get("description", mutant.get("replacement", "?"))
        mutant_id = mutant.get("id", "?")

        print(f"\n  [{mutant_id}]  {file_path}  line {start_line}")
        print(f"  Mutator:      {mutator}")
        print(f"  Mutation:     {description}")
        print(f"\n  Code:")
        for line in source_context(source_lines, start_line, end_line).split("\n"):
            print(f"    {line}")


def main() -> None:
    use_all = "--all" in sys.argv
    mutant_ids: list[int] = []
    args = sys.argv[1:]
    if "--mutant-ids" in args:
        idx = args.index("--mutant-ids")
        raw = args[idx + 1:]
        for v in raw:
            if v.startswith("--"):
                break
            try:
                mutant_ids.append(int(v))
            except ValueError:
                print(f"ERROR: --mutant-ids expects integers, got {v!r}", file=sys.stderr)
                sys.exit(2)
        if not mutant_ids:
            print("ERROR: --mutant-ids requires at least one mutant ID", file=sys.stderr)
            sys.exit(2)

    base_dir = Path(next((a for a in args if not a.startswith("--")), ".")).resolve()
    r = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, cwd=base_dir,
    )
    if r.returncode != 0:
        print("ERROR: not inside a git repository", file=sys.stderr)
        sys.exit(2)
    repo_root = Path(r.stdout.strip())

    config_path = base_dir / "stryker-config.json"

    print("=" * 70)
    if mutant_ids:
        print(f"TARGETED RUN — mutant IDs: {', '.join(str(i) for i in mutant_ids)}")
    elif use_all:
        print("SCOPE: all of MEditService.Core")
    else:
        print("SCOPE: files changed since main  (Stryker since)")
    print("=" * 70)

    print(f"\n{'=' * 70}")
    if mutant_ids:
        print("Running Stryker.NET  (initial test run ~60s, then targeted mutation phase)")
    else:
        print("Running Stryker.NET  (initial test run ~60s, then mutation phase)")
    print("=" * 70)
    sys.stdout.flush()

    run_start = time.time()

    need_patch = use_all or bool(mutant_ids)
    ctx = patched_config(config_path, repo_root, mutant_ids=mutant_ids) \
        if need_patch else contextlib.nullcontext()

    with ctx:
        subprocess.run(
            ["dotnet", "stryker", "--config-file", "stryker-config.json"],
            cwd=base_dir,
            check=False,
        )

    report_path = find_latest_report(base_dir)
    if not report_path:
        print("\nERROR: mutation-report.json not found — did Stryker fail to start?", file=sys.stderr)
        sys.exit(2)

    if os.path.getmtime(report_path) < run_start:
        print("\nERROR: report predates this run — Stryker likely crashed before writing results.", file=sys.stderr)
        sys.exit(2)

    with open(report_path) as f:
        report = json.load(f)

    survivors: list = []
    no_coverage: list = []
    killed = 0
    compile_errors = 0

    for file_path, file_data in report.get("files", {}).items():
        source_lines = file_data.get("source", "").splitlines()
        for mutant in file_data.get("mutants", []):
            status = mutant.get("status", "")
            if status == "Killed":
                killed += 1
            elif status == "Survived":
                survivors.append((file_path, mutant, source_lines))
            elif status == "NoCoverage":
                no_coverage.append((file_path, mutant, source_lines))
            elif status == "CompileError":
                compile_errors += 1

    effective = killed + len(survivors) + len(no_coverage)
    score = (killed / effective * 100) if effective > 0 else 0.0

    print(f"\n{'=' * 70}")
    print("MUTATION REPORT SUMMARY")
    print("=" * 70)
    print(f"  Killed:        {killed}")
    print(f"  Survived:      {len(survivors)}")
    print(f"  NoCoverage:    {len(no_coverage)}")
    print(f"  CompileErrors: {compile_errors}  (expected noise — see known issues in mutation-test skill)")
    print(f"  Score:         {score:.1f}%  (over {effective} effective mutants)")

    if not survivors and not no_coverage:
        print("\n[PASS] All mutants killed. No action needed.")
        sys.exit(0)

    print_mutants("SURVIVORS — require triage", survivors)
    print_mutants("NO COVERAGE — no test exercises this code at all", no_coverage)

    print(f"\n{'=' * 70}")
    print("[ACTION REQUIRED] Triage every item above before declaring done.")
    sys.exit(1)


if __name__ == "__main__":
    main()
