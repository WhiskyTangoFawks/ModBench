#!/usr/bin/env python3
"""Reads every TRX file and Vitest JSON report in a directory and names each test whose run took
longer than its suite's ceiling. Exit 0 when none did, 1 otherwise."""
import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

# Three times a test's time on a quiet machine: ten seconds for a backend test, two for a unit
# test. Gate runs share the machine with builds and other test runs, which slow a test two to six
# times.
CEILINGS = {'.trx': 30, '.json': 6}
TRX = {'t': 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}


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


TIMES = {'.trx': charged_times, '.json': vitest_times}


def over_ceiling(directory: Path, ceilings=CEILINGS):
    return sorted(
        ((name, time, ceilings[report.suffix]) for report in sorted(directory.iterdir())
         if report.suffix in ceilings
         for name, time in TIMES[report.suffix](report) if time > ceilings[report.suffix]),
        key=lambda over: -over[1])


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    over = over_ceiling(Path(argv[0]))
    for name, time, ceiling in over:
        print(f'{time:7.1f} s  over {ceiling} s  {name}')
    if over:
        print(f'--- {len(over)} TESTS OVER THEIR CEILING ---')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
