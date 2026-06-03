#!/usr/bin/env python3
"""
Run Stryker.NET mutation tests scoped to files changed in the working tree.

Usage (from MEditService/):
  python stryker-report.py          # auto-scope from git diff
  python stryker-report.py --all    # scope to all of MEditService.Core

The script:
  1. Determines scope from git diff (staged + unstaged changes vs HEAD,
     plus any commits ahead of main)
  2. Patches stryker-config.json with the computed mutate list
  3. Runs `dotnet stryker`
  4. Restores stryker-config.json (always, even on failure)
  5. Prints a structured report: summary + each survivor/NoCoverage with
     source context and suppression snippet
  6. Exits 0 if all mutants killed, 1 if any survivors or NoCoverage remain
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
def patched_config(config_path: Path, repo_root: Path, mutate: list[str], mutant_ids: list[int] | None = None):
    """Temporarily patch stryker-config.json, restore to HEAD on exit."""
    original = committed_config(config_path, repo_root)
    config = json.loads(original)
    config["stryker-config"]["mutate"] = mutate
    if mutant_ids:
        config["stryker-config"]["mutant-id"] = mutant_ids
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    try:
        yield
    finally:
        config_path.write_text(original)


def changed_names(repo_root: Path, extra_args: list[str]) -> set[str]:
    r = subprocess.run(
        ["git", "diff", "--name-only"] + extra_args,
        capture_output=True, text=True, cwd=repo_root,
    )
    return set(r.stdout.splitlines()) if r.returncode == 0 else set()


def compute_mutate_scope(repo_root: Path) -> list[str]:
    """Return mutate globs for all Core .cs files touched since main or in the working tree."""
    all_changed: set[str] = set()
    all_changed |= changed_names(repo_root, [])              # unstaged vs HEAD
    all_changed |= changed_names(repo_root, ["--cached"])    # staged vs HEAD
    all_changed |= changed_names(repo_root, ["main...HEAD"]) # commits ahead of main

    marker = "MEditService.Core/"
    core_files = [f for f in all_changed if marker in f and f.endswith(".cs")]
    if not core_files:
        print("WARNING: no Core files found in diff — falling back to full Core scan (slow)")
        return FALLBACK_MUTATE

    patterns: set[str] = set()
    for f in core_files:
        idx = f.find(marker)
        rel = f[idx + len(marker):]
        patterns.add(f"**/{rel}")

    return sorted(patterns)


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
        print(f"  Suppression:  // Stryker disable once {mutator}: <reason>")
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

    if mutant_ids:
        mutate = FALLBACK_MUTATE
    elif use_all:
        mutate = FALLBACK_MUTATE
    else:
        mutate = compute_mutate_scope(repo_root)

    print("=" * 70)
    if mutant_ids:
        print(f"TARGETED RUN — mutant IDs: {', '.join(str(i) for i in mutant_ids)}")
    else:
        print("MUTATION SCOPE")
    print("=" * 70)
    for p in mutate:
        print(f"  {p}")

    config_path = base_dir / "stryker-config.json"

    print(f"\n{'=' * 70}")
    if mutant_ids:
        print("Running Stryker.NET  (initial test run ~60s, then targeted mutation phase)")
    else:
        print("Running Stryker.NET  (initial test run ~60s, then mutation phase)")
    print("=" * 70)
    sys.stdout.flush()

    run_start = time.time()

    with patched_config(config_path, repo_root, mutate, mutant_ids=mutant_ids):
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
    ignored = 0
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
            elif status == "Ignored":
                ignored += 1

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
