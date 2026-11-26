"""Pins check_test_times.py: its 100 ms list, the ceiling, box budgets and wall time it reports for each run, and
which of them fail the run once the switch is on."""
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
    WALLS = '[wall]\nbranch = 300\nmerge = 600\nwindows = 900\n'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)

    def report(self, name, text):
        (self.dir / name).write_text(text)

    def main(self, elapsed: float, run: str = 'branch', budgets: str = 'other = 60\n[boxes]\n') -> tuple[int, str]:
        file = self.dir / 'budgets.toml'
        file.write_text(budgets + self.WALLS)
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctt.main([str(self.dir), str(elapsed), str(file), run])
        return status, printed.getvalue()

    def with_budgets(self, text: str) -> tuple[int, str]:
        return self.main(10, budgets=text)


class SlowTests(Reports):
    def test_a_test_over_100_ms_is_named_with_its_time_and_one_under_it_is_not(self) -> None:
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Under', 5, 0.09), fx.trx_result('A.Over', 9, 0.11)))
        self.assertEqual(ctt.slow_tests(reports.results(self.dir)), [('A.Over', 0.11)])

    def test_a_test_with_no_time_is_not_named(self):
        self.report('a.trx', fx.trx(fx.trx_result('A.Skipped', outcome='NotExecuted')))
        self.assertEqual(ctt.slow_tests(reports.results(self.dir)), [])

    def test_the_slowest_comes_first_whichever_report_holds_it(self):
        self.report('unit.json', fx.vitest(('/repo/modbench/src/a.test.ts', [('quick', 'passed', 40), ('slow', 'passed', 2500)])))
        self.report('it.mocha', fx.mocha_log(passed=[('slower', 4000), ('slowest', 7000)]))
        self.assertEqual([name for name, _ in ctt.slow_tests(reports.results(self.dir))], ['slowest', 'slower', 'a.test.ts > slow'])


class Main(Reports):
    def test_it_names_each_test_over_100_ms_with_its_time_and_not_the_others(self) -> None:
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Quick', 5, 0.05), fx.trx_result('A.Slow', 100, 0.25)))
        _, printed = self.main(100)
        self.assertIn('   0.25 s  A.Slow\n--- 1 TESTS OVER 100 ms ---\n', printed)
        self.assertNotIn('A.Quick', printed)

    def test_it_prints_the_wall_time_against_its_runs_budget_and_says_when_it_is_over(self):
        for run, elapsed, line in (('branch', 213.4, 'Wall time 213 s of 300 s budget\n'),
                                   ('branch', 340, 'Wall time 340 s of 300 s budget: OVER BUDGET by 40 s\n'),
                                   ('merge', 640, 'Wall time 640 s of 600 s budget: OVER BUDGET by 40 s\n'),
                                   ('windows', 950, 'Wall time 950 s of 900 s budget: OVER BUDGET by 50 s\n')):
            with self.subTest(run=run, elapsed=elapsed):
                self.assertIn(line, self.main(elapsed, run)[1])

    def test_the_windows_run_over_its_wall_budget_fails_once_its_own_switch_is_on_and_a_linux_run_over_its_own_never_does(self):
        for run, elapsed, switch, windows_switch, status in (('windows', 950, True, False, 0), ('windows', 950, False, True, 1),
                                                             ('windows', 850, True, True, 0), ('merge', 700, True, True, 0),
                                                             ('branch', 400, True, True, 0)):
            with (self.subTest(run=run, elapsed=elapsed, switch=switch, windows_switch=windows_switch),
                  mock.patch.object(ctt, 'FAILS_THE_RUN', switch), mock.patch.object(ctt, 'WINDOWS_FAILS_THE_RUN', windows_switch)):
                self.assertEqual(self.main(elapsed, run)[0], status)


