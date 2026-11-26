"""Pins check_test_times.py: each test over 100 ms is named, each box's summed time is printed against its
budget, and a box over it or without one fails the run once the switch is on, only where budgets are given."""
import contextlib
import io
import pathlib
import tempfile
import unittest
from unittest import mock

import check_test_times as ctt
import report_fixtures as fx
import reports


class Reports(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)

    def report(self, name, text):
        (self.dir / name).write_text(text)

    def main(self, elapsed: float, budget: float, budgets_file: str | None = None) -> tuple[int, str]:
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctt.main([str(self.dir), str(elapsed), str(budget), *([budgets_file] if budgets_file else [])])
        return status, printed.getvalue()


class OverPointer(Reports):
    def test_a_test_over_100_ms_is_named_with_its_time_and_one_under_it_is_not(self) -> None:
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Under', 5, 0.09), fx.trx_result('A.Over', 9, 0.11)))
        self.assertEqual(ctt.over_pointer(reports.results(self.dir)), [('A.Over', 0.11)])

    def test_a_test_with_no_time_is_not_named(self):
        self.report('a.trx', fx.trx(fx.trx_result('A.Skipped', outcome='NotExecuted')))
        self.assertEqual(ctt.over_pointer(reports.results(self.dir)), [])

    def test_the_slowest_comes_first_whichever_report_holds_it(self):
        self.report('unit.json', fx.vitest(('/repo/modbench/src/a.test.ts', [('quick', 'passed', 40), ('slow', 'passed', 2500)])))
        self.report('it.mocha', fx.mocha_log(passed=[('slower', 4000), ('slowest', 7000)]))
        self.assertEqual([name for name, _ in ctt.over_pointer(reports.results(self.dir))], ['slowest', 'slower', 'a.test.ts > slow'])


class Main(Reports):
    def test_it_names_each_test_over_100_ms_with_its_time_and_not_the_others(self) -> None:
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Quick', 5, 0.05), fx.trx_result('A.Slow', 100, 0.25)))
        _, printed = self.main(100, 300)
        self.assertIn('   0.25 s  A.Slow\n--- 1 TESTS OVER 100 ms ---\n', printed)
        self.assertNotIn('A.Quick', printed)

    def test_it_prints_the_wall_time_against_the_budget_and_says_when_it_is_over(self):
        for elapsed, line in ((213.4, 'Wall time 213 s of 300 s budget\n'), (340, 'Wall time 340 s of 300 s budget: OVER BUDGET by 40 s\n')):
            with self.subTest(elapsed=elapsed):
                self.assertIn(line, self.main(elapsed, 300)[1])


class Boxes(Reports):
    BUDGETS = 'other = 3\n[boxes]\n"B.Tests" = 4\nplugins = 2\nwebview = 1\n'

    def setUp(self) -> None:
        super().setUp()
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1, project='B.Tests'), fx.trx_result('A.Two', 3, 2.5, project='B.Tests'),
                                    fx.trx_result('A.Skipped', outcome='NotExecuted', project='B.Tests')))
        self.report('unit.json', fx.vitest(('/repo/modbench/src/plugins/a.test.ts', [('one', 'passed', 1500)]),
                                           ('/repo/modbench/webview/b.test.tsx', [('two', 'passed', 500)])))
        self.report('hooks.unittest', fx.unittest_log(durations=[('test_a (m.C.test_a)', 1.25)]))

    def with_budgets(self, text: str) -> tuple[int, str]:
        budgets = self.dir / 'budgets.toml'
        budgets.write_text(text)
        return self.main(10, 300, str(budgets))

    def test_with_no_budgets_it_prints_each_boxs_summed_time_most_first(self) -> None:
        self.assertIn('    2.0 s  B.Tests\n    1.5 s  plugins\n    1.2 s  hooks\n    0.5 s  webview\n', self.main(10, 300)[1])

    def test_it_prints_each_box_against_its_budget_and_the_tests_of_no_box_together_against_other(self) -> None:
        self.assertIn('    2.0 s of    4 s  B.Tests\n    1.5 s of    2 s  plugins\n    0.5 s of    1 s  webview\n'
                      '    1.2 s of    3 s  the tests of no box\n      1.2 s  hooks\n--- 0 BUDGETS OVERRUN OR MISSING ---\n',
                      self.with_budgets(self.BUDGETS)[1])

    def test_a_box_and_the_tests_of_no_box_over_their_budgets_are_each_said_to_be(self) -> None:
        _, printed = self.with_budgets('other = 1\n[boxes]\n"B.Tests" = 1.5\nplugins = 2\nwebview = 1\n')
        self.assertIn('    2.0 s of  1.5 s  B.Tests: OVER BUDGET by 0.5 s\n', printed)
        self.assertIn('    1.2 s of    1 s  the tests of no box: OVER BUDGET by 0.2 s\n', printed)
        self.assertIn('--- 2 BUDGETS OVERRUN OR MISSING ---\n', printed)

    def test_a_box_the_file_does_not_name_is_said_to_have_no_budget(self) -> None:
        _, printed = self.with_budgets('other = 3\n[boxes]\n"B.Tests" = 4\nplugins = 2\n')
        self.assertIn('    0.5 s  webview: NO BUDGET\n', printed)
        self.assertIn('--- 1 BUDGETS OVERRUN OR MISSING ---\n', printed)

    def test_a_budget_overrun_or_a_box_with_none_fails_the_run_once_the_switch_is_on_and_not_before(self) -> None:
        overrun = 'other = 3\n[boxes]\n"B.Tests" = 1\nplugins = 2\nwebview = 1\n'
        missing = 'other = 3\n[boxes]\n"B.Tests" = 4\nplugins = 2\n'
        for budgets, switch, status in ((overrun, False, 0), (overrun, True, 1), (missing, False, 0), (missing, True, 1)):
            with self.subTest(budgets=budgets, switch=switch), mock.patch.object(ctt, 'FAILS_THE_RUN', switch):
                self.assertEqual(self.with_budgets(budgets)[0], status)

    def test_a_run_given_no_budgets_fails_on_none_though_the_switch_is_on(self) -> None:
        with mock.patch.object(ctt, 'FAILS_THE_RUN', True):
            self.assertEqual(self.main(900, 300)[0], 0)


if __name__ == '__main__':
    unittest.main()
