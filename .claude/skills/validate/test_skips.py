"""Pins skips.py: each stack's report names the tests it skipped, and a run's directory names them all."""
import contextlib
import io
import json
import pathlib
import tempfile
import unittest

import skips

TRX = ('<?xml version="1.0" encoding="utf-8"?>\n'
       '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>\n'
       '<UnitTestResult testName="A.Ran" outcome="Passed" />\n'
       '<UnitTestResult testName="A.Skipped(x: 1)" outcome="NotExecuted" />\n'
       '</Results></TestRun>\n')

VITEST = json.dumps({'testResults': [{'name': '/repo/src/a.test.ts', 'assertionResults': [
    {'fullName': 'ran', 'status': 'passed'},
    {'fullName': 'skipped', 'status': 'pending'},
    {'fullName': 'todo', 'status': 'todo'}]}]})

UNITTEST = ("test_ran (m.C.test_ran) ... ok\n"
            "test_skipped (m.C.test_skipped) ... skipped 'no python'\n"
            "Ran 2 tests in 0.1s\n\nOK (skipped=1)\n")

MOCHA = "  a suite\n    ✔ ran\n    - skipped\n\n  1 passing\n  1 pending\n"


class Skipped(unittest.TestCase):
    def test_a_trx_names_each_test_not_executed(self):
        self.assertEqual(skips.in_trx(TRX), ['A.Skipped(x: 1)'])

    def test_a_vitest_report_names_each_test_pending_or_todo_with_its_file(self):
        self.assertEqual(skips.in_vitest(VITEST), ['a.test.ts > skipped', 'a.test.ts > todo'])

    def test_a_unittest_log_names_each_test_skipped(self):
        self.assertEqual(skips.in_unittest(UNITTEST), ['test_skipped (m.C.test_skipped)'])

    def test_a_unittest_log_whose_skip_line_is_split_by_output_still_counts_the_skip(self):
        self.assertEqual(skips.in_unittest("test_x (m.C.test_x) ... printed\nskipped 'r'\n\nOK (skipped=1)\n"),
                         ['1 skipped, unnamed'])

    def test_a_mocha_log_names_each_test_pending(self):
        self.assertEqual(skips.in_mocha(MOCHA), ['skipped'])

    def test_a_mocha_log_without_pending_tests_names_none_though_a_line_starts_with_a_dash(self):
        self.assertEqual(skips.in_mocha("  - a dash in output\n  2 passing\n"), [])


class Main(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)

    def run_main(self, *directories):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            code = skips.main([str(directory) for directory in directories])
        return code, printed.getvalue()

    def test_it_names_every_stacks_skip_and_fails(self):
        (self.dir / 'a.trx').write_text(TRX)
        (self.dir / 'unit.json').write_text(VITEST)
        (self.dir / 'hooks.unittest').write_text(UNITTEST)
        (self.dir / 'it.mocha').write_text(MOCHA)
        code, printed = self.run_main(self.dir)
        self.assertEqual(
            (code, printed.splitlines()),
            (1, ['skipped  A.Skipped(x: 1)', 'skipped  test_skipped (m.C.test_skipped)', 'skipped  skipped',
                 'skipped  a.test.ts > skipped', 'skipped  a.test.ts > todo', '--- 5 TESTS SKIPPED ---']))

    def test_it_reads_every_directory_it_is_given(self):
        other = self.dir / 'other'
        other.mkdir()
        (other / 'a.trx').write_text(TRX)
        code, printed = self.run_main(self.dir, other)
        self.assertEqual(code, 1)
        self.assertIn('A.Skipped', printed)

    def test_it_passes_when_nothing_skipped(self):
        (self.dir / 'a.trx').write_text(TRX.replace('NotExecuted', 'Passed'))
        self.assertEqual(self.run_main(self.dir), (0, ''))


if __name__ == '__main__':
    unittest.main()
