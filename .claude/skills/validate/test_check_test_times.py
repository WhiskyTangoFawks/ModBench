"""Pins check_test_times.py: each test over a second is named from every kind of report, the wall time
is printed against its budget, and nothing fails."""
import contextlib
import io
import json
import pathlib
import tempfile
import unittest

import check_test_times as ctt


def trx(*results):
    """Each result is (test name, end second, duration in seconds)."""
    rows = ''.join(
        f'    <UnitTestResult testName="{name}" duration="00:{int(duration) // 60:02d}:{duration % 60:010.7f}" '
        f'endTime="2026-10-02T19:{int(end) // 60:02d}:{end % 60:010.7f}+01:00" outcome="Passed" />\n'
        for name, end, duration in results)
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">\n'
            f'  <Results>\n{rows}  </Results>\n</TestRun>\n')


def vitest(*files):
    """Each file is (path, [(full name, duration in ms or None for a skipped test)])."""
    return json.dumps({'testResults': [
        {'name': path, 'assertionResults': [
            {'fullName': name, **({} if ms is None else {'duration': ms})} for name, ms in tests]}
        for path, tests in files]})


def unittest_log(*durations):
    """Each duration is (test name, seconds), as Python 3.12's --durations prints them."""
    rows = ''.join(f'{seconds:.3f}s     {name}\n' for name, seconds in durations)
    return f'test_a ... ok\n\nSlowest test durations\n{"-" * 70}\n{rows}\n----\nRan {len(durations)} tests in 3s\n\nOK\n'


class Reports(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def report(self, name, text):
        file = self.dir / name
        file.parent.mkdir(exist_ok=True)
        file.write_text(text)


class Times(Reports):
    def over(self, *files):
        for i, body in enumerate(files):
            self.report(f'{i}.trx', body)
        return ctt.over_ceiling(self.dir)

    def test_a_test_over_the_ceiling_is_named_with_its_time(self):
        self.assertEqual(self.over(trx(('A.Quick', 1, 0.5), ('A.Slow', 40, 2.5))), [('A.Slow', 2.5)])

    def test_the_ceiling_is_a_second(self):
        self.assertEqual(self.over(trx(('A.Under', 1, 0.99), ('A.Over', 5, 1.01))), [('A.Over', 1.01)])

    def test_each_theory_row_is_held_to_the_ceiling_alone(self):
        self.assertEqual(
            self.over(trx(('A.Quick', 1, 0.5), ('A.Row(x: 1)', 30, 0.9), ('A.Row(x: 2)', 60, 3))),
            [('A.Row(x: 2)', 3.0)])

    def test_time_before_the_assemblys_first_result_is_not_charged(self):
        warm_up = 40
        self.assertEqual(
            self.over(trx(('A.First', warm_up, warm_up), ('A.Blocked', warm_up + 0.1, warm_up + 0.1),
                          ('A.SlowToo', warm_up + 3, warm_up + 3))),
            [('A.SlowToo', 3.0)])

    def test_each_assembly_has_its_own_warm_up(self):
        self.assertEqual(
            self.over(trx(('A.First', 1, 1), ('A.Late', 40, 3)),
                      trx(('B.First', 30, 30), ('B.Blocked', 31, 31))),
            [('A.Late', 3.0)])

    def test_a_vitest_test_over_the_ceiling_is_named_with_its_file_and_time(self):
        self.report('unit.json', vitest(
            ('/repo/src/a.test.ts', [('a quick', 40), ('a skipped', None)]),
            ('/repo/src/b.test.ts', [('b slow', 2500)])))
        self.assertEqual(ctt.over_ceiling(self.dir), [('b.test.ts > b slow', 2.5)])

    def test_a_unittest_test_over_the_ceiling_is_named_from_its_log(self):
        self.report('validate.unittest', unittest_log(('test_slow (m.C.test_slow)', 1.5), ('test_fast (m.C.test_fast)', 0.2)))
        self.assertEqual(ctt.over_ceiling(self.dir), [('test_slow (m.C.test_slow)', 1.5)])

    def test_a_mocha_test_over_the_ceiling_is_named_from_its_log(self):
        self.report('integration.mocha', '  Suite\n    ✔ quick (40ms)\n    ✔ slow one (1234ms)\n    √ on windows (2000ms)\n    ✔ fast\n')
        self.assertEqual(ctt.over_ceiling(self.dir), [('on windows', 2.0), ('slow one', 1.234)])

    def test_reports_in_folders_below_the_one_given_are_read(self):
        self.report('backend/a.trx', trx(('A.First', 1, 1), ('A.Slow', 40, 2.5)))
        self.assertEqual(ctt.over_ceiling(self.dir), [('A.Slow', 2.5)])

    def test_the_slowest_comes_first(self):
        self.assertEqual(self.over(trx(('A.First', 1, 1), ('A.One', 10, 2), ('A.Two', 20, 4))), [('A.Two', 4.0), ('A.One', 2.0)])


class Main(Reports):
    def main(self, elapsed, budget):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctt.main([str(self.dir), str(elapsed), str(budget)])
        return status, printed.getvalue()

    def test_it_names_each_test_over_the_ceiling_and_not_the_others(self):
        self.report('a.trx', trx(('A.Quick', 1, 0.5), ('A.Slow', 100, 2)))
        _, printed = self.main(100, 300)
        self.assertIn('A.Slow', printed)
        self.assertNotIn('A.Quick', printed)

    def test_it_prints_the_wall_time_against_the_budget(self):
        _, printed = self.main(213.4, 300)
        self.assertIn('Wall time 213 s of 300 s budget', printed)

    def test_it_says_when_the_wall_time_is_over_the_budget(self):
        _, printed = self.main(340, 300)
        self.assertIn('OVER BUDGET by 40 s', printed)

    def test_it_fails_nothing(self):
        self.report('a.trx', trx(('A.First', 1, 1), ('A.Slow', 100, 5)))
        status, _ = self.main(900, 300)
        self.assertEqual(status, 0)


if __name__ == '__main__':
    unittest.main()
