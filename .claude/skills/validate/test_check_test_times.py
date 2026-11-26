"""Pins check_test_times.py: each test over a second is named, slowest first, the wall time is
printed against its budget, and nothing fails."""
import contextlib
import io
import pathlib
import tempfile
import unittest

import check_test_times as ctt
import report_fixtures as fx


class Reports(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)

    def report(self, name, text):
        (self.dir / name).write_text(text)


class OverCeiling(Reports):
    def test_a_test_over_a_second_is_named_with_its_time_and_one_under_it_is_not(self):
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Under', 5, 0.99), fx.trx_result('A.Over', 9, 1.01)))
        self.assertEqual(ctt.over_ceiling(self.dir), [('A.Over', 1.01)])

    def test_a_test_with_no_time_is_not_named(self):
        self.report('a.trx', fx.trx(fx.trx_result('A.Skipped', outcome='NotExecuted')))
        self.assertEqual(ctt.over_ceiling(self.dir), [])

    def test_the_slowest_comes_first_whichever_report_holds_it(self):
        self.report('unit.json', fx.vitest(('/repo/a.test.ts', [('quick', 'passed', 40), ('slow', 'passed', 2500)])))
        self.report('it.mocha', fx.mocha_log(passed=[('slower', 4000), ('slowest', 7000)]))
        self.assertEqual([name for name, _ in ctt.over_ceiling(self.dir)], ['slowest', 'slower', 'a.test.ts > slow'])


class Main(Reports):
    def main(self, elapsed, budget):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctt.main([str(self.dir), str(elapsed), str(budget)])
        return status, printed.getvalue()

    def test_it_names_each_test_over_the_ceiling_and_not_the_others(self):
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Quick', 5, 0.5), fx.trx_result('A.Slow', 100, 2)))
        _, printed = self.main(100, 300)
        self.assertIn('A.Slow', printed)
        self.assertNotIn('A.Quick', printed)

    def test_it_prints_the_wall_time_against_the_budget_and_says_when_it_is_over(self):
        for elapsed, line in ((213.4, 'Wall time 213 s of 300 s budget\n'), (340, 'Wall time 340 s of 300 s budget: OVER BUDGET by 40 s\n')):
            with self.subTest(elapsed=elapsed):
                self.assertIn(line, self.main(elapsed, 300)[1])

    def test_it_fails_nothing(self):
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Slow', 100, 5)))
        self.assertEqual(self.main(900, 300)[0], 0)


if __name__ == '__main__':
    unittest.main()
