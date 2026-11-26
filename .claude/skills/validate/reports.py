"""Reads the test reports under a directory into one list of results, whatever stack wrote them: a
TRX file, a Vitest JSON report, and the logs of unittest (.unittest) and mocha (.mocha). skips.py
and check_test_times.py are filters over it."""
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path
from typing import NamedTuple, Optional

TRX = {'t': 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
VITEST_SKIPPED = {'pending', 'skipped', 'todo', 'disabled'}
UNITTEST_SKIP = re.compile(r'^(.+?) \.\.\. skipped\b', re.MULTILINE)
UNITTEST_SKIP_SUMMARY = re.compile(r'\(.*\bskipped=(\d+)')
UNITTEST_DURATION = re.compile(r'^(\d+\.\d+)s +(\S.*)$')
MOCHA_PENDING_SUMMARY = re.compile(r'^\s+\d+ pending$', re.MULTILINE)
MOCHA_PENDING_TEST = re.compile(r'^\s+- (.+)$', re.MULTILINE)
MOCHA_PASSED = re.compile(r'^\s+[✔√] (.+) \((\d+)ms\)$', re.MULTILINE)


class Result(NamedTuple):
    name: str
    outcome: str  # 'ran' or 'skipped'
    seconds: Optional[float]  # None when the report holds no time for it


def in_trx(text: str) -> list[Result]:
    """A result's time runs from its start or its assembly's first result, whichever is later:
    until a first result arrives, every test thread can be waiting on the one-off warm-up. A TRX
    file holds one assembly."""
    spans = []
    for result in ET.fromstring(text).iterfind('.//t:UnitTestResult', TRX):
        end = result.get('endTime')
        hours, minutes, secs = (result.get('duration') or '0:0:0').split(':')
        end = end and datetime.fromisoformat(end)
        spans.append((result.get('testName', ''), result.get('outcome'), end,
                      int(hours) * 3600 + int(minutes) * 60 + float(secs)))
    warmed = min((end for _, _, end, _ in spans if end), default=None)
    return [Result(name, 'skipped' if outcome == 'NotExecuted' else 'ran',
                   end and (end - max(end - timedelta(seconds=duration), warmed)).total_seconds())
            for name, outcome, end, duration in spans]


def in_vitest(text: str) -> list[Result]:
    """A skipped test has no duration. Vitest times a file's imports apart from its tests."""
    return [Result(f'{Path(file["name"]).name} > {test["fullName"]}',
                   'skipped' if test['status'] in VITEST_SKIPPED else 'ran',
                   test['duration'] / 1000 if 'duration' in test else None)
            for file in json.loads(text)['testResults'] for test in file['assertionResults']]


def in_unittest(text: str) -> list[Result]:
    """A skip comes from the result lines, or from the summary when a test that prints splits its
    result line from its name. The times come from the section of a run with --durations 0: a rule,
    then one line per test, up to a blank line. A skipped test is in both."""
    names = UNITTEST_SKIP.findall(text)
    summary = UNITTEST_SKIP_SUMMARY.search(text)
    results = [Result(name, 'skipped', None) for name in names]
    if not names and summary:
        results.append(Result(f'{summary[1]} skipped, unnamed', 'skipped', None))
    in_section = False
    for line in text.splitlines():
        if line == 'Slowest test durations':
            in_section = True
        elif in_section and (row := UNITTEST_DURATION.match(line)):
            results.append(Result(row[2], 'ran', float(row[1])))
        elif not line:
            in_section = False
    return results


def in_mocha(text: str) -> list[Result]:
    """Mocha prints a passing test's time when it is over half its slow threshold, so a test over a
    second always shows."""
    pending = MOCHA_PENDING_TEST.findall(text) if MOCHA_PENDING_SUMMARY.search(text) else []
    return ([Result(name, 'skipped', None) for name in pending]
            + [Result(name, 'ran', int(ms) / 1000) for name, ms in MOCHA_PASSED.findall(text)])


READERS = {'.trx': in_trx, '.json': in_vitest, '.unittest': in_unittest, '.mocha': in_mocha}


def results(directory: Path) -> list[Result]:
    """UTF-8 with or without the byte order mark that PowerShell's Add-Content writes."""
    if not directory.is_dir():
        raise SystemExit(f'No reports folder {directory}.')
    return [result for report in sorted(directory.rglob('*')) if report.is_file() and report.suffix in READERS
            for result in READERS[report.suffix](report.read_text(encoding='utf-8-sig'))]
