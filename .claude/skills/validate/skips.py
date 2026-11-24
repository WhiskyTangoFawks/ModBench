#!/usr/bin/env python3
"""Reads the test reports in each directory it is given and names every test that skipped: a TRX
file, a Vitest JSON report, and the logs of unittest (.unittest) and mocha (.mocha). Exit 0 when
none did, 1 otherwise."""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

TRX = {'t': 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
VITEST_SKIPPED = {'pending', 'skipped', 'todo', 'disabled'}
UNITTEST_SKIP = re.compile(r'^(.+?) \.\.\. skipped\b', re.MULTILINE)
MOCHA_PENDING_SUMMARY = re.compile(r'^\s+\d+ pending$', re.MULTILINE)
MOCHA_PENDING_TEST = re.compile(r'^\s+- (.+)$', re.MULTILINE)


def in_trx(text: str) -> list[str]:
    return [result.get('testName', '') for result in ET.fromstring(text).iterfind('.//t:UnitTestResult', TRX)
            if result.get('outcome') == 'NotExecuted']


def in_vitest(text: str) -> list[str]:
    return [f'{Path(file["name"]).name} > {test["fullName"]}'
            for file in json.loads(text)['testResults']
            for test in file['assertionResults'] if test['status'] in VITEST_SKIPPED]


def in_unittest(text: str) -> list[str]:
    return UNITTEST_SKIP.findall(text)


def in_mocha(text: str) -> list[str]:
    return MOCHA_PENDING_TEST.findall(text) if MOCHA_PENDING_SUMMARY.search(text) else []


READERS = {'.trx': in_trx, '.json': in_vitest, '.unittest': in_unittest, '.mocha': in_mocha}


def skipped(directory: Path) -> list[str]:
    return [name for report in sorted(directory.iterdir()) if report.suffix in READERS
            for name in READERS[report.suffix](report.read_text())]


def main(argv: list[str] | None = None) -> int:
    names = [name for directory in (sys.argv[1:] if argv is None else argv) for name in skipped(Path(directory))]
    for name in names:
        print(f'skipped  {name}')
    if names:
        print(f'--- {len(names)} TESTS SKIPPED ---')
    return 1 if names else 0


if __name__ == '__main__':
    sys.exit(main())
