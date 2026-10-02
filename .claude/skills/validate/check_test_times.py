#!/usr/bin/env python3
"""Reads every TRX file in a directory and names each test whose run took longer than the
ceiling. Exit 0 when none did, 1 otherwise."""
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

# Three times the ten seconds a test takes on a quiet machine. Gate runs share the machine with
# builds and other test runs, which slow a test two to six times.
CEILING_SECONDS = 30
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


def over_ceiling(directory: Path, ceiling=CEILING_SECONDS):
    return sorted(
        ((name, time) for trx in sorted(directory.glob('*.trx')) for name, time in charged_times(trx)
         if time > ceiling),
        key=lambda over: -over[1])


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    over = over_ceiling(Path(argv[0]))
    for name, time in over:
        print(f'{time:7.1f} s  {name}')
    if over:
        print(f'--- {len(over)} TESTS OVER THE {CEILING_SECONDS} S CEILING ---')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
