"""Pins check_test_times.py: its 100 ms list, the ceiling, box budgets and wall time it reports for each run, that
only the ceiling fails the run, and the yellow flag it raises on each lapse and overrun."""
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

    def main(self, elapsed: float, run: str = 'branch', budgets: str = 'other = 60\n[boxes]\n',
             alone: pathlib.Path | None = None) -> tuple[int, str]:
        file = self.dir / 'budgets.toml'
        file.write_text(budgets + self.WALLS)
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            status = ctt.main([str(self.dir), str(elapsed), str(file), run, *([str(alone)] if alone else [])])
        return status, printed.getvalue()

    def with_budgets(self, text: str) -> tuple[int, str]:
        return self.main(10, budgets=text)


class SlowTests(Reports):
    def test_a_test_over_100_ms_is_named_with_its_time_and_one_under_it_is_not(self) -> None:
        self.report('a.trx', fx.trx(fx.trx_result('A.Under', 5, 0.09), fx.trx_result('A.Over', 9, 0.11)))
        self.assertEqual(ctt.slow_tests(reports.results(self.dir)), [('A.Over', 0.11)])

    def test_a_test_with_no_time_is_not_named(self):
        self.report('a.trx', fx.trx(fx.trx_result('A.Skipped', outcome='NotExecuted')))
        self.assertEqual(ctt.slow_tests(reports.results(self.dir)), [])

    def test_the_slowest_comes_first_whichever_report_holds_it(self):
        self.report('unit.json', fx.vitest(('/repo/modbench/src/a.test.ts', [('quick', 'passed', 40), ('slow', 'passed', 2500)])))
        self.report('it.mocha', fx.mocha_log(passed=[('slower', 4000), ('slowest', 7000)]))
        self.assertEqual([name for name, _ in ctt.slow_tests(reports.results(self.dir))], ['slowest', 'slower', 'src/a.test.ts > slow'])


class Main(Reports):
    def test_it_names_each_test_over_100_ms_with_its_time_and_not_the_others(self) -> None:
        self.report('a.trx', fx.trx(fx.trx_result('A.Quick', 5, 0.05), fx.trx_result('A.Slow', 100, 0.25)))
        _, printed = self.main(100)
        self.assertIn('   0.25 s  A.Slow\n--- 1 TESTS OVER 100 ms ---\n', printed)
        self.assertNotIn('A.Quick', printed)

    def test_it_prints_the_wall_time_against_its_runs_budget_and_ends_with_a_flag_failing_nothing_when_it_is_over(self):
        for run, elapsed, end in (('branch', 213.4, 'Wall time 213 s of 300 s budget\n'),
                                  ('branch', 340, 'Wall time 340 s of 300 s budget\n'
                                                  'YELLOW FLAG: the branch run took 340 s, over its 300 s budget by 40 s\n'),
                                  ('merge', 640, 'Wall time 640 s of 600 s budget\n'
                                                 'YELLOW FLAG: the merge run took 640 s, over its 600 s budget by 40 s\n'),
                                  ('windows', 950, 'Wall time 950 s of 900 s budget\n'
                                                   'YELLOW FLAG: the windows run took 950 s, over its 900 s budget by 50 s\n')):
            with self.subTest(run=run, elapsed=elapsed), mock.patch.object(ctt, 'FAILS_THE_RUN', True):
                status, printed = self.main(elapsed, run)
                self.assertTrue(printed.endswith(end), printed)
                self.assertEqual(status, 0)


