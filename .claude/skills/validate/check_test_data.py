#!/usr/bin/env python3
"""Names each committed file in a test-data folder (TestData, fixtures, goldens) over the size limit.
Reports only: exit 0."""
import subprocess
import sys
from pathlib import Path

LIMIT_BYTES = 64 * 1024
TEST_DATA_FOLDERS = {'TestData', 'fixtures', 'goldens'}
FAILS_THE_RUN = False


def over_limit(root: Path) -> list[tuple[str, int]]:
    tracked = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], check=True, capture_output=True, text=True).stdout
    sizes = ((name, (root / name).stat().st_size) for name in tracked.split('\0')
             if name and TEST_DATA_FOLDERS.intersection(name.split('/')[:-1]) and (root / name).is_file())
    return sorted(((name, size) for name, size in sizes if size > LIMIT_BYTES), key=lambda over: -over[1])


def main(argv: list[str] | None = None) -> int:
    root = Path((sys.argv[1:] if argv is None else argv)[0])
    over = over_limit(root)
    for name, size in over:
        print(f'{size / 1024:7.1f} KB  {name}')
    print(f'--- {len(over)} TEST DATA FILES OVER {LIMIT_BYTES // 1024} KB ---')
    return int(FAILS_THE_RUN and bool(over))


if __name__ == '__main__':
    sys.exit(main())
