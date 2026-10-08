"""Observes run-gates.sh's refusal: a run gates the tree that will land, so a branch behind main
is refused before any gate runs. Also observes what a slotted gate run is handed."""
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


class InASlot(unittest.TestCase):
    def test_a_slotted_gate_run_neither_lends_nor_borrows_an_msbuild_node(self):
        repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, repo)
        validate = pathlib.Path(repo, ".claude/skills/validate")
        validate.mkdir(parents=True)
        shutil.copy(SCRIPT, validate)
        (validate / "slot.sh").write_text('in_slot() { echo "node reuse off: $MSBUILDDISABLENODEREUSE"; }\n')
        git(repo, "init", "-q", "-b", "main")
        git(repo, "commit", "-q", "--allow-empty", "-m", "base")
        env = {k: v for k, v in os.environ.items() if k not in ("MSBUILDDISABLENODEREUSE", "GATE_SLOT")}
        run = subprocess.run(["bash", str(validate / "run-gates.sh"), "--backend"],
                             capture_output=True, text=True, timeout=60, env=env)
        self.assertIn("node reuse off: 1", run.stdout)


if __name__ == '__main__':
    unittest.main()
