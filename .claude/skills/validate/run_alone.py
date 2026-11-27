#!/usr/bin/env python3
"""Runs again, one at a time and after the gates' other tests, each test the reports time over the 1 s ceiling,
and writes that run's reports to a folder of its own for check_test_times.py. A branch run leaves out an approved
test, whose verdict the run cannot change; a merge run runs it too, for its lapse. An xUnit theory runs all its
cases."""
import contextlib
import os
import re
import subprocess
import sys
import time
import tomllib
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

import reports
from check_test_times import CEILING_SECONDS, MERGE, approval_of

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


def over_ceiling(results: list[reports.Result], chosen: Callable[[str], bool]) -> dict[str, set[str]]:
    """The names of each box's chosen tests over the ceiling."""
    boxes: dict[str, set[str]] = {}
    for result in results:
        if result.seconds is not None and result.seconds > CEILING_SECONDS and chosen(result.name):
            boxes.setdefault(result.box, set()).add(result.name)
    return boxes


def commands(kinds: dict[str, list[reports.Result]], root: Path, alone: Path, chosen: Callable[[str], bool]) -> list[Command]:
    """One process for each backend project and each unittest folder, one for every vitest file, and one VS Code."""
    found: list[Command] = []
    for box, names in sorted(over_ceiling(kinds.get(reports.TRX_REPORT, []), chosen).items()):
        methods = '|'.join(f'FullyQualifiedName={method}' for method in sorted({method_of(name) for name in names}))
        found.append(Command(root / 'MEditService', [
            'dotnet', 'test', box, '--no-build', '-v', 'quiet', '--logger', 'trx', '--results-directory', str(alone / 'backend'),
            '--filter', methods, '--', 'xUnit.ParallelizeTestCollections=false']))
    for box, names in sorted(over_ceiling(kinds.get(reports.UNITTEST_REPORT, []), chosen).items()):
        ids = sorted(match[1] for name in names if (match := UNITTEST_ID.search(name)))
        found.append(Command(root / UNITTEST_FOLDERS[box], ['python3', '-m', 'unittest', '-v', '--durations', '0', *ids],
                             alone / f'{box}.unittest'))
    vitest = sorted(name.split(reports.VITEST_SEPARATOR, 1)
                    for names in over_ceiling(kinds.get(reports.VITEST_REPORT, []), chosen).values() for name in names)
    if vitest:
        pattern = '|'.join(re.escape(test) for _, test in vitest)
        found.append(Command(root / 'modbench', [
            'npx', 'vitest', 'run', '--no-file-parallelism', '--reporter=json', f'--outputFile.json={alone / "unit.json"}',
            '-t', f'^({pattern})$', *sorted({f'/{file}' for file, _ in vitest})]))
    # Mocha matches a pattern against a test's suite and its title together, so the title ends it.
    integration = sorted(name for names in over_ceiling(kinds.get(reports.MOCHA_REPORT, []), chosen).values() for name in names)
    if integration:
        found.append(Command(root / 'modbench', ['node', 'integration.mjs', '--grep', f'({"|".join(map(re.escape, integration))})$'],
                             alone / 'integration.mocha'))
    return found


def execute(command: Command, environment: dict[str, str]) -> bool:
    if command.log:
        command.log.parent.mkdir(parents=True, exist_ok=True)
    with command.log.open('w') if command.log else contextlib.nullcontext() as log:
        done = subprocess.run(command.argv, cwd=command.folder, env=environment, stdout=log,
                              stderr=subprocess.STDOUT if log else None, check=False)
    if done.returncode:
        print(f'Failed alone, exit {done.returncode}: {" ".join(command.argv)}')
    return done.returncode == 0


def main(argv: list[str] | None = None) -> int:
    """A merge run also runs the approved tests over the ceiling, for their lapses, in processes of their own: a heavy
    approved test leaves nothing behind in an unapproved test's process."""
    root, directory, alone, budgets_file, run = sys.argv[1:] if argv is None else argv
    approved = tomllib.loads(Path(budgets_file).read_text()).get('approved', {})
    environment = {key: value for key, value in os.environ.items() if key != MERGE_TO_MAIN}
    start = time.monotonic()
    kinds = reports.by_kind(Path(directory))
    found = commands(kinds, Path(root), Path(alone), lambda name: approval_of(name, approved) is None)
    if run == MERGE:
        found += commands(kinds, Path(root), Path(alone) / 'approved', lambda name: approval_of(name, approved) is not None)
    passed = all([execute(command, environment) for command in found])
    print(f'Again alone: {len(found)} runs in {time.monotonic() - start:.0f} s')
    return int(not passed)


if __name__ == '__main__':
    sys.exit(main())
