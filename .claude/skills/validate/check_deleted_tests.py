#!/usr/bin/env python3
"""Names each test the branch deletes that no trailer accounts for, and each trailer whose survivor is no test
at the tip (CODING_STANDARDS.md § Tests, "A diff deletes a test"). A deleted test is a name the merge base holds
more often than HEAD, so a moved test is not one. A trailer in any commit since the base accounts for it:

    Deleted-test: <deleted> => <survivor>
    Deleted-test: <deleted> => mark: <the start of a mark in CODING_STANDARDS.md>

A name is a C# method's under an attribute that ends in Fact or Theory, a TypeScript it or test title as written, or a Python test_ method's."""
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

KEY = 'Deleted-test'
ARROW = ' => '
MARK = 'mark: '
STANDARDS = 'CODING_STANDARDS.md'
STRING = r'''(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)'''
CS_ATTRIBUTE = re.compile(r'\[\w*(?:Fact|Theory)\b')
CS_METHOD = re.compile(r'^\s*public\b[^\n(=]*?(?P<name>\w+)\s*(?:<[^>\n]*>)?\s*\(', re.MULTILINE)
TS_TITLE = re.compile(r'(?<![\w.$])(?:it|test)(?:\.(?:only|skip|todo|concurrent|fails))*\s*\(\s*' + STRING
                      + r'|(?<![\w.$])(?:it|test)\.each\b.*?\)\s*\(\s*' + STRING, re.DOTALL)
PY_METHOD = re.compile(r'^\s*(?:async\s+)?def\s+(test_\w+)\s*\(', re.MULTILINE)
ESCAPE = re.compile(r'\\(.)')
TS_FILE = re.compile(r'\.test\.[cm]?[jt]sx?$')
PY_FILE = re.compile(r'(?:^|/)test_[^/]*\.py$')


def git(repo: Path, *args: str) -> str:
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


def names_in(path: str, text: str) -> list[str]:
    if path.endswith('.cs'):
        return [method['name'] for attribute in CS_ATTRIBUTE.finditer(text)
                if (method := CS_METHOD.search(text, attribute.end()))]
    if TS_FILE.search(path):
        return [ESCAPE.sub(r'\1', next(group for group in title.groups() if group is not None))
                for title in TS_TITLE.finditer(text)]
    return PY_METHOD.findall(text)


def test_names(repo: Path, rev: str) -> Counter[str]:
    paths = [path for path in git(repo, 'ls-tree', '-r', '-z', '--name-only', rev).split('\0')
             if path.endswith('.cs') or TS_FILE.search(path) or PY_FILE.search(path)]
    blobs = subprocess.run(['git', '-C', str(repo), 'cat-file', '--batch'], check=True, capture_output=True,
                           input=''.join(f'{rev}:{path}\n' for path in paths).encode()).stdout
    names: Counter[str] = Counter()
    offset = 0
    for path in paths:
        header_end = blobs.index(b'\n', offset)
        size = int(blobs[offset:header_end].split()[2])
        names.update(names_in(path, blobs[header_end + 1:header_end + 1 + size].decode(errors='replace')))
        offset = header_end + 1 + size + 1
    return names


def problems(repo: Path, base: str) -> list[str]:
    merge_base = git(repo, 'merge-base', base, 'HEAD').strip()
    at_tip = test_names(repo, 'HEAD')
    deleted = test_names(repo, merge_base) - at_tip
    marks = [line[2:] for line in git(repo, 'show', f'HEAD:{STANDARDS}').splitlines() if line.startswith('- ')]
    trailers = git(repo, 'log', f'--format=%(trailers:key={KEY},valueonly,unfold)', f'{merge_base}..HEAD').splitlines()
    found: list[str] = []
    named: set[str] = set()
    for trailer in filter(None, trailers):
        gone, arrow, survivor = trailer.partition(ARROW)
        mark = survivor.removeprefix(MARK) if survivor.startswith(MARK) else None
        if not arrow:
            found.append(f"{KEY}: {trailer}: reads '<deleted>{ARROW}<survivor>' or '<deleted>{ARROW}{MARK}<mark>'")
            continue
        named.add(gone)
        if mark is not None and not any(line.startswith(mark) for line in marks):
            found.append(f'{trailer}: no mark in {STANDARDS} begins so')
        elif mark is None and not at_tip[survivor]:
            found.append(f'{trailer}: the survivor is no test at the tip')
    found += [f"{name}: deleted, and no '{KEY}:' trailer names it" for name in sorted(deleted) if name not in named]
    return found


def main(argv: list[str] | None = None) -> int:
    repo, base = sys.argv[1:] if argv is None else argv
    found = problems(Path(repo), base)
    for finding in found:
        print(finding)
    print(f'--- {len(found)} FINDINGS ON DELETED TESTS ---')
    return int(bool(found))


if __name__ == '__main__':
    sys.exit(main())
