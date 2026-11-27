#!/usr/bin/env python3
"""Reads the test reports under a directory (see reports.py), names each test over 100 ms, and prints each
box's summed test time and the run's wall time against its budget in the budget file. Once FAILS_THE_RUN is on,
a Linux run fails on a box over its budget or without one, and on a test over the 1 s ceiling the file does
not approve. Once WINDOWS_FAILS_THE_RUN is on, the Windows run fails on its wall time, and on nothing else.
An approval whose tests all ran under the ceiling is reported as lapsed and fails nothing."""
import sys
import tomllib
from pathlib import Path

import reports

SLOW_SECONDS = 0.1
CEILING_SECONDS = 1.0
FAILS_THE_RUN = False
WINDOWS_FAILS_THE_RUN = False
# The source scans, the gates' own tests and the integration tests: the budget file's `other` holds them.
NO_BOX = {'MEditService.Architecture.Tests', 'test', 'validate', 'hooks', 'integration'}
OTHER = 'the tests of no box'
WINDOWS = 'windows'


def slow_tests(results: list[reports.Result]) -> list[tuple[str, float]]:
    return sorted(((result.name, result.seconds) for result in results
                   if result.seconds is not None and result.seconds > SLOW_SECONDS),
                  key=lambda over: -over[1])


def approval_of(name: str, approved: dict[str, str]) -> str | None:
    """A theory's name approves each of its cases."""
    return next((key for key in approved if name == key or name.startswith(f'{key}(')), None)


def lapsed(results: list[reports.Result], approved: dict[str, str]) -> list[tuple[str, float]]:
    """Each approval whose tests ran, all under the ceiling, with its slowest test's time, slowest first."""
    slowest: dict[str, float] = {}
    for result in results:
        if result.seconds is not None and (key := approval_of(result.name, approved)) is not None:
            slowest[key] = max(slowest.get(key, 0), result.seconds)
    return sorted(((key, seconds) for key, seconds in slowest.items() if seconds < CEILING_SECONDS), key=lambda lapse: -lapse[1])


def report_ceiling(results: list[reports.Result], alone: list[reports.Result], approved: dict[str, str]) -> int:
    """The number of tests over the ceiling no approval names. A test that ran again alone is judged on its fastest run
    there."""
    fastest: dict[str, reports.Result] = {}
    for result in alone:
        kept = fastest.get(result.name)
        if kept is None or (result.seconds is not None and (kept.seconds is None or result.seconds < kept.seconds)):
            fastest[result.name] = result
    again = set(fastest)
    ran_again = {result.name for result in results if (result.seconds or 0) > CEILING_SECONDS and result.name in again}
    judged = [result for result in results if result.name not in again] + list(fastest.values())
    unapproved = [(name, seconds) for name, seconds in slow_tests(judged)
                  if seconds > CEILING_SECONDS and approval_of(name, approved) is None]
    for name, seconds in unapproved:
        print(f'{seconds:7.2f} s  {name}: OVER THE {CEILING_SECONDS:g} s CEILING{" ALONE" if name in again else ""}, NOT APPROVED')
    lapses = lapsed(judged, approved)
    for name, seconds in lapses:
        print(f'{seconds:7.2f} s  {name}: APPROVAL LAPSED')
    print(f'--- {len(ran_again)} TESTS OVER {CEILING_SECONDS:g} s RUN AGAIN ALONE, {len(unapproved)} OVER THE CEILING NOT APPROVED, '
          f'{len(lapses)} APPROVALS LAPSED ---')
    return len(unapproved)


def box_times(results: list[reports.Result]) -> list[tuple[str, float]]:
    """Most first."""
    times: dict[str, float] = {}
    for result in results:
        times[result.box] = times.get(result.box, 0) + (result.seconds or 0)
    return sorted(times.items(), key=lambda box: -box[1])


def against(seconds: float, budget: float | None, name: str) -> tuple[str, bool]:
    """The line, and whether it fails."""
    if budget is None:
        return f'{seconds:7.1f} s  {name}: NO BUDGET', True
    over = seconds > budget
    late = f': OVER BUDGET by {seconds - budget:.1f} s' if over else ''
    return f'{seconds:7.1f} s of {budget:4g} s  {name}{late}', over


def report_budgets(times: list[tuple[str, float]], boxes: dict[str, float], other: float) -> int:
    """The number of budgets overrun or missing."""
    no_box = [(box, seconds) for box, seconds in times if box in NO_BOX]
    lines = [against(seconds, boxes.get(box), box) for box, seconds in times if box not in NO_BOX]
    lines.append(against(sum(seconds for _, seconds in no_box), other, OTHER))
    for line, _ in lines:
        print(line)
    for box, seconds in no_box:
        print(f'  {seconds:7.1f} s  {box}')
    failing = sum(fails for _, fails in lines)
    print(f'--- {failing} BUDGETS OVERRUN OR MISSING ---')
    return failing


def report_wall(elapsed: float, budget: float) -> bool:
    """Whether the run is over its budget."""
    over = elapsed > budget
    late = f': OVER BUDGET by {elapsed - budget:.0f} s' if over else ''
    print(f'Wall time {elapsed:.0f} s of {budget:.0f} s budget{late}')
    return over


def main(argv: list[str] | None = None) -> int:
    """The run is a budget file's key under [wall]: branch, merge or windows."""
    directory, elapsed_argument, budgets_file, run, *optional = sys.argv[1:] if argv is None else argv
    (alone_folder,) = optional or [None]
    elapsed = float(elapsed_argument)
    budgets = tomllib.loads(Path(budgets_file).read_text())
    results = reports.results(Path(directory))
    slow = slow_tests(results)
    for name, seconds in slow:
        print(f'{seconds:7.2f} s  {name}')
    print(f'--- {len(slow)} TESTS OVER {SLOW_SECONDS * 1000:.0f} ms ---')
    times = box_times(results)
    if run == WINDOWS:
        for box, seconds in times:
            print(f'{seconds:7.1f} s  {box}')
        return int(report_wall(elapsed, budgets['wall'][run]) and WINDOWS_FAILS_THE_RUN)
    alone = reports.results(Path(alone_folder)) if alone_folder else []
    failing = (report_ceiling(results, alone, budgets.get('approved', {}))
               + report_budgets(times, budgets['boxes'], budgets['other']))
    report_wall(elapsed, budgets['wall'][run])
    return int(FAILS_THE_RUN and bool(failing))


if __name__ == '__main__':
    sys.exit(main())
