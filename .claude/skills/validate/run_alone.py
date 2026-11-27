#!/usr/bin/env python3
"""Runs again, one at a time and after the gates' other tests, each test the reports time over the 1 s ceiling,
and writes that run's reports to a folder of its own for check_test_times.py. An xUnit theory runs all its
cases. An integration test does not run again: modbench's integration runner passes no test filter through."""
import contextlib
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

import reports
from check_test_times import CEILING_SECONDS

UNITTEST_FOLDERS = {'validate': '.claude/skills/validate', 'hooks': '.claude/hooks', 'scripts': 'scripts'}
UNITTEST_ID = re.compile(r'\((\S+)\)$')
RETRIES = 2
# The gates' own tests start runs of the gates, which are branch runs.
MERGE_TO_MAIN = 'MEDIT_MERGE_TO_MAIN'


class Command(NamedTuple):
    folder: Path
    argv: list[str]
    log: Path | None = None


def method_of(name: str) -> str:
    return name.split('(', 1)[0]


def over_ceiling(results: list[reports.Result]) -> dict[str, set[str]]:
    """The names of each box's tests over the ceiling."""
    boxes: dict[str, set[str]] = {}
    for result in results:
        if result.seconds is not None and result.seconds > CEILING_SECONDS:
            boxes.setdefault(result.box, set()).add(result.name)
    return boxes


def backend(root: Path, box: str, report: Path, methods: list[str]) -> Command:
    return Command(root / 'MEditService', [
        'dotnet', 'test', box, '--no-build', '-v', 'quiet', '--logger', f'trx;LogFileName={report.name}',
        '--results-directory', str(report.parent),
        '--filter', '|'.join(f'FullyQualifiedName={method}' for method in methods), '--', 'xUnit.ParallelizeTestCollections=false'])


def others(kinds: dict[str, list[reports.Result]], root: Path, alone: Path) -> list[Command]:
    """One process for each unittest folder, and one for every vitest file."""
    found: list[Command] = []
    for box, names in sorted(over_ceiling(kinds.get(reports.UNITTEST_REPORT, [])).items()):
        ids = sorted(match[1] for name in names if (match := UNITTEST_ID.search(name)))
        found.append(Command(root / UNITTEST_FOLDERS[box], ['python3', '-m', 'unittest', '-v', '--durations', '0', *ids],
                             alone / f'{box}.unittest'))
    vitest = sorted(name.split(reports.VITEST_SEPARATOR, 1) for names in over_ceiling(kinds.get(reports.VITEST_REPORT, [])).values()
                    for name in names)
    if vitest:
        pattern = '|'.join(re.escape(test) for _, test in vitest)
        found.append(Command(root / 'modbench', [
            'npx', 'vitest', 'run', '--no-file-parallelism', '--reporter=json', f'--outputFile.json={alone / "unit.json"}',
            '-t', f'^({pattern})$', *sorted({f'/{file}' for file, _ in vitest})]))
    return found


def first_over_ceiling(report: Path) -> str | None:
    """The method of the run's first test, when that test, which paid the process's warm-up, is over the ceiling."""
    if not report.exists():
        return None
    text = report.read_text(encoding='utf-8-sig')
    first = reports.ran_first(text)
    over = any(result.name == first and (result.seconds or 0) > CEILING_SECONDS for result in reports.in_trx(text))
    return method_of(first) if first and over else None


def class_of(method: str) -> str:
    return method.rsplit('.', 1)[0]


def run_again(root: Path, directory: Path, alone: Path, execute: Callable[[Command], bool]) -> bool:
    """Whether every run passed. A backend project's tests run in one process; the first, if over the ceiling, runs
    again beside a test of another class, another of them or else the project's fastest, until another runs first.
    xUnit orders a run's collections at random but a collection's tests always alike, and a class is a collection
    unless it names one."""
    kinds = reports.by_kind(directory)
    loaded = kinds.get(reports.TRX_REPORT, [])
    passed = True
    for box, names in sorted(over_ceiling(loaded).items()):
        methods = sorted({method_of(name) for name in names})
        fastest = [method_of(result.name) for result in sorted(
            (result for result in loaded if result.box == box and result.seconds is not None and method_of(result.name) not in methods),
            key=lambda result: result.seconds or 0)]
        report = alone / 'backend' / box / '0.trx'
        passed &= execute(backend(root, box, report, methods))
        for attempt in range(1, RETRIES + 1):
            first = first_over_ceiling(report)
            if first not in methods:
                break
            beside = next((method for method in methods + fastest if class_of(method) != class_of(first)), None)
            if beside is None:
                break
            report = report.with_name(f'{attempt}.trx')
            passed &= execute(backend(root, box, report, [first, beside]))
    for command in others(kinds, root, alone):
        passed &= execute(command)
    return passed


def main(argv: list[str] | None = None) -> int:
    root, directory, alone = map(Path, sys.argv[1:] if argv is None else argv)
    environment = {key: value for key, value in os.environ.items() if key != MERGE_TO_MAIN}

    def execute(command: Command) -> bool:
        with command.log.open('w') if command.log else contextlib.nullcontext() as log:
            done = subprocess.run(command.argv, cwd=command.folder, env=environment, stdout=log,
                                  stderr=subprocess.STDOUT if log else None, check=False)
        if done.returncode:
            print(f'Failed alone, exit {done.returncode}: {" ".join(command.argv)}')
        return done.returncode == 0

    alone.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    passed = run_again(root, directory, alone, execute)
    print(f'Again alone: {time.monotonic() - start:.0f} s')
    return int(not passed)


if __name__ == '__main__':
    sys.exit(main())
