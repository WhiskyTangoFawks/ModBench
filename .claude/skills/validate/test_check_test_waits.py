"""Pins check_test_waits.py: a wait on real time in a test's source fails, and a wait on a value, production code
and an allowed line pass."""
import contextlib
import io
import pathlib
import subprocess
import tempfile
import unittest

import check_test_waits as ctw

BACKEND_TEST = 'MEditService/MEditService.Http.Tests/Api/WaitTests.cs'
ALLOWED_PATH, ALLOWED_LINE = next(iter(ctw.ALLOWED))


class Waits(unittest.TestCase):
    def test_a_wait_on_real_time_in_a_test_is_named_by_its_path_and_line(self):
        for path, line in ((BACKEND_TEST, 'await Task.Delay(50);'),
                           ('MEditService/MEditService.TestSupport/Fixtures.cs', 'Thread.Sleep(TimeSpan.FromMilliseconds(10));'),
                           (f'/home/x/modbench/{BACKEND_TEST}', 'Assert.Same(t, await Task.WhenAny(t, Task.Delay(Patience)));')):
            with self.subTest(path=path, line=line):
                self.assertEqual(ctw.waits(path, f'class T\n{{\n    {line}\n}}'), [ctw.Wait(path, 3, line)])

    def test_a_wait_on_a_value_production_code_and_an_allowed_line_pass(self):
        for path, line in ((BACKEND_TEST, 'await Task.Delay(Timeout.Infinite, cancellationToken);'),
                           ('MEditService/MEditService.RecordIndex/Indexer.cs', 'await Task.Delay(interval, _timeProvider);'),
                           (BACKEND_TEST, 'await reading.Task.WaitAsync(Waits.Patience);'),
                           (ALLOWED_PATH, ALLOWED_LINE)):
            with self.subTest(path=path, line=line):
                self.assertEqual(ctw.waits(path, f'    {line}\n'), [])


class Tree(unittest.TestCase):
    def run_over(self, source: str) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / BACKEND_TEST).parent.mkdir(parents=True)
            (root / BACKEND_TEST).write_text(source)
            subprocess.run(['git', 'init', '-q', root], check=True)
            subprocess.run(['git', '-C', root, 'add', '.'], check=True)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                status = ctw.main([str(root)])
            return status, out.getvalue()

    def test_a_tracked_test_that_waits_on_real_time_fails_the_run_and_is_named(self):
        status, out = self.run_over('await Task.Delay(50);\n')
        self.assertEqual(status, 1)
        self.assertIn(f'{BACKEND_TEST}:1', out)

    def test_a_tree_with_no_wait_on_real_time_passes(self):
        self.assertEqual(self.run_over('await done.Task;\n')[0], 0)
