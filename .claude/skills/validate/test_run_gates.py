"""Observes run-gates.sh: a branch behind main is refused, a gate run takes the build slot, and the
change since main selects the gates."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "run-gates.sh"
REFUSAL = "behind main"


def git(repo, *args):
    subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                   check=True, capture_output=True)


class BehindMain(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo)
        validate = pathlib.Path(self.repo, ".claude/skills/validate")
        validate.mkdir(parents=True)
        shutil.copy(SCRIPT, validate)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "base")
        git(self.repo, "branch", "behind")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "ahead")
        git(self.repo, "checkout", "-q", "behind")

    def gates(self, *flags):
        return subprocess.run(["bash", str(pathlib.Path(self.repo, ".claude/skills/validate/run-gates.sh")), *flags],
                              capture_output=True, text=True, timeout=60)

    def test_a_branch_behind_main_is_refused(self):
        run = self.gates()
        self.assertEqual(run.returncode, 1)
        self.assertIn(REFUSAL, run.stdout)
        self.assertNotIn("=== Gate 1", run.stdout)

    def test_a_gate_beside_the_comment_gate_is_refused_behind_main(self):
        run = self.gates("--comments", "--docs")
        self.assertEqual(run.returncode, 1)
        self.assertIn(REFUSAL, run.stdout)

    def test_the_comment_gate_alone_runs_behind_main(self):
        run = self.gates("--comments")
        self.assertNotIn(REFUSAL, run.stdout)
        self.assertIn("Gate 1", run.stdout)


class GateRepo(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo)
        self.validate = pathlib.Path(self.repo, ".claude/skills/validate")
        self.validate.mkdir(parents=True)
        shutil.copy(SCRIPT, self.validate)
        shutil.copy(SCRIPT.parent / "select_gates.py", self.validate)
        (self.validate / "slot-run.sh").write_text('echo "slot-run: $*"\n')
        for path in ("MEditService/Core/a.cs", "modbench/src/a.ts", "spec/a.d2"):
            self.write(path, "x")
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "base")

    def write(self, path, text):
        file = pathlib.Path(self.repo, path)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def gates(self, *flags, **env):
        clean = {k: v for k, v in os.environ.items() if k != "BUILD_SLOT_HELD"}
        return subprocess.run(["bash", str(self.validate / "run-gates.sh"), *flags],
                              capture_output=True, text=True, timeout=60, env=clean | env)

    def slot_line(self, flags):
        return f"slot-run: bash {self.validate / 'run-gates.sh'} {flags}"


class InTheSlot(GateRepo):
    def test_a_gate_run_that_builds_or_tests_runs_in_the_build_slot(self):
        for flag in ("--backend", "--frontend", "--api-drift", "--docs", "--scripts"):
            with self.subTest(flag=flag):
                self.assertEqual(self.gates(flag).stdout, self.slot_line(flag) + "\n")

    def test_the_comment_gate_alone_takes_no_slot(self):
        self.assertNotIn("slot-run:", self.gates("--comments").stdout)

    def test_a_gate_run_in_the_slot_does_not_take_it_again(self):
        run = self.gates("--frontend", BUILD_SLOT_HELD="1")
        self.assertNotIn("slot-run:", run.stdout)
        self.assertIn("=== Gate 1", run.stdout)


class SelectedByChange(GateRepo):
    EVERY_GATE = "--backend --api-drift --scripts --frontend --docs"

    def selected(self):
        return self.gates().stdout.splitlines()[-1]

    def test_main_itself_runs_every_gate(self):
        self.assertEqual(self.selected(), self.slot_line(self.EVERY_GATE))

    def test_main_with_an_uncommitted_edit_runs_every_gate(self):
        self.write("spec/a.d2", "edited")
        self.assertEqual(self.selected(), self.slot_line(self.EVERY_GATE))

    def test_a_branch_ahead_of_main_runs_the_gates_its_diff_can_break(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.write("spec/a.d2", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertEqual(self.selected(), self.slot_line("--docs"))

    def test_a_branch_changing_only_a_non_ascii_path_runs_the_gates_it_can_break(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.write("modbench/src/test/Ñoño's Retexture/a.ts", "x")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "fixture")
        self.assertEqual(self.selected(), self.slot_line("--frontend"))


if __name__ == '__main__':
    unittest.main()
