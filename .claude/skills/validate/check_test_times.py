#!/usr/bin/env python3
"""Reads the test reports under a directory (see reports.py), names each test over 100 ms, and prints
each box's summed test time and the wall time. Given a budget file, a box over its budget or without
one fails the run once FAILS_THE_RUN is on."""
import sys
import tomllib
from pathlib import Path

import reports

POINTER_SECONDS = 0.1
FAILS_THE_RUN = False
# The source scans, the gates' own tests and the integration tests: the budget file's `other` holds them.
NO_BOX = {'MEditService.Architecture.Tests', 'test', 'validate', 'hooks', 'integration'}
OTHER = 'the tests of no box'


def over_pointer(results: list[reports.Result]) -> list[tuple[str, float]]:
    return sorted(((result.name, result.seconds) for result in results
                   if result.seconds is not None and result.seconds > POINTER_SECONDS),
                  key=lambda over: -over[1])


def box_times(results: list[reports.Result]) -> list[tuple[str, float]]:
    """Most first."""
    times: dict[str, float] = {}
    for result in results:
        times[result.box] = times.get(result.box, 0) + (result.seconds or 0)
    return sorted(times.items(), key=lambda box: -box[1])


def against(seconds: float, budget: float, name: str) -> tuple[str, bool]:
    over = seconds > budget
    late = f': OVER BUDGET by {seconds - budget:.1f} s' if over else ''
    return f'{seconds:7.1f} s of {budget:4g} s  {name}{late}', over


def report_budgets(times: list[tuple[str, float]], budgets_file: Path) -> int:
    """The number of budgets overrun or missing."""
    budgets = tomllib.loads(budgets_file.read_text())
    boxes: dict[str, float] = budgets['boxes']
    no_box = [(box, seconds) for box, seconds in times if box in NO_BOX]
    lines = [against(seconds, boxes[box], box) if box in boxes else (f'{seconds:7.1f} s  {box}: NO BUDGET', True)
             for box, seconds in times if box not in NO_BOX]
    lines.append(against(sum(seconds for _, seconds in no_box), budgets['other'], OTHER))
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
    over = over_pointer(results)
    for name, time in over:
        print(f'{time:7.2f} s  {name}')
    print(f'--- {len(over)} TESTS OVER {POINTER_SECONDS * 1000:.0f} ms ---')
    times = box_times(results)
    failing = 0
    if budgets_file:
        failing = report_budgets(times, Path(budgets_file))
    else:
        for box, seconds in times:
            print(f'{seconds:7.1f} s  {box}')
    late = f': OVER BUDGET by {elapsed - budget:.0f} s' if elapsed > budget else ''
    print(f'Wall time {elapsed:.0f} s of {budget:.0f} s budget{late}')
    return int(FAILS_THE_RUN and bool(failing))


if __name__ == '__main__':
    sys.exit(main())
