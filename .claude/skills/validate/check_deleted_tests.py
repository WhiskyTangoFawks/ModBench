#!/usr/bin/env python3
"""Names each test deleted since the base that no trailer accounts for, each trailer of a deleted test that
resolves to nothing, and each trailer without its arrow (CODING_STANDARDS.md § Tests, "A diff deletes a test").
A deleted test is a name the merge base holds more often than HEAD, so a moved test is not one. The trailers of
the commits since the base account for it when one of them names a test at HEAD, or a mark of § Tests at HEAD
or at the merge base, so a mark the branch retires to a gate still holds, by its words before the first colon,
full stop or arrow:

    Deleted-test: <deleted> => <survivor>
    Deleted-test: <deleted> => mark: <mark>

A name is a C# method's under an attribute that ends in Fact or Theory, a TypeScript it or test title as written,
or a Python test_ method's."""
import re
import subprocess
import sys
from collections import Counter
from collections.abc import Callable
from pathlib import Path

KEY = 'Deleted-test'
ARROW = ' => '
MARK = 'mark: '
FORM = f"'{KEY}: <deleted>{ARROW}<survivor>' or '{KEY}: <deleted>{ARROW}{MARK}<mark>'"
STANDARDS = 'CODING_STANDARDS.md'
TESTS_SECTION = re.compile(r'^## Tests\n(.*?)(?=^## |\Z)', re.MULTILINE | re.DOTALL)
MARK_WORDS = re.compile(r'^- ([^:.→]+)', re.MULTILINE)
STRING = r'''(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)'''
CS_ATTRIBUTE = re.compile(r'\[\w*(?:Fact|Theory)\b')
CS_METHOD = re.compile(r'^\s*public\b[^\n(=]*?(?P<name>\w+)\s*(?:<[^>\n]*>)?\s*\(', re.MULTILINE)
# A `.test(` on a receiver is a RegExp's, and a test file calls one with a string literal.
TS_TEST = r'(?<![\w.$])(?:(?:[A-Za-z_$][\w$]*\.)?it|test)'
TS_TITLE = re.compile(TS_TEST + r'(?:\.skip)?\s*\(\s*' + STRING
                      + r'|' + TS_TEST + r'\.(?:each|skipIf)\b.*?\)\s*\(\s*' + STRING, re.DOTALL)
# ESLint's RuleTester registers each case as a test titled by its name (modbench/src/test/ruleTester.ts).
RULE_CASE = re.compile(r'\bname:\s*' + STRING)
CASE_HELPER = re.compile(r'\bconst\s+(\w+)\s*=\s*\(\s*name\s*:')
PY_METHOD = re.compile(r'^\s*(?:async\s+)?def\s+(test_\w+)\s*\(', re.MULTILINE)
ESCAPE = re.compile(r'\\(?:u([0-9A-Fa-f]{4})|(.))')


def cs_names(text: str) -> list[str]:
    return [method['name'] for attribute in CS_ATTRIBUTE.finditer(text)
            if (method := CS_METHOD.search(text, attribute.end()))]


def unescape(escape: re.Match[str]) -> str:
    return chr(int(escape[1], 16)) if escape[1] else escape[2]


def ts_names(text: str) -> list[str]:
    titles = [*TS_TITLE.finditer(text)]
    if 'RuleTester' in text:
        titles += RULE_CASE.finditer(text)
        titles += (case for helper in CASE_HELPER.findall(text)
                   for case in re.finditer(rf'(?<![\w.$]){helper}\(\s*{STRING}', text))
    return [ESCAPE.sub(unescape, next(group for group in title.groups() if group is not None)) for title in titles]


READERS: tuple[tuple[re.Pattern[str], Callable[[str], list[str]]], ...] = (
    (re.compile(r'\.cs$'), cs_names),
    (re.compile(r'\.test\.[cm]?[jt]sx?$'), ts_names),
    (re.compile(r'(?:^|/)test_[^/]*\.py$'), PY_METHOD.findall),
)


def reader_of(path: str) -> Callable[[str], list[str]] | None:
    return next((reader for pattern, reader in READERS if pattern.search(path)), None)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, text=True).stdout


def test_names(repo: Path, rev: str) -> Counter[str]:
    readers = {path: reader for path in git(repo, 'ls-tree', '-r', '-z', '--name-only', rev).split('\0')
               if (reader := reader_of(path))}
    blobs = subprocess.run(['git', '-C', str(repo), 'cat-file', '--batch'], check=True, capture_output=True,
                           input=''.join(f'{rev}:{path}\n' for path in readers).encode()).stdout
    names: Counter[str] = Counter()
    offset = 0
    for reader in readers.values():
        header_end = blobs.index(b'\n', offset)
        size = int(blobs[offset:header_end].split()[2])
        names.update(reader(blobs[header_end + 1:header_end + 1 + size].decode(errors='replace')))
        offset = header_end + 1 + size + 1
    return names


def marks_at(repo: Path, rev: str) -> set[str]:
    tests_section = TESTS_SECTION.search(git(repo, 'show', f'{rev}:{STANDARDS}'))
    return {words.strip() for words in MARK_WORDS.findall(tests_section[1] if tests_section else '')}


def stands(survivor: str, at_tip: Counter[str], marks: set[str]) -> bool:
    return survivor.removeprefix(MARK) in marks if survivor.startswith(MARK) else at_tip[survivor] > 0


def problems(repo: Path, base: str) -> list[str]:
    merge_base = git(repo, 'merge-base', base, 'HEAD').strip()
    at_tip = test_names(repo, 'HEAD')
    deleted = test_names(repo, merge_base) - at_tip
    marks = marks_at(repo, 'HEAD') | marks_at(repo, merge_base)
    trailers = git(repo, 'log', f'--format=%(trailers:key={KEY},valueonly,unfold)', f'{merge_base}..HEAD').splitlines()
    found: list[str] = []
    accounted: set[str] = set()
    unresolved: dict[str, list[str]] = {}
    for trailer in filter(None, trailers):
        gone, arrow, survivor = trailer.partition(ARROW)
        if not arrow:
            found.append(f'{KEY}: {trailer}: reads {FORM}')
        elif stands(survivor, at_tip, marks):
            accounted.add(gone)
        else:
            unresolved.setdefault(gone, []).append(trailer)
    found += [f'{trailer}: no test at the tip and no mark of {STANDARDS} § Tests reads so'
              for gone, named_by in unresolved.items() if gone in deleted and gone not in accounted for trailer in named_by]
    found += [f'{name}: deleted, and no trailer names its survivor: {FORM}'
              for name in sorted(deleted) if name not in accounted and name not in unresolved]
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
