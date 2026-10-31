"""Observes the pre-commit hook with a fake run-gates.sh that logs what it is handed."""
import pathlib
import shutil
import subprocess
import tempfile
import unittest

HOOK = pathlib.Path(__file__).resolve().parent / "git-hooks/pre-commit"


class PreCommit(unittest.TestCase):
    def setUp(self):
        self.repo = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.repo)
        hooks = self.repo / ".claude/skills/validate/git-hooks"
        hooks.mkdir(parents=True)
        shutil.copy(HOOK, hooks)
        self.gates = self.repo / ".claude/skills/validate/run-gates.sh"
        self.gates.write_text('echo "run-gates $*"\n')
        self.git("init", "-q", "-b", "main")
        self.git("config", "core.hooksPath", str(hooks))
        self.git("commit", "-q", "--allow-empty", "-m", "base")

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), "-c", "user.name=t", "-c", "user.email=t@t", *args],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)

    def commit(self, path):
        (self.repo / path).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / path).write_text("text\n")
        self.git("add", path)
        return self.git("commit", "-q", "-m", "change")

    def test_a_spec_commit_on_main_runs_the_docs_gate(self):
        run = self.commit("spec/surfaces/mods.md")
        self.assertEqual(run.returncode, 0)
        self.assertIn("run-gates --docs", run.stdout)

    def test_a_docs_commit_on_main_runs_the_docs_gate(self):
        self.assertIn("run-gates --docs", self.commit("docs/traces/build.d2").stdout)

    def test_a_red_docs_gate_refuses_the_commit(self):
        self.gates.write_text("exit 1\n")
        self.assertNotEqual(self.commit("spec/surfaces/mods.md").returncode, 0)
        self.assertEqual(self.git("rev-list", "--count", "HEAD").stdout.strip(), "1")

    def test_the_gates_inherit_no_index_from_a_commit_of_named_paths(self):
        self.gates.write_text('echo "index ${GIT_INDEX_FILE-unset}"\n')
        (self.repo / "spec").mkdir()
        (self.repo / "spec/mods.md").write_text("text\n")
        self.git("add", "spec/mods.md")
        self.assertIn("index unset", self.git("commit", "-q", "-m", "change", "--", "spec/mods.md").stdout)

    def test_a_commit_outside_spec_and_docs_runs_no_gate(self):
        run = self.commit("modbench/src/extension.ts")
        self.assertEqual(run.returncode, 0)
        self.assertNotIn("run-gates", run.stdout)

    def test_a_spec_commit_on_a_branch_runs_no_gate(self):
        self.git("checkout", "-q", "-b", "fix-1-slug")
        self.assertNotIn("run-gates", self.commit("spec/surfaces/mods.md").stdout)


if __name__ == "__main__":
    unittest.main()
