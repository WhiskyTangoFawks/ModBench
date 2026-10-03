#!/usr/bin/env python3
"""Runs the frontend gates for a checkout. Exit 0 when every step passed, 1 otherwise."""
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NamedTuple, Optional

BUILD = 'Gate 5: Frontend build (type-check)'
UNIT = 'Gate 6: Frontend unit tests'


class Step(NamedTuple):
    name: str
    command: list
    after: Optional[str] = None


# Lint reads only sources, so it runs beside the build. Integration waits on the build because
# both write out/extension.js.
def steps(results: Path):
    return [
        Step('Gate 4: Frontend lint', ['npm', 'run', 'lint']),
        Step(BUILD, ['npm', 'run', 'build']),
        Step(UNIT, ['npm', 'run', 'test:unit', '--', '--reporter=basic', '--reporter=json',
                    f'--outputFile.json={results / "unit.json"}'], after=BUILD),
        Step('Gate 6: Frontend unit test times',
             [sys.executable, str(Path(__file__).with_name('check_test_times.py')), str(results)], after=UNIT),
        Step('Gate 6: Frontend integration tests', ['npm', 'run', 'test:integration'], after=BUILD),
    ]


def run(steps, cwd: Path):
    """Each step starts once the step it names after passed, or at once when it names none, and
    prints its whole output under its header when it ends."""
    printing = threading.Lock()

    def one(step, after):
        if after is not None and not after.result():
            return False
        start = time.monotonic()
        done = subprocess.run(step.command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, check=False)
        with printing:
            print(f'=== {step.name} ({time.monotonic() - start:.0f} s) ===')
            print(done.stdout, end='')
            if done.returncode:
                print(f'--- {step.name.upper()} FAILED ---')
            sys.stdout.flush()
        return done.returncode == 0

    futures = {}
    with ThreadPoolExecutor(len(steps)) as pool:
        for step in steps:
            futures[step.name] = pool.submit(one, step, futures.get(step.after))
    return all(future.result() for future in futures.values())


def main(argv=None):
    root = Path((sys.argv[1:] if argv is None else argv)[0])
    results = Path(tempfile.gettempdir()) / f'medit-unit-results.{root.name}'
    shutil.rmtree(results, ignore_errors=True)
    results.mkdir()
    return 0 if run(steps(results), root / 'modbench') else 1


if __name__ == '__main__':
    sys.exit(main())
