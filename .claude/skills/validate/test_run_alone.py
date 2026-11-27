"""Pins run_alone.py: which tests run again alone, how each stack runs them one at a time, and that a test
failing alone fails the run."""
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


class Backend(unittest.TestCase):
    """A planted backend run under load, and a fake dotnet test that writes each run's TRX in the order given."""

    def setUp(self) -> None:
        self.dir = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        (self.dir / 'reports').mkdir()
        self.runs: list[list[str]] = []

    @staticmethod
    def one_at_a_time(*tests: tuple[str, float]) -> str:
        """A TRX of the tests run one after another, first first, each with its seconds."""
        ends = [sum(seconds for _, seconds in tests[:index + 1]) for index in range(len(tests))]
        return fx.trx(*(fx.trx_result(name, end, seconds, project='MEditService.A.Tests') for (name, seconds), end in zip(tests, ends)))

    def load(self, *tests: tuple[str, float]) -> None:
        (self.dir / 'reports' / 'load.trx').write_text(self.one_at_a_time(*tests))

    def again(self, *orders: list[tuple[str, float]]) -> list[list[str]]:
        """Each order is a run's tests, first first, with its seconds alone."""
        def execute(command: run_alone.Command) -> bool:
            self.runs.append(command.argv)
            results = pathlib.Path(command.argv[command.argv.index('--results-directory') + 1])
            results.mkdir(parents=True, exist_ok=True)
            name = command.argv[command.argv.index('--logger') + 1].removeprefix('trx;LogFileName=')
            (results / name).write_text(self.one_at_a_time(*orders[len(self.runs) - 1]))
            return True
        run_alone.run_again(ROOT, self.dir / 'reports', self.dir / 'alone', execute)
        return [argv[argv.index('--filter') + 1].split('|') for argv in self.runs]

    def test_each_backend_test_over_1_s_runs_again_by_its_method_in_one_process_of_its_project_one_at_a_time(self) -> None:
        self.load(('A.C.Slow', 1.5), ('A.C.Theory(case: 1)', 2), ('A.C.Quick', 0.9))
        self.again([('A.C.Quick', 0.5), ('A.C.Slow', 0.5)])
        self.assertEqual(self.runs, [['dotnet', 'test', 'MEditService.A.Tests', '--no-build', '-v', 'quiet',
                                      '--logger', 'trx;LogFileName=0.trx', '--results-directory',
                                      str(self.dir / 'alone/backend/MEditService.A.Tests'), '--filter',
                                      'FullyQualifiedName=A.C.Slow|FullyQualifiedName=A.C.Theory', '--',
                                      'xUnit.ParallelizeTestCollections=false']])

    def test_a_first_test_over_1_s_runs_again_beside_one_of_another_class_until_another_runs_first(self) -> None:
        self.load(('A.C.Slow', 1.5), ('A.C.Same', 2), ('A.E.Other', 2))
        self.assertEqual(self.again([('A.C.Slow', 3), ('A.C.Same', 0.5), ('A.E.Other', 0.5)], [('A.E.Other', 0.5), ('A.C.Slow', 0.4)],
                                    [('A.C.Slow', 3), ('A.E.Other', 0.5)]),
                         [['FullyQualifiedName=A.C.Same', 'FullyQualifiedName=A.C.Slow', 'FullyQualifiedName=A.E.Other'],
                          ['FullyQualifiedName=A.C.Slow', 'FullyQualifiedName=A.E.Other']])

    def test_a_lone_test_over_1_s_runs_again_beside_its_projects_fastest_and_stops_after_two_more_runs(self) -> None:
        self.load(('A.C.Slow', 1.5), ('A.D.Fast', 0.01), ('A.D.Faster', 0.001))
        self.assertEqual(self.again(*[[('A.C.Slow', 3)]] * 3),
                         [['FullyQualifiedName=A.C.Slow']] + [['FullyQualifiedName=A.C.Slow', 'FullyQualifiedName=A.D.Faster']] * 2)


class Others(unittest.TestCase):
    def test_a_unittest_over_1_s_runs_again_by_its_id_in_its_folder_leaving_its_log(self) -> None:
        results = [ran('test_a (test_m.C.test_a)', 1.5, 'validate'), ran('test_b (test_m.C.test_b)', 0.5, 'validate')]
        self.assertEqual(run_alone.others({'.unittest': results}, ROOT, ALONE), [run_alone.Command(
            ROOT / '.claude/skills/validate', ['python3', '-m', 'unittest', '-v', '--durations', '0', 'test_m.C.test_a'],
            ALONE / 'validate.unittest')])

    def test_the_vitest_tests_over_1_s_run_again_in_one_run_of_their_files_one_file_at_a_time_matching_each_whole_name(self) -> None:
        results = [ran('a.test.ts > the box (one) works', 1.5, 'plugins'), ran('b.test.tsx > two', 2, 'webview'),
                   ran('a.test.ts > quick', 0.5, 'plugins')]
        self.assertEqual(run_alone.others({'.json': results}, ROOT, ALONE), [run_alone.Command(ROOT / 'modbench', [
            'npx', 'vitest', 'run', '--no-file-parallelism', '--reporter=json', '--outputFile.json=/alone/unit.json',
            '-t', r'^(the\ box\ \(one\)\ works|two)$', '/a.test.ts', '/b.test.tsx'])])

    def test_an_integration_test_does_not_run_again(self) -> None:
        self.assertEqual(run_alone.others({'.mocha': [ran('watches a folder', 7, 'integration')]}, ROOT, ALONE), [])


class Main(unittest.TestCase):
    """A planted gate runner test over 1 s that fails when the merge-to-main mode reaches it, or always."""
    TEST = ('import os, unittest\nclass C(unittest.TestCase):\n    def test_a(self):\n'
            '        self.assertNotIn("MEDIT_MERGE_TO_MAIN", os.environ){}\n')

    def run_alone(self, also: str) -> tuple[int, str, pathlib.Path]:
        root = pathlib.Path(self.enterContext(tempfile.TemporaryDirectory()))
        folder = root / '.claude/skills/validate'
        folder.mkdir(parents=True)
        (folder / 'test_m.py').write_text(self.TEST.format(also))
        (root / 'reports').mkdir()
        (root / 'reports' / 'validate.unittest').write_text(fx.unittest_log(durations=[('test_a (test_m.C.test_a)', 1.5)]))
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed), mock.patch.dict(os.environ, {'MEDIT_MERGE_TO_MAIN': 'true'}):
            status = run_alone.main([str(root), str(root / 'reports'), str(root / 'alone')])
        return status, printed.getvalue(), root / 'alone' / 'validate.unittest'

    def test_a_test_runs_again_as_a_branch_run_leaving_its_log(self) -> None:
        status, _, log = self.run_alone('')
        self.assertEqual(status, 0)
        self.assertIn('test_a (test_m.C.test_a) ... ok', log.read_text())

    def test_a_test_failing_alone_fails_the_run_naming_its_command(self) -> None:
        status, printed, _ = self.run_alone('; self.fail("alone")')
        self.assertEqual(status, 1)
        self.assertIn('Failed alone, exit 1: python3 -m unittest -v --durations 0 test_m.C.test_a\n', printed)


if __name__ == '__main__':
    unittest.main()
