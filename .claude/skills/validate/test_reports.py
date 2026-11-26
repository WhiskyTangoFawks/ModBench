"""Pins reports.py: each stack's report reads into a result that names the test, whether it ran or
skipped, its time and its box, and a run's directory reads whole."""
import pathlib
import tempfile
import unittest

import report_fixtures as fx
import reports
from reports import RAN, SKIPPED, Result


class Readers(unittest.TestCase):
    def test_a_trx_result_is_skipped_when_not_executed_and_carries_the_time_after_the_assemblys_first_result(self):
        self.assertEqual(
            reports.in_trx(fx.trx(
                fx.trx_result('A.First', 40, 40), fx.trx_result('A.Blocked', 40.1, 40.1), fx.trx_result('A.Slow', 43, 43),
                fx.trx_result('A.Skipped(x: 1)', outcome='NotExecuted'))),
            [Result('A.First', RAN, 0, 'A.Tests'), Result('A.Blocked', RAN, 0.1, 'A.Tests'), Result('A.Slow', RAN, 3, 'A.Tests'),
             Result('A.Skipped(x: 1)', SKIPPED, None, 'A.Tests')])

    def test_a_trx_results_box_is_the_test_project_whose_assembly_ran_it(self):
        self.assertEqual(
            [result.box for result in reports.in_trx(fx.trx(
                fx.trx_result('A.One', 1, 1, project='MEditService.Http.Tests'),
                fx.trx_result('B.Two', 2, 1, project='MEditService.TestSupport')))],
            ['MEditService.Http.Tests', 'MEditService.TestSupport'])

    def test_a_vitest_tests_box_is_its_folder_under_src_or_else_under_modbench(self):
        ran: list[tuple[str, str, float | None]] = [('t', 'passed', 1)]
        files = [(f'/home/me/modbench/modbench/{path}', ran) for path in (
            'src/instanceAdapter/a.test.ts', 'src/test/b.test.ts', 'webview/src/c.test.tsx', 'src/d.test.ts')]
        self.assertEqual([result.box for result in reports.in_vitest(fx.vitest(*files))],
                         ['instanceAdapter', 'test', 'webview', 'src'])

    def test_a_vitest_test_is_named_with_its_file_and_is_skipped_when_pending_or_todo(self):
        self.assertEqual(
            reports.in_vitest(fx.vitest(('/repo/modbench/src/a.test.ts', [
                ('ran', 'passed', 2500), ('skipped', 'pending', None), ('todo', 'todo', None)]))),
            [Result('a.test.ts > ran', RAN, 2.5, 'src'), Result('a.test.ts > skipped', SKIPPED, None, 'src'),
             Result('a.test.ts > todo', SKIPPED, None, 'src')])

    def test_a_unittest_log_holds_each_skip_by_name_and_each_other_tests_time_from_its_durations(self):
        self.assertEqual(
            reports.in_unittest(fx.unittest_log(
                skipped=['test_s (m.C.test_s)'], durations=[('test_s (m.C.test_s)', 0.0), ('test_a (m.C.test_a)', 1.5)]), 'hooks'),
            [Result('test_s (m.C.test_s)', SKIPPED, None, 'hooks'), Result('test_a (m.C.test_a)', RAN, 1.5, 'hooks')])

    def test_a_unittest_log_whose_skip_line_is_split_by_output_still_counts_the_skip(self):
        self.assertEqual(reports.in_unittest("test_x (m.C.test_x) ... printed\nskipped 'r'\n\nOK (skipped=1)\n", 'hooks'),
                         [Result('1 skipped, unnamed', SKIPPED, None, 'hooks')])

    def test_a_mocha_log_holds_each_pending_test_and_each_passed_test_with_its_time(self):
        self.assertEqual(reports.in_mocha(fx.mocha_log(passed=[('slow', 1234)], pending=['skipped']), 'integration'),
                         [Result('skipped', SKIPPED, None, 'integration'), Result('slow', RAN, 1.234, 'integration')])

    def test_a_mocha_log_without_pending_tests_holds_none_though_a_line_starts_with_a_dash(self):
        self.assertEqual(reports.in_mocha('  - a dash in output\n  2 passing (303ms)\n', 'integration'), [])


class Results(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)

    def test_it_reads_the_reports_in_every_folder_below_it(self):
        (self.dir / 'backend' / 'nested').mkdir(parents=True)
        (self.dir / 'backend' / 'nested' / 'a.trx').write_text(fx.trx(fx.trx_result('A.Skipped', outcome='NotExecuted')))
        self.assertEqual(reports.results(self.dir), [Result('A.Skipped', SKIPPED, None, 'A.Tests')])

    def test_it_reads_what_powershell_writes_to_a_log_a_byte_order_mark_and_crlf_lines(self):
        written = (b'\xef\xbb\xbf    \xe2\x9c\x94 tick (5ms)\r\n    \xe2\x88\x9a root (1234ms)\r\n'
                   b'    \xe2\x9c\x94 slow (7609ms)\r\n\r\n  3 passing (9s)\r\n')
        (self.dir / 'integration.mocha').write_bytes(written)
        self.assertEqual(reports.results(self.dir),
                         [Result('tick', RAN, 0.005, 'integration'), Result('root', RAN, 1.234, 'integration'),
                          Result('slow', RAN, 7.609, 'integration')])

    def test_it_fails_when_the_folder_does_not_exist(self):
        with self.assertRaises(SystemExit) as refused:
            reports.results(self.dir / 'missing')
        self.assertIn('No reports folder', str(refused.exception))


if __name__ == '__main__':
    unittest.main()
