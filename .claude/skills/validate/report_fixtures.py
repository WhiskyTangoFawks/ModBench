"""The reports of each stack, as the tests of reports.py, skips.py and check_test_times.py build them."""
import json


def trx_result(name, end=None, duration=0, outcome='Passed'):
    """end is a second of the run, or None for a result with no times."""
    times = '' if end is None else (
        f' duration="00:{int(duration) // 60:02d}:{duration % 60:010.7f}"'
        f' endTime="2026-10-02T19:{int(end) // 60:02d}:{end % 60:010.7f}+01:00"')
    return f'    <UnitTestResult testName="{name}"{times} outcome="{outcome}" />\n'


def trx(*results):
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">\n'
            f'  <Results>\n{"".join(results)}  </Results>\n</TestRun>\n')


def vitest(*files):
    """Each file is (path, [(full name, status, duration in ms or None)])."""
    return json.dumps({'testResults': [
        {'name': path, 'assertionResults': [
            {'fullName': name, 'status': status, **({} if ms is None else {'duration': ms})}
            for name, status, ms in tests]}
        for path, tests in files]})


def unittest_log(*, skipped=(), durations=()):
    """Python 3.12's verbose log of a run with --durations 0. Each duration is (name, seconds)."""
    results = ''.join(f"{name} ... skipped 'no reason'\n" for name in skipped)
    rows = ''.join(f'{seconds:.3f}s     {name}\n' for name, seconds in durations)
    return (f'test_a (m.C.test_a) ... ok\n{results}\nSlowest test durations\n{"-" * 70}\n{rows}\n{"-" * 70}\n'
            f'Ran {len(durations)} tests in 3s\n\nOK{f" (skipped={len(skipped)})" if skipped else ""}\n')


def mocha_log(*, passed=(), pending=()):
    """Each passed is (name, ms)."""
    rows = ''.join(f'    ✔ {name} ({ms}ms)\n' for name, ms in passed)
    dashes = ''.join(f'    - {name}\n' for name in pending)
    return f'  a suite\n{rows}{dashes}\n  {len(passed)} passing\n' + (f'  {len(pending)} pending\n' if pending else '')
