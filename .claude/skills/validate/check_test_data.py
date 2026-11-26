#!/usr/bin/env python3
"""Names each file in a test-data folder (TestData, fixtures, goldens) over the size limit. It walks the
tree, because the Windows VM's copy has no .git. Reports only: exit 0."""
import os
import sys
from pathlib import Path

LIMIT_BYTES = 64 * 1024
TEST_DATA_FOLDERS = {'TestData', 'fixtures', 'goldens'}
NOT_SOURCE_FOLDERS = {'.git', '.vscode-test', 'node_modules', 'bin', 'obj', 'out', 'dist', 'references'}
FAILS_THE_RUN = False


def over_limit(root: Path) -> list[tuple[str, int]]:
    found = []
    for folder, subfolders, files in os.walk(root):
        subfolders[:] = [subfolder for subfolder in subfolders if subfolder not in NOT_SOURCE_FOLDERS]
        if TEST_DATA_FOLDERS.intersection(Path(folder).relative_to(root).parts):
            found += [(Path(folder, file).relative_to(root).as_posix(), Path(folder, file).stat().st_size) for file in files]
    return sorted(((name, size) for name, size in found if size > LIMIT_BYTES), key=lambda file: -file[1])


def main(argv: list[str] | None = None) -> int:
    root = Path((sys.argv[1:] if argv is None else argv)[0])
    over = over_limit(root)
    for name, size in over:
        print(f'{size / 1024:7.1f} KB  {name}')
    print(f'--- {len(over)} TEST DATA FILES OVER {LIMIT_BYTES // 1024} KB ---')
    return int(FAILS_THE_RUN and bool(over))


if __name__ == '__main__':
    sys.exit(main())
