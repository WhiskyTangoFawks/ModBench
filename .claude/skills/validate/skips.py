#!/usr/bin/env python3
"""Reads the test reports under a directory (see reports.py) and names every test that skipped.
Exit 0 when none did, 1 otherwise."""
import sys
from pathlib import Path

import reports


def skipped(directory: Path) -> list[str]:
    return [result.name for result in reports.results(directory) if result.outcome == 'skipped']


def main(argv: list[str] | None = None) -> int:
    (directory,) = sys.argv[1:] if argv is None else argv
    names = skipped(Path(directory))
    for name in names:
        print(f'skipped  {name}')
    if names:
        print(f'--- {len(names)} TESTS SKIPPED ---')
    return 1 if names else 0


if __name__ == '__main__':
    sys.exit(main())
