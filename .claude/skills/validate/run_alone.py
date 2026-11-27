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
from pathlib import Path
from typing import NamedTuple

import reports
from check_test_times import CEILING_SECONDS

UNITTEST_FOLDERS = {'validate': '.claude/skills/validate', 'hooks': '.claude/hooks', 'scripts': 'scripts'}
UNITTEST_ID = re.compile(r'\((\S+)\)$')
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


def commands(root: Path, alone: Path, kinds: dict[str, list[reports.Result]]) -> list[Command]:
    """One process for each backend project and each unittest folder, and one for every vitest file."""
    found: list[Command] = []
    for box, names in sorted(over_ceiling(kinds.get('.trx', [])).items()):
        methods = '|'.join(f'FullyQualifiedName={method}' for method in sorted({method_of(name) for name in names}))
        found.append(Command(root / 'MEditService', [
            'dotnet', 'test', box, '--no-build', '-v', 'quiet', '--logger', 'trx', '--results-directory', str(alone / 'backend'),
            '--filter', methods, '--', 'xUnit.ParallelizeTestCollections=false']))
    for box, names in sorted(over_ceiling(kinds.get('.unittest', [])).items()):
        ids = sorted(match[1] for name in names if (match := UNITTEST_ID.search(name)))
        found.append(Command(root / UNITTEST_FOLDERS[box], ['python3', '-m', 'unittest', '-v', '--durations', '0', *ids],
                             alone / f'{box}.unittest'))
    vitest = sorted(name.split(reports.VITEST_SEPARATOR, 1) for names in over_ceiling(kinds.get('.json', [])).values()
                    for name in names)
    if vitest:
        pattern = '|'.join(re.escape(test) for _, test in vitest)
        found.append(Command(root / 'modbench', [
            'npx', 'vitest', 'run', '--no-file-parallelism', '--reporter=json', f'--outputFile.json={alone / "unit.json"}',
            '-t', f'^({pattern})$', *sorted({f'/{file}' for file, _ in vitest})]))
    return found


def main(argv: list[str] | None = None) -> int:
    root, directory, alone = map(Path, sys.argv[1:] if argv is None else argv)
    alone.mkdir(parents=True, exist_ok=True)
    environment = {key: value for key, value in os.environ.items() if key != MERGE_TO_MAIN}
    failed = False
    start = time.monotonic()
    found = commands(root, alone, reports.by_kind(directory))
    for command in found:
        with command.log.open('w') if command.log else contextlib.nullcontext() as log:
            done = subprocess.run(command.argv, cwd=command.folder, env=environment, stdout=log,
                                  stderr=subprocess.STDOUT if log else None, check=False)
        if done.returncode:
            print(f'Failed alone, exit {done.returncode}: {" ".join(command.argv)}')
            failed = True
    print(f'Again alone: {len(found)} runs in {time.monotonic() - start:.0f} s')
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
