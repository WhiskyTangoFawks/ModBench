"""Pins check_test_times.py: every test run over the ceiling is named, and no test is charged for
the time before its assembly's first result."""
import contextlib
import io
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_test_times as ctt  # noqa: E402


def trx(*results):
    """Each result is (test name, end second, duration in seconds)."""
    rows = ''.join(
        f'    <UnitTestResult testName="{name}" duration="00:{int(duration) // 60:02d}:{duration % 60:010.7f}" '
        f'endTime="2026-10-02T19:{int(end) // 60:02d}:{end % 60:010.7f}+01:00" outcome="Passed" />\n'
        for name, end, duration in results)
    return ('<?xml version="1.0" encoding="utf-8"?>\n'
            '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">\n'
            f'  <Results>\n{rows}  </Results>\n</TestRun>\n')


class OverCeiling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def over(self, *files):
        for i, body in enumerate(files):
            (self.dir / f'{i}.trx').write_text(body)
        return ctt.over_ceiling(self.dir, ceiling=20)

    def test_a_test_over_the_ceiling_is_named_with_its_time(self):
        self.assertEqual(
            self.over(trx(('A.Quick', 1, 0.5), ('A.Slow', 40, 25))),
            [('A.Slow', 25.0)])

    def test_each_theory_row_is_held_to_the_ceiling_alone(self):
        self.assertEqual(
            self.over(trx(('A.Quick', 1, 0.5), ('A.Row(x: 1)', 30, 15), ('A.Row(x: 2)', 60, 30))),
            [('A.Row(x: 2)', 30.0)])

    def test_time_before_the_assemblys_first_result_is_not_charged(self):
        warm_up = 40
        self.assertEqual(
            self.over(trx(('A.First', warm_up, warm_up), ('A.Blocked', warm_up + 0.1, warm_up + 0.1),
                          ('A.SlowToo', warm_up + 30, warm_up + 30))),
            [('A.SlowToo', 30.0)])

    def test_each_assembly_has_its_own_warm_up(self):
        self.assertEqual(
            self.over(trx(('A.First', 1, 1), ('A.Late', 40, 30)),
                      trx(('B.First', 30, 30), ('B.Blocked', 31, 31))),
            [('A.Late', 30.0)])

    def test_main_names_each_test_and_fails_only_when_one_is_over(self):
        (self.dir / 'a.trx').write_text(trx(('A.Quick', 1, 0.5), ('A.Slow', 100, ctt.CEILING_SECONDS + 1)))
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            self.assertEqual(ctt.main([str(self.dir)]), 1)
        self.assertIn('A.Slow', printed.getvalue())
        self.assertNotIn('A.Quick', printed.getvalue())
        (self.dir / 'a.trx').write_text(trx(('A.Quick', 1, 0.5)))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ctt.main([str(self.dir)]), 0)


if __name__ == '__main__':
    unittest.main()
