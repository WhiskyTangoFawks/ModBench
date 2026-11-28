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
FRONTEND_TEST = 'modbench/src/client/test/wait.test.ts'
ALLOWED_PATH, ALLOWED_LINE = next(iter(ctw.ALLOWED))


class Waits(unittest.TestCase):
    def test_a_wait_on_real_time_in_a_test_is_named_by_its_path_and_line(self):
        for path, line in ((BACKEND_TEST, 'await Task.Delay(50);'),
                           ('MEditService/MEditService.TestSupport/Fixtures.cs', 'Thread.Sleep(TimeSpan.FromMilliseconds(10));'),
                           (f'/home/x/modbench/{BACKEND_TEST}', 'Assert.Same(t, await Task.WhenAny(t, Task.Delay(Patience)));'),
                           (BACKEND_TEST, 'using var cancelling = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));'),
                           (BACKEND_TEST, 'cancelling.CancelAfter(Patience);'),
                           (BACKEND_TEST, 'Assert.False(process.WaitForExit(500));'),
                           (BACKEND_TEST, 'Assert.True(released.Wait(TimeSpan.FromSeconds(5)));'),
                           (BACKEND_TEST, 'Assert.True(token.WaitHandle.WaitOne(Generous));'),
                           (BACKEND_TEST, 'var line = answer.Wait(TimeSpan.FromSeconds(30)) ? answer.Result : null;'),
                           (BACKEND_TEST, 'Assert.True(released.Wait(CancelBound));'),
                           (FRONTEND_TEST, 'await new Promise((resolve) => setTimeout(resolve, 20));'),
                           (FRONTEND_TEST, 'new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), ms)),'),
                           (f'/home/x/{FRONTEND_TEST}', 'await sleep(PROBE_SPACING_MS);'),
                           (FRONTEND_TEST, 'await vi.waitFor(() => { expect(heard).toEqual([]); }, { timeout: 200 });'),
                           (FRONTEND_TEST, 'await vi.waitUntil(() => listed.length === 1, 500);'),
                           ('modbench/src/drivingLib/test/viewHarness.ts', 'await new Promise((resolve) => setTimeout(resolve, 5));'),
                           ('modbench/src/test/integration/extension.test.ts', 'await new Promise(r => setTimeout(r, 100));'),
                           ('modbench/webview/src/Grid.test.tsx', 'await new Promise((resolve) => setTimeout(resolve, 50));')):
            with self.subTest(path=path, line=line):
                self.assertEqual(ctw.waits(path, f'class T\n{{\n    {line}\n}}'), [ctw.Wait(path, 3, line)])

    def test_a_wait_on_a_value_production_code_and_an_allowed_line_pass(self):
        for path, line in ((BACKEND_TEST, 'await Task.Delay(Timeout.Infinite, cancellationToken);'),
                           ('MEditService/MEditService.RecordIndex/Indexer.cs', 'await Task.Delay(interval, _timeProvider);'),
                           (BACKEND_TEST, 'await reading.Task.WaitAsync(Waits.Patience);'),
                           (BACKEND_TEST, 'using var left = new CancellationTokenSource();'),
                           (BACKEND_TEST, 'process.WaitForExit();'),
                           (BACKEND_TEST, 'First.Wait(_abandoned.Token);'),
                           (BACKEND_TEST, 'Assert.True(entered.Wait(0));'),
                           (BACKEND_TEST, 'Thread.Sleep(0);'),
                           (BACKEND_TEST, 'await Task.Delay(TimeSpan.Zero);'),
                           (BACKEND_TEST, 'using var held = new CancellationTokenSource(Timeout.InfiniteTimeSpan);'),
                           (BACKEND_TEST, 'parked.Wait(cancel);'),
                           (BACKEND_TEST, 'parked.Wait(CancellationToken.None);'),
                           (BACKEND_TEST, 'Waits.Signalled(released.Wait, "the release");'),
                           (FRONTEND_TEST, 'const turn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });'),
                           (FRONTEND_TEST, 'else setTimeout(() => { finish(run, end.exitCode); }, 0);'),
                           (FRONTEND_TEST, "vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });"),
                           (FRONTEND_TEST, 'await vi.advanceTimersByTimeAsync(1000);'),
                           (FRONTEND_TEST, 'await vi.waitFor(() => { expect([before, errors()]).toEqual([[MISSING], []]); }, { interval: 1 });'),
                           (FRONTEND_TEST, 'await sleep(0);'),
                           ('modbench/src/client/backendLifecycle.ts', 'setTimeout(retry, 1000);'),
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
