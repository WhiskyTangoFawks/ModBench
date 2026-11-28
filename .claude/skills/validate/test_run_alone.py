"""Pins run_alone.py: which tests run again alone on a branch run and on a merge run, how each stack runs them one at
a time, and that a test failing alone fails the run."""
import contextlib
import io
import os
import pathlib
import tempfile
import unittest
from unittest import mock

import report_fixtures as fx
import run_alone
from reports import RAN, Result

ROOT = pathlib.Path('/repo')
ALONE = pathlib.Path('/alone')


def ran(name: str, seconds: float, box: str) -> Result:
    return Result(name, RAN, seconds, box)


class Commands(unittest.TestCase):
    A = 'MEditService.A.Tests'

    def commands(self, kind: str, *results: Result) -> list[run_alone.Command]:
        return run_alone.commands({kind: list(results)}, ROOT, ALONE, lambda _: True)

    def test_each_backend_test_over_1_s_runs_again_by_its_method_in_one_process_of_its_project_one_at_a_time(self) -> None:
        self.assertEqual(self.commands('.trx', ran('A.C.Slow', 1.5, self.A), ran('A.C.Theory(case: 1)', 2, self.A),
                                       ran('A.C.Theory(case: 2)', 3, self.A), ran('A.C.Quick', 0.9, self.A),
                                       ran('B.C.Slow', 2, 'MEditService.B.Tests')), [
            run_alone.Command(ROOT / 'MEditService', [
                'dotnet', 'test', box, '--no-build', '-v', 'quiet', '--logger', 'trx', '--results-directory', '/alone/backend',
                '--filter', methods, '--', 'xUnit.ParallelizeTestCollections=false'])
            for box, methods in ((self.A, 'FullyQualifiedName=A.C.Slow|FullyQualifiedName=A.C.Theory'),
                                 ('MEditService.B.Tests', 'FullyQualifiedName=B.C.Slow'))])

    def test_a_unittest_over_1_s_runs_again_by_its_id_in_its_folder_leaving_its_log(self) -> None:
        self.assertEqual(self.commands('.unittest', ran('test_a (test_m.C.test_a)', 1.5, 'validate'),
                                       ran('test_b (test_m.C.test_b)', 0.5, 'validate')),
                         [run_alone.Command(ROOT / '.claude/skills/validate',
                                            ['python3', '-m', 'unittest', '-v', '--durations', '0', 'test_m.C.test_a'],
                                            ALONE / 'validate.unittest')])

    def test_the_vitest_tests_over_1_s_run_again_in_one_run_of_their_files_one_file_at_a_time_matching_each_whole_name(self) -> None:
        self.assertEqual(self.commands('.json', ran('src/plugins/a.test.ts > the box (one) works', 1.5, 'plugins'),
                                       ran('webview/src/b.test.tsx > two', 2, 'webview'),
                                       ran('src/plugins/a.test.ts > quick', 0.5, 'plugins')),
                         [run_alone.Command(ROOT / 'modbench', [
                             'npx', 'vitest', 'run', '--no-file-parallelism', '--reporter=json', '--outputFile.json=/alone/unit.json',
                             '-t', r'^(the\ box\ \(one\)\ works|two)$', 'src/plugins/a.test.ts', 'webview/src/b.test.tsx'])])

    def test_the_integration_tests_over_1_s_run_again_in_one_run_of_their_runner_matching_each_title_leaving_its_log(self) -> None:
        self.assertEqual(self.commands('.mocha', ran('watches a folder (as it was)', 7, 'integration'),
                                       ran('Space disables it', 1.2, 'integration'), ran('quick', 0.5, 'integration')),
                         [run_alone.Command(ROOT / 'modbench', [
                             'node', 'integration.mjs', '--grep', r'(Space\ disables\ it|watches\ a\ folder\ \(as\ it\ was\))$'],
                             ALONE / 'integration.mocha')])


class Main(unittest.TestCase):
    """A planted gate runner test over 1 s that fails when the merge-to-main mode reaches it, or always."""
    TEST = ('import os, unittest\nclass C(unittest.TestCase):\n    def test_a(self):\n'
            '        self.assertNotIn("MEDIT_MERGE_TO_MAIN", os.environ){}\n')

    def run_alone(self, also: str = '', approved: str = '', run: str = 'branch') -> tuple[int, str, pathlib.Path]:
        root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        folder = root / '.claude/skills/validate'
        folder.mkdir(parents=True)
        (folder / 'test_m.py').write_text(self.TEST.format(also))
        (root / 'reports').mkdir()
        (root / 'reports' / 'validate.unittest').write_text(fx.unittest_log(durations=[('test_a (test_m.C.test_a)', 1.5)]))
        (root / 'budgets.toml').write_text(f'[approved]\n{approved}')
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed), mock.patch.dict(os.environ, {'MEDIT_MERGE_TO_MAIN': 'true'}):
            status = run_alone.main([str(root), str(root / 'reports'), str(root / 'alone'), str(root / 'budgets.toml'), run])
        return status, printed.getvalue(), root / 'alone' / 'validate.unittest'

    def test_a_test_runs_again_as_a_branch_run_leaving_its_log(self) -> None:
        status, _, log = self.run_alone()
        self.assertEqual(status, 0)
        self.assertIn('test_a (test_m.C.test_a) ... ok', log.read_text())

    def test_a_merge_run_runs_an_approved_test_again_for_its_lapse_in_a_process_apart_and_a_branch_run_does_not(self) -> None:
        for run, ran in (('branch', False), ('merge', True)):
            with self.subTest(run=run):
                _, _, log = self.run_alone(approved='"test_a (test_m.C.test_a)" = "r"\n', run=run)
                self.assertEqual((log.exists(), (log.parent / 'approved' / log.name).exists()), (False, ran))

    def test_a_run_with_no_test_to_run_again_leaves_its_alone_folder_for_the_time_report(self) -> None:
        _, _, log = self.run_alone(approved='"test_a (test_m.C.test_a)" = "r"\n')
        self.assertTrue(log.parent.is_dir())

    def test_a_test_failing_alone_fails_the_run_naming_its_command(self) -> None:
        status, printed, _ = self.run_alone('; self.fail("alone")')
        self.assertEqual(status, 1)
        self.assertIn('Failed alone, exit 1: python3 -m unittest -v --durations 0 test_m.C.test_a\n', printed)


if __name__ == '__main__':
    unittest.main()
