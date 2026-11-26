#!/usr/bin/env python3
"""Reads the test reports under a directory (see reports.py), names each test that took over a
second, and prints the run's wall time against its budget. Reports only: exit 0 once the reports
are read."""
import sys
from pathlib import Path

import reports

CEILING = 1


def over_ceiling(directory: Path) -> list[tuple[str, float]]:
    return sorted(((result.name, result.seconds) for result in reports.results(directory)
                   if result.seconds is not None and result.seconds > CEILING),
                  key=lambda over: -over[1])


def main(argv: list[str] | None = None) -> int:
    directory, elapsed, budget = (sys.argv[1:] if argv is None else argv)
    elapsed, budget = float(elapsed), float(budget)
    over = over_ceiling(Path(directory))
    for name, time in over:
        print(f'{time:7.1f} s  {name}')
    print(f'--- {len(over)} TESTS OVER {CEILING} s ---')
    late = f': OVER BUDGET by {elapsed - budget:.0f} s' if elapsed > budget else ''
    print(f'Wall time {elapsed:.0f} s of {budget:.0f} s budget{late}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
