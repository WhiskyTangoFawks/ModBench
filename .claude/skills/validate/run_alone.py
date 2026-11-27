#!/usr/bin/env python3
"""Runs again, one at a time and away from the gates' load, each test the reports time over the 1 s
ceiling, and writes that run's reports to a folder of its own for check_test_times.py. An xUnit theory runs
all its cases. The integration tests already run one at a time, in one VS Code, so none runs again."""
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

BACKEND = 'MEditService.'
INTEGRATION = 'integration'
UNITTEST_FOLDERS = {'validate': '.claude/skills/validate', 'hooks': '.claude/hooks', 'scripts': 'scripts'}
UNITTEST_ID = re.compile(r'\((\S+)\)$')
VITEST_NAME = ' > '


class Command(NamedTuple):
    folder: Path
    argv: list[str]
    log: Path | None = None


def theory(name: str) -> str:
    return name.split('(', 1)[0]


def commands(root: Path, alone: Path, results: list[reports.Result]) -> list[Command]:
    """A box's tests run in one process each: a backend project's, a unittest folder's, and every vitest file's."""
    over: dict[str, set[str]] = {}
    for result in results:
        if result.seconds is not None and result.seconds > CEILING_SECONDS and result.box != INTEGRATION:
            over.setdefault(result.box, set()).add(result.name)
    found: list[Command] = []
    vitest: set[str] = set()
    for box, names in sorted(over.items()):
        if box.startswith(BACKEND):
            methods = '|'.join(f'FullyQualifiedName={method}' for method in sorted({theory(name) for name in names}))
            found.append(Command(root / 'MEditService', [
                'dotnet', 'test', box, '--no-build', '-v', 'quiet', '--logger', 'trx', '--results-directory',
                str(alone / 'backend'), '--filter', methods, '--', 'xUnit.ParallelizeTestCollections=false']))
        elif box in UNITTEST_FOLDERS:
            ids = sorted(match[1] for name in names if (match := UNITTEST_ID.search(name)))
            found.append(Command(root / UNITTEST_FOLDERS[box], ['python3', '-m', 'unittest', '-v', '--durations', '0', *ids],
                                 alone / f'{box}.unittest'))
        else:
            vitest |= names
    if vitest:
        files = sorted({f'/{name.split(VITEST_NAME, 1)[0]}' for name in vitest})
        pattern = '|'.join(re.escape(name.split(VITEST_NAME, 1)[1]) for name in sorted(vitest))
        found.append(Command(root / 'modbench', [
            'npx', 'vitest', 'run', '--no-file-parallelism', '--reporter=json', f'--outputFile.json={alone / "unit.json"}',
            '-t', f'^({pattern})$', *files]))
    return found


def main(argv: list[str] | None = None) -> int:
    """The gates' own tests start runs of the gates, which are branch runs."""
    root, directory, alone = map(Path, sys.argv[1:] if argv is None else argv)
    alone.mkdir(parents=True, exist_ok=True)
    environment = {key: value for key, value in os.environ.items() if key != 'MEDIT_MERGE_TO_MAIN'}
    failed = False
    start = time.monotonic()
    found = commands(root, alone, reports.results(directory))
    for command in found:
        with contextlib.ExitStack() as stack:
            log = stack.enter_context(command.log.open('w')) if command.log else None
            done = subprocess.run(command.argv, cwd=command.folder, env=environment, stdout=log,
                                  stderr=subprocess.STDOUT if log else None, check=False)
        if done.returncode:
            print(f'Failed alone, exit {done.returncode}: {" ".join(command.argv)}')
            failed = True
    print(f'Again alone: {len(found)} runs in {time.monotonic() - start:.0f} s')
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
