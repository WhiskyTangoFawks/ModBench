"""Pins frontend_gates.py: steps run at once unless one waits on another, a step runs only once
the step it waits on passed, and each step's output prints whole under its own header."""
import contextlib
import io
import pathlib
import sys
import tempfile
import unittest

import frontend_gates as fg


def python(code):
    return [sys.executable, '-c', code]


# Each writes its own file, then waits for the other's: run one after the other, the first times out.
def meet(mine, theirs):
    return python(
        'import pathlib, sys, time\n'
        f'pathlib.Path({mine!r}).touch()\n'
        f'print("{mine} one"); sys.stdout.flush()\n'
        'deadline = time.monotonic() + 10\n'
        f'while not pathlib.Path({theirs!r}).exists():\n'
        '    if time.monotonic() > deadline: sys.exit(1)\n'
        '    time.sleep(0.01)\n'
        f'print("{mine} two")\n')


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_steps(self, *steps):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            passed = fg.run(list(steps), self.dir)
        return passed, printed.getvalue()

    def test_steps_that_wait_on_none_run_at_once_and_each_prints_whole_under_its_header(self):
        passed, printed = self.run_steps(fg.Step('Lint', meet('a', 'b')), fg.Step('Build', meet('b', 'a')))
        self.assertTrue(passed)
        for header, mine in (('=== Lint', 'a'), ('=== Build', 'b')):
            lines = printed.splitlines()
            at = next(i for i, line in enumerate(lines) if line.startswith(header))
            self.assertEqual(lines[at + 1:at + 3], [f'{mine} one', f'{mine} two'])

    def test_a_step_waits_on_the_step_it_names_and_runs_only_once_that_passed(self):
        passed, printed = self.run_steps(
            fg.Step('Build', python('import sys; print("type error"); sys.exit(2)')),
            fg.Step('Lint', python('print("linted")')),
            fg.Step('Unit', python('import pathlib; pathlib.Path("unit").touch()'), after='Build'))
        self.assertFalse(passed)
        self.assertIn('type error\n--- BUILD FAILED ---', printed)
        self.assertIn('linted', printed)
        self.assertNotIn('LINT FAILED', printed)
        self.assertFalse((self.dir / 'unit').exists())
        self.assertNotIn('=== Unit', printed)

    def test_a_step_after_a_passing_step_runs_after_it(self):
        passed, _ = self.run_steps(
            fg.Step('Build', python('import pathlib, time; time.sleep(0.2); pathlib.Path("built").touch()')),
            fg.Step('Unit', python('import pathlib, sys; sys.exit(0 if pathlib.Path("built").exists() else 1)'),
                    after='Build'))
        self.assertTrue(passed)


if __name__ == '__main__':
    unittest.main()