class Ceiling(Reports):
    APPROVALS = ('other = 60\n[boxes]\n"A.Tests" = 60\n'
                 '[approved]\n"A.Approved" = "r"\n"A.Theory" = "r"\n"A.Lapsed" = "r"\n"A.NotRun" = "r"\n')

    def setUp(self) -> None:
        super().setUp()
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1), fx.trx_result('A.Unapproved', 5, 2), fx.trx_result('A.Approved', 5, 3),
                                    fx.trx_result('A.Theory(case: 1)', 6, 2.5), fx.trx_result('A.Theory(case: 2)', 6, 0.5),
                                    fx.trx_result('A.Lapsed', 6, 0.4)))

    def test_it_names_each_test_over_the_ceiling_no_approval_names_by_its_own_or_its_theorys_and_each_approval_that_lapsed(self) -> None:
        """A.NotRun's approval did not run, so it did not lapse; A.Theory's lapses only once all its cases run under 1 s."""
        self.assertIn('--- 5 TESTS OVER 100 ms ---\n'
                      '   2.00 s  A.Unapproved: OVER THE 1 s CEILING, NOT APPROVED\n'
                      '   0.40 s  A.Lapsed: APPROVAL LAPSED\n'
                      '--- 1 TESTS OVER THE 1 s CEILING NOT APPROVED, 1 APPROVALS LAPSED ---\n', self.with_budgets(self.APPROVALS)[1])

    def test_an_unapproved_test_over_the_ceiling_fails_the_run_once_the_switch_is_on_and_a_lapse_never_does(self) -> None:
        all_approved = self.APPROVALS + '"A.Unapproved" = "r"\n'
        for budgets, switch, status in ((self.APPROVALS, False, 0), (self.APPROVALS, True, 1), (all_approved, True, 0)):
            with self.subTest(budgets=budgets, switch=switch), mock.patch.object(ctt, 'FAILS_THE_RUN', switch):
                self.assertEqual(self.with_budgets(budgets)[0], status)


class Boxes(Reports):
    APPROVED = '[approved]\n"A.Two" = "r"\n"a.test.ts > one" = "r"\n"test_a (m.C.test_a)" = "r"\n'
    BUDGETS = 'other = 3\n[boxes]\n"B.Tests" = 4\nplugins = 2\nwebview = 1\n'
    NO_WEBVIEW_BUDGET = 'other = 3\n[boxes]\n"B.Tests" = 4\nplugins = 2\n'

    def setUp(self) -> None:
        super().setUp()
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 1, project='B.Tests'), fx.trx_result('A.Two', 3, 2.5, project='B.Tests'),
                                    fx.trx_result('A.Skipped', outcome='NotExecuted', project='B.Tests')))
        self.report('unit.json', fx.vitest(('/repo/modbench/src/plugins/a.test.ts', [('one', 'passed', 1500)]),
                                           ('/repo/modbench/webview/b.test.tsx', [('two', 'passed', 500)])))
        self.report('hooks.unittest', fx.unittest_log(durations=[('test_a (m.C.test_a)', 1.25)]))

    def with_budgets(self, text: str) -> tuple[int, str]:
        return super().with_budgets(text + self.APPROVED)


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
        _, printed = self.with_budgets(self.NO_WEBVIEW_BUDGET)
        self.assertIn('    0.5 s  webview: NO BUDGET\n', printed)
        self.assertIn('--- 1 BUDGETS OVERRUN OR MISSING ---\n', printed)

    def test_a_budget_overrun_or_a_box_with_none_fails_the_run_once_the_switch_is_on_and_not_before(self) -> None:
        overrun = 'other = 3\n[boxes]\n"B.Tests" = 1\nplugins = 2\nwebview = 1\n'
        missing = self.NO_WEBVIEW_BUDGET
        for budgets, switch, status in ((overrun, False, 0), (overrun, True, 1), (missing, False, 0), (missing, True, 1),
                                        (self.BUDGETS, True, 0)):
            with self.subTest(budgets=budgets, switch=switch), mock.patch.object(ctt, 'FAILS_THE_RUN', switch):
                self.assertEqual(self.with_budgets(budgets)[0], status)

    def test_the_windows_run_prints_each_boxs_summed_time_most_first_and_fails_on_no_box_and_no_ceiling_though_both_switches_are_on(self) -> None:
        overrun = 'other = 1\n[boxes]\n"B.Tests" = 1\n'
        with mock.patch.object(ctt, 'FAILS_THE_RUN', True), mock.patch.object(ctt, 'WINDOWS_FAILS_THE_RUN', True):
            status, printed = self.main(10, 'windows', overrun)
        self.assertIn('--- 4 TESTS OVER 100 ms ---\n    2.0 s  B.Tests\n    1.5 s  plugins\n    1.2 s  hooks\n    0.5 s  webview\n'
                      'Wall time 10 s of 900 s budget\n', printed)
        self.assertEqual(status, 0)


if __name__ == '__main__':
    unittest.main()
