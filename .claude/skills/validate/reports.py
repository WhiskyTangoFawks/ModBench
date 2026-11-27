"""Reads every test report under a directory: TRX, Vitest JSON, and unittest and mocha logs. A
result's box is its backend test project, its folder under modbench/src/ or else modbench/, or its log's
name."""
import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path, PureWindowsPath
from typing import NamedTuple

RAN = 'ran'
SKIPPED = 'skipped'
TRX = {'t': 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
VITEST_SKIPPED = {'pending', 'skipped', 'todo', 'disabled'}
UNITTEST_SKIP = re.compile(r'^(.+?) \.\.\. skipped\b', re.MULTILINE)
UNITTEST_SKIP_SUMMARY = re.compile(r'\(.*\bskipped=(\d+)')
UNITTEST_DURATION = re.compile(r'^(\d+\.\d+)s +(\S.*)$')
MOCHA_PENDING_SUMMARY = re.compile(r'^\s+\d+ pending$', re.MULTILINE)
MOCHA_PENDING_TEST = re.compile(r'^\s+- (.+)$', re.MULTILINE)
MOCHA_PASSED = re.compile(r'^\s+[✔√] (.+) \((\d+)ms\)$', re.MULTILINE)
VITEST_SEPARATOR = ' > '
FRONTEND_BOX = re.compile(r'.*/modbench/(?:src/([^/]+)/|([^/]+)/)')


class Result(NamedTuple):
    name: str
    outcome: str  # RAN or SKIPPED
    seconds: float | None  # None when the report holds no time for it
    box: str


def in_trx(text: str) -> list[Result]:
    """Time runs from the result's start or the first result's end, whichever is later: the warm-up blocks
    every thread. A run one test at a time blocks none, so each result is charged its whole duration."""
    run = ET.fromstring(text)
    elements = list(run.iterfind('.//t:UnitTestResult', TRX))
    projects = {test.attrib['id']: PureWindowsPath(next(test.iterfind('t:TestMethod', TRX)).attrib['codeBase']).stem
                for test in run.iterfind('.//t:UnitTest', TRX)}

    def span(result: ET.Element) -> tuple[datetime, datetime] | None:
        if 'endTime' not in result.attrib:
            return None
        end = datetime.fromisoformat(result.attrib['endTime'])
        hours, minutes, secs = result.get('duration', '0:0:0').split(':')
        return end - timedelta(hours=int(hours), minutes=int(minutes), seconds=float(secs)), end

    spans = [span(element) for element in elements]
    timed = [times for times in spans if times]
    warmed = min((end for _, end in timed), default=None)
    blocked = warmed if warmed and sum(start < warmed for start, _ in timed) > 1 else None

    def seconds(times: tuple[datetime, datetime] | None) -> float | None:
        if times is None:
            return None
        start, end = times
        return (end - (max(start, blocked) if blocked else start)).total_seconds()

    return [Result(result.attrib['testName'], SKIPPED if result.get('outcome') == 'NotExecuted' else RAN,
                   seconds(times), projects[result.attrib['testId']])
            for result, times in zip(elements, spans)]


def ran_first(text: str) -> str | None:
    """The name of a TRX run's first result to end: in a run one test at a time, the one that paid the warm-up."""
    ended = [result for result in ET.fromstring(text).iterfind('.//t:UnitTestResult', TRX) if 'endTime' in result.attrib]
    return min(ended, key=lambda result: datetime.fromisoformat(result.attrib['endTime'])).attrib['testName'] if ended else None


def frontend_box(path: str) -> str:
    match = FRONTEND_BOX.match(path)
    if match is None:
        raise ValueError(f'{path} is not under modbench/')
    return match[1] or match[2]


def in_vitest(text: str) -> list[Result]:
    """A skipped test has no duration. Vitest times a file's imports apart from its tests."""
    return [Result(f'{Path(file["name"]).name}{VITEST_SEPARATOR}{test["fullName"]}',
                   SKIPPED if test['status'] in VITEST_SKIPPED else RAN,
                   test['duration'] / 1000 if 'duration' in test else None, frontend_box(file['name']))
            for file in json.loads(text)['testResults'] for test in file['assertionResults']]


def in_unittest(text: str, box: str) -> list[Result]:
    """A skip comes from the result lines, or from the summary when a test that prints splits its
    result line. Times come from the --durations 0 section: a rule, then a line per test."""
    names = UNITTEST_SKIP.findall(text)
    summary = UNITTEST_SKIP_SUMMARY.search(text)
    results = [Result(name, SKIPPED, None, box) for name in names]
    if not names and summary:
        results.append(Result(f'{summary[1]} skipped, unnamed', SKIPPED, None, box))
    in_section = False
    for line in text.splitlines():
        if line == 'Slowest test durations':
            in_section = True
        elif in_section and (row := UNITTEST_DURATION.match(line)):
            if row[2] not in names:
                results.append(Result(row[2], RAN, float(row[1]), box))
        elif not line:
            in_section = False
    return results


def in_mocha(text: str, box: str) -> list[Result]:
    """Mocha prints a passing test's time when it is over half its slow threshold, so a test over a
    second always shows."""
    pending = MOCHA_PENDING_TEST.findall(text) if MOCHA_PENDING_SUMMARY.search(text) else []
    return ([Result(name, SKIPPED, None, box) for name in pending]
            + [Result(name, RAN, int(ms) / 1000, box) for name, ms in MOCHA_PASSED.findall(text)])


TRX_REPORT, VITEST_REPORT, UNITTEST_REPORT, MOCHA_REPORT = '.trx', '.json', '.unittest', '.mocha'
READERS = {TRX_REPORT: lambda text, _: in_trx(text), VITEST_REPORT: lambda text, _: in_vitest(text),
           UNITTEST_REPORT: in_unittest, MOCHA_REPORT: in_mocha}


def by_kind(directory: Path) -> dict[str, list[Result]]:
    """Every result of every report below the folder, which must exist, by its report's suffix. A log is UTF-8,
    with or without the byte order mark that PowerShell's Add-Content writes."""
    if not directory.is_dir():
        raise SystemExit(f'No reports folder {directory}.')
    kinds: dict[str, list[Result]] = {}
    for report in sorted(directory.rglob('*')):
        if report.is_file() and report.suffix in READERS:
            kinds.setdefault(report.suffix, []).extend(READERS[report.suffix](report.read_text(encoding='utf-8-sig'), report.stem))
    return kinds


def results(directory: Path) -> list[Result]:
    return [result for kind in by_kind(directory).values() for result in kind]