class Ceiling(Reports):
    APPROVALS = ('other = 60\n[boxes]\n"A.Tests" = 60\n[approved]\n"A.SlowAlone" = "r"\n"A.Theory" = "r"\n'
                 '"A.Lapsed" = "r"\n"A.FastAloneApproved" = "r"\n"A.NotRun" = "r"\n')

    def setUp(self) -> None:
        super().setUp()
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 0.05), fx.trx_result('A.Unapproved', 5, 2),
                                    fx.trx_result('A.SlowAlone', 5, 3), fx.trx_result('A.FastAlone', 5, 2),
                                    fx.trx_result('A.FastAloneApproved', 5, 2),
                                    fx.trx_result('A.Theory(case: 1)', 6, 2.5), fx.trx_result('A.Theory(case: 2)', 6, 1.5),
                                    fx.trx_result('A.Lapsed', 6, 0.4)))
        alone = tempfile.TemporaryDirectory()
        self.addCleanup(alone.cleanup)
        self.alone = pathlib.Path(alone.name)
        (self.alone / 'a.trx').write_text(fx.trx(
            fx.trx_result('A.Unapproved', 3, 1.5), fx.trx_result('A.SlowAlone', 5, 2),
            fx.trx_result('A.FastAlone', 6, 0.5), fx.trx_result('A.FastAloneApproved', 7, 0.5),
            fx.trx_result('A.Theory(case: 1)', 9, 1.5), fx.trx_result('A.Theory(case: 2)', 10, 0.5)))

    def judged(self, budgets: str, run: str = 'merge') -> tuple[int, str]:
        return self.main(10, run, budgets=budgets, alone=self.alone)

    def test_every_run_names_each_test_over_the_ceiling_no_approval_names_by_its_own_or_its_theorys_and_flags_each_approval_that_lapsed(self) -> None:
        """A.NotRun's approval did not run, so it did not lapse; A.Theory's lapses only once all its cases run under 1 s alone."""
        for run in ('branch', 'merge'):
            with self.subTest(run=run):
                _, printed = self.judged(self.APPROVALS, run)
                self.assertIn('   1.50 s  A.Unapproved: OVER THE 1 s CEILING ALONE, NOT APPROVED\n'
                              '--- 6 TESTS OVER 1 s RUN AGAIN ALONE, 1 OVER THE CEILING NOT APPROVED ---\n', printed)
                self.assertTrue(printed.endswith('YELLOW FLAG: A.FastAloneApproved took 0.50 s at most, so its approval lapsed\n'
                                                 'YELLOW FLAG: A.Lapsed took 0.40 s at most, so its approval lapsed\n'), printed)

    def test_an_unapproved_test_over_the_ceiling_fails_the_run_once_the_switch_is_on_and_a_lapse_never_does(self) -> None:
        all_approved = self.APPROVALS + '"A.Unapproved" = "r"\n'
        for budgets, switch, status in ((self.APPROVALS, False, 0), (self.APPROVALS, True, 1), (all_approved, True, 0)):
            with self.subTest(budgets=budgets, switch=switch), mock.patch.object(ctt, 'FAILS_THE_RUN', switch):
                self.assertEqual(self.judged(budgets)[0], status)

    def test_a_test_that_ran_alone_twice_is_judged_on_its_faster_run(self) -> None:
        (self.alone / 'b.trx').write_text(fx.trx(fx.trx_result('A.Unapproved', 3, 0.5)))
        self.assertIn('--- 6 TESTS OVER 1 s RUN AGAIN ALONE, 0 OVER THE CEILING NOT APPROVED', self.judged(self.APPROVALS)[1])

    def test_a_test_under_1_s_under_load_that_ran_alone_beside_one_over_it_is_judged_under_load(self) -> None:
        (self.alone / 'b.trx').write_text(fx.trx(fx.trx_result('A.First', 3, 3), fx.trx_result('A.Unapproved', 3.4, 0.4)))
        _, printed = self.judged(self.APPROVALS)
        self.assertNotIn('A.First', printed)
        self.assertIn('--- 6 TESTS OVER 1 s RUN AGAIN ALONE, 0 OVER THE CEILING NOT APPROVED', printed)

    def test_a_test_slow_alone_that_ran_again_by_itself_fails(self) -> None:
        (self.alone / 'a.trx').write_text(fx.trx(fx.trx_result('A.Unapproved', 3, 1.5)))
        self.assertIn('   1.50 s  A.Unapproved: OVER THE 1 s CEILING ALONE, NOT APPROVED\n', self.judged(self.APPROVALS)[1])

    def test_a_test_over_the_ceiling_under_load_that_did_not_run_again_alone_is_judged_on_its_time_under_load(self) -> None:
        (self.alone / 'a.trx').unlink()
        self.assertIn('   2.00 s  A.Unapproved: OVER THE 1 s CEILING, NOT APPROVED\n', self.judged(self.APPROVALS)[1])


