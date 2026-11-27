#!/usr/bin/env python3
"""Names each wait on real time in a test's source, and fails on any. A wait is on a value or on a fake clock;
ALLOWED names each line that cannot be, with its reason: a check that something never happens where nothing
later announces that it did not. A language is a Scan: the test files it reads and the waits it finds there.
Run with the repository's root, it reads every tracked file; test-wait-write.py runs waits() over the text an
edit writes."""
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Scan:
    files: re.Pattern[str]
    wait: re.Pattern[str]


@dataclass(frozen=True)
class Wait:
    path: str
    line: int
    text: str


SCANS = (
    Scan(re.compile(r'(?:^|/)MEditService/MEditService\.[\w.]*Test[\w.]*/.+\.cs$'),
         re.compile(r'\b(?:Task\.Delay|Thread\.Sleep)\((?!\s*Timeout\.Infinite\b)')),
)

RECORD_INDEX_TESTS = 'MEditService/MEditService.RecordIndex.Tests/'
ALLOWED = {
    ('MEditService/MEditService.TestSupport/Waits.cs', 'Thread.Sleep(PollInterval);'):
        'the pause between two reads of the value a wait is on',
    ('MEditService/MEditService.TestSupport/Waits.cs', 'await Task.Delay(PollInterval);'):
        'the pause between two reads of the value a wait is on',
    (RECORD_INDEX_TESTS + 'Plugins/ReconcileDoorTests.cs', 'await Task.Delay(TimeSpan.FromMilliseconds(500));'):
        'no third reconcile follows: nothing announces a turn the worker does not take',
    (RECORD_INDEX_TESTS + 'Query/CommitLandingTests.cs', 'Thread.Sleep(TimeSpan.FromMilliseconds(500));'):
        'no checkpoint of the first load follows: nothing announces that none is still owed',
    (RECORD_INDEX_TESTS + 'Records/IndexWriteOrderTests.cs',
     'Assert.NotSame(filter, await Task.WhenAny(filter, Task.Delay(TimeSpan.FromMilliseconds(100))));'):
        'the filter does not land while the re-derivation is parked: nothing announces a waiting write',
    (RECORD_INDEX_TESTS + 'Records/RecordTypeViewsTests.cs',
     'await Task.Delay(TimeSpan.FromMilliseconds(100), CancellationToken.None);'):
        'the second SELECT does not answer while the views are created: nothing announces a waiting read',
    (RECORD_INDEX_TESTS + 'RealSize/RealSizeSoakTests.cs', 'Thread.Sleep(TimeSpan.FromMilliseconds(10));'):
        'a tool (Kind=Tool), not a test: a refused read retries as a user\'s script does',
}


def waits(path: str, text: str) -> list[Wait]:
    patterns = [scan.wait for scan in SCANS if scan.files.search(path)]
    allowed = {line for allowed_path, line in ALLOWED if path.endswith(allowed_path)}
    return [Wait(path, number, line.strip()) for number, line in enumerate(text.splitlines(), 1)
            if any(pattern.search(line) for pattern in patterns) and line.strip() not in allowed]


def main(argv: list[str]) -> int:
    root = Path(argv[0])
    tracked = subprocess.run(['git', '-C', root, 'ls-files'], capture_output=True, text=True, check=True).stdout.splitlines()
    found = [wait for path in tracked if any(scan.files.search(path) for scan in SCANS) and (root / path).is_file()
             for wait in waits(path, (root / path).read_text(errors='replace'))]
    for wait in found:
        print(f'{wait.path}:{wait.line}  {wait.text}')
    print(f'--- {len(found)} TEST WAITS ON REAL TIME: wait on a value (Waits) or a fake clock ---')
    return int(bool(found))


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
