#!/usr/bin/env python3
"""Reads the test reports under a directory (see reports.py), names each test over 100 ms, and prints
each box's summed test time and the wall time. Given a budget file, a box over its budget or without
one, and a test over the 1 s ceiling the file does not approve, fail the run once FAILS_THE_RUN is on.
An approval whose tests all ran under the ceiling is reported as lapsed and fails nothing."""
import sys
import tomllib
from pathlib import Path

import reports

SLOW_SECONDS = 0.1
CEILING_SECONDS = 1.0
FAILS_THE_RUN = False
# The source scans, the gates' own tests and the integration tests: the budget file's `other` holds them.
NO_BOX = {'MEditService.Architecture.Tests', 'test', 'validate', 'hooks', 'integration'}
OTHER = 'the tests of no box'


def slow_tests(results: list[reports.Result]) -> list[tuple[str, float]]:
    return sorted(((result.name, result.seconds) for result in results
                   if result.seconds is not None and result.seconds > SLOW_SECONDS),
                  key=lambda over: -over[1])


def approval_of(name: str, approved: dict[str, str]) -> str | None:
    """A theory's name approves each of its cases."""
    return next((key for key in approved if name == key or name.startswith(f'{key}(')), None)


def lapsed(results: list[reports.Result], approved: dict[str, str]) -> list[tuple[str, float]]:
    """Each approval whose tests ran, all under the ceiling, with its slowest test's time."""
    slowest: dict[str, float] = {}
    for result in results:
        if result.seconds is not None and (key := approval_of(result.name, approved)) is not None:
            slowest[key] = max(slowest.get(key, 0), result.seconds)
    return [(key, seconds) for key, seconds in slowest.items() if seconds < CEILING_SECONDS]


def report_ceiling(results: list[reports.Result], over: list[tuple[str, float]], approved: dict[str, str]) -> int:
    """The number of tests over the ceiling no approval names. over is slow_tests' list."""
    unapproved = [(name, seconds) for name, seconds in over
                  if seconds > CEILING_SECONDS and approval_of(name, approved) is None]
    for name, seconds in unapproved:
        print(f'{seconds:7.2f} s  {name}: OVER THE {CEILING_SECONDS:g} s CEILING, NOT APPROVED')
    lapses = lapsed(results, approved)
    for name, seconds in lapses:
        print(f'{seconds:7.2f} s  {name}: APPROVAL LAPSED')
    print(f'--- {len(unapproved)} TESTS OVER THE {CEILING_SECONDS:g} s CEILING NOT APPROVED, {len(lapses)} APPROVALS LAPSED ---')
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


def main(argv: list[str] | None = None) -> int:
    directory, elapsed_argument, budget_argument, *optional = sys.argv[1:] if argv is None else argv
    (budgets_file,) = optional or [None]
    elapsed, budget = float(elapsed_argument), float(budget_argument)
    results = reports.results(Path(directory))
    over = slow_tests(results)
    for name, seconds in over:
        print(f'{seconds:7.2f} s  {name}')
    print(f'--- {len(over)} TESTS OVER {SLOW_SECONDS * 1000:.0f} ms ---')
    times = box_times(results)
    failing = 0
    if budgets_file:
        budgets = tomllib.loads(Path(budgets_file).read_text())
        failing = (report_ceiling(results, over, budgets.get('approved', {}))
                   + report_budgets(times, budgets['boxes'], budgets['other']))
    else:
        for box, seconds in times:
            print(f'{seconds:7.1f} s  {box}')
    late = f': OVER BUDGET by {elapsed - budget:.0f} s' if elapsed > budget else ''
    print(f'Wall time {elapsed:.0f} s of {budget:.0f} s budget{late}')
    return int(FAILS_THE_RUN and bool(failing))


if __name__ == '__main__':
    sys.exit(main())