class Boxes(Reports):
    APPROVED = '[approved]\n"A.Two" = "r"\n"src/plugins/a.test.ts > one" = "r"\n"test_a (m.C.test_a)" = "r"\n'
    BUDGETS = 'other = 3\n[boxes]\n"B.Tests" = 4\nplugins = 2\nwebview = 1\n'

    def setUp(self) -> None:
        super().setUp()
        self.report('a.trx', fx.trx(fx.trx_result('A.First', 1, 0, project='B.Tests'), fx.trx_result('A.Two', 3, 2, project='B.Tests'),
                                    fx.trx_result('A.Skipped', outcome='NotExecuted', project='B.Tests')))
        self.report('unit.json', fx.vitest(('/repo/modbench/src/plugins/a.test.ts', [('one', 'passed', 1500)]),
                                           ('/repo/modbench/webview/b.test.tsx', [('two', 'passed', 500)])))
        self.report('hooks.unittest', fx.unittest_log(durations=[('test_a (m.C.test_a)', 1.25)]))

    def with_budgets(self, text: str) -> tuple[int, str]:
        return super().with_budgets(text + self.APPROVED)


    def test_it_prints_each_box_against_its_budget_and_the_tests_of_no_box_together_against_other(self) -> None:
        self.assertIn('    2.0 s of    4 s  B.Tests\n    1.5 s of    2 s  plugins\n    0.5 s of    1 s  webview\n'
                      '    1.2 s of    3 s  the tests of no box\n      1.2 s  hooks\nWall time 10 s of 300 s budget\n',
                      self.with_budgets(self.BUDGETS)[1])

    def test_a_box_over_its_budget_or_with_none_ends_the_report_with_a_flag_and_fails_nothing_though_the_switch_is_on(self) -> None:
        with mock.patch.object(ctt, 'FAILS_THE_RUN', True):
            status, printed = self.with_budgets('other = 1\n[boxes]\n"B.Tests" = 1.5\nplugins = 2\n')
        self.assertIn('    2.0 s of  1.5 s  B.Tests\n    1.5 s of    2 s  plugins\n    0.5 s  webview\n', printed)
        self.assertTrue(printed.endswith('Wall time 10 s of 300 s budget\n'
                                         'YELLOW FLAG: B.Tests took 2.0 s, over its 1.5 s budget by 0.5 s\n'
                                         'YELLOW FLAG: webview took 0.5 s, and has no budget\n'
                                         'YELLOW FLAG: the tests of no box took 1.2 s, over its 1 s budget by 0.2 s\n'), printed)
        self.assertEqual(status, 0)

    def test_the_windows_run_prints_each_boxs_summed_time_most_first_and_flags_no_box_and_judges_no_ceiling(self) -> None:
        overrun = 'other = 1\n[boxes]\n"B.Tests" = 1\n'
        with mock.patch.object(ctt, 'FAILS_THE_RUN', True):
            status, printed = self.main(10, 'windows', overrun)
        self.assertTrue(printed.endswith('--- 4 TESTS OVER 100 ms ---\n    2.0 s  B.Tests\n    1.5 s  plugins\n    1.2 s  hooks\n'
                                         '    0.5 s  webview\nWall time 10 s of 900 s budget\n'), printed)
        self.assertEqual(status, 0)


if __name__ == '__main__':
    unittest.main()
