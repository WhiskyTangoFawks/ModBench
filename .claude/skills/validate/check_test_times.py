#!/usr/bin/env python3
"""Reads every test report under a directory (a TRX file, a Vitest JSON report, and the logs of
unittest, .unittest, and mocha, .mocha), names each test that took over a second, and prints the
run's wall time against its budget. Reports only: exit 0."""
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

CEILING = 1
TRX = {'t': 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
UNITTEST_DURATION = re.compile(r'^(\d+\.\d+)s +(\S.*)$')
MOCHA_PASSED = re.compile(r'^\s+[✔√] (.+) \((\d+)ms\)$', re.MULTILINE)


def seconds(duration: str):
    hours, minutes, secs = duration.split(':')
    return int(hours) * 3600 + int(minutes) * 60 + float(secs)


def charged_times(trx: Path):
    """Each result's time from its start or its assembly's first result, whichever is later:
    until a first result arrives, every test thread can be waiting on the one-off warm-up. A TRX
    file holds one assembly."""
    spans = []
    for result in ET.parse(trx).getroot().iterfind('.//t:UnitTestResult', TRX):
        end = datetime.fromisoformat(result.get('endTime'))
        start = end - timedelta(seconds=seconds(result.get('duration')))
        spans.append((result.get('testName'), start, end))
    warmed = min((end for _, _, end in spans), default=None)
    return [(name, (end - max(start, warmed)).total_seconds()) for name, start, end in spans]


def vitest_times(report: Path):
    """A skipped test has no duration. Vitest times a file's imports apart from its tests."""
    return [(f'{Path(file["name"]).name} > {test["fullName"]}', test['duration'] / 1000)
            for file in json.loads(report.read_text())['testResults']
            for test in file['assertionResults'] if 'duration' in test]


def unittest_times(log: Path):
    """The log of a run with --durations 0: a rule, then one line per test, up to a blank line."""
    times = []
    in_section = False
    for line in log.read_text().splitlines():
        if line == 'Slowest test durations':
            in_section = True
        elif in_section and (row := UNITTEST_DURATION.match(line)):
            times.append((row[2], float(row[1])))
        elif not line:
            in_section = False
    return times


def mocha_times(log: Path):
    """Mocha prints a passing test's time when it is over half its slow threshold, so a test over a
    second always shows."""
    return [(name, int(ms) / 1000) for name, ms in MOCHA_PASSED.findall(log.read_text())]


TIMES = {'.trx': charged_times, '.json': vitest_times, '.unittest': unittest_times, '.mocha': mocha_times}


def over_ceiling(directory: Path):
    return sorted(
        ((name, time) for report in sorted(directory.rglob('*')) if report.is_file() and report.suffix in TIMES
         for name, time in TIMES[report.suffix](report) if time > CEILING),
        key=lambda over: -over[1])


def main(argv=None):
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
