#!/usr/bin/env python3
"""Reads the test reports under a directory (see reports.py), names each test that took over a
second, prints each box's summed test time, and the run's wall time against its budget. Given a budget
file, it prints each box against its budget and the boxes the file does not name together against
`other`; once FAILS_THE_RUN is on, a budget overrun fails the run. Exit 0 otherwise, once the reports
are read."""
import sys
import tomllib
from pathlib import Path

import reports

CEILING = 1
FAILS_THE_RUN = False
OTHER = 'the other tests'


def over_ceiling(results: list[reports.Result]) -> list[tuple[str, float]]:
    return sorted(((result.name, result.seconds) for result in results
                   if result.seconds is not None and result.seconds > CEILING),
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
    """The number of budgets overrun."""
    budgets = tomllib.loads(budgets_file.read_text())
    boxes: dict[str, float] = budgets['boxes']
    shared = [(box, seconds) for box, seconds in times if box not in boxes]
    lines = [against(seconds, boxes[box], box) for box, seconds in times if box in boxes]
    lines.append(against(sum(seconds for _, seconds in shared), budgets['other'], OTHER))
    for line, _ in lines:
        print(line)
    for box, seconds in shared:
        print(f'  {seconds:7.1f} s  {box}')
    overrun = sum(over for _, over in lines)
    print(f'--- {overrun} BUDGETS OVERRUN ---')
    return overrun


def main(argv: list[str] | None = None) -> int:
    directory, elapsed_argument, budget_argument, *budgets_file = sys.argv[1:] if argv is None else argv
    elapsed, budget = float(elapsed_argument), float(budget_argument)
    results = reports.results(Path(directory))
    over = over_ceiling(results)
    for name, time in over:
        print(f'{time:7.1f} s  {name}')
    print(f'--- {len(over)} TESTS OVER {CEILING} s ---')
    times = box_times(results)
    overrun = 0
    if budgets_file:
        overrun = report_budgets(times, Path(budgets_file[0]))
    else:
        for box, seconds in times:
            print(f'{seconds:7.1f} s  {box}')
    late = f': OVER BUDGET by {elapsed - budget:.0f} s' if elapsed > budget else ''
    print(f'Wall time {elapsed:.0f} s of {budget:.0f} s budget{late}')
    return int(FAILS_THE_RUN and bool(overrun))


if __name__ == '__main__':
    sys.exit(main())
