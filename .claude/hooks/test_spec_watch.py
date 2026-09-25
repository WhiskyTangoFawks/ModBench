"""Observes the spec watch's stdin-JSON contract over a scratch git repository: each change to a
protected spec file is reported to the user once, committed or not, and the hook never fails a turn."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import unittest

HOOK = pathlib.Path(__file__).resolve().parent / "spec-watch.py"
FILES = {"docs/adr/0001-a.md": "adr\n", "docs/architecture/commands.md": "cmds\n", "CONTEXT.md": "ctx\n",
         "CLAUDE.md": "root\n", "modbench/CLAUDE.md": "module\n", "modbench/src/a.ts": "code\n",
         ".claude/settings.json": "{}\n", ".claude/hooks/spec-guard.py": "guard\n"}


class SpecWatch(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.repo = pathlib.Path(self.scratch.name, "repo")
        self.tmp = pathlib.Path(self.scratch.name, "tmp")
        self.tmp.mkdir()
        for rel, text in FILES.items():
            self.write(rel, text)
        self.git("init", "-q", "-b", "main")
        self.commit("base")

    def tearDown(self):
        self.scratch.cleanup()

    def write(self, rel, text):
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def git(self, *args, stdin=None):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=self.repo,
                              input=stdin, capture_output=True, text=True, check=True).stdout.strip()

    def commit(self, subject):
        self.git("add", "-A")
        self.git("commit", "-qm", subject)

    def state(self, session="sess-1"):
        return self.tmp / "claude-spec-watch" / f"{session}.json"

    def hook(self, event, cwd=None, script=HOOK):
        payload = {"hook_event_name": event, "session_id": "sess-1", "cwd": str(cwd or self.repo)}
        run = subprocess.run(["python3", script],input=json.dumps(payload), capture_output=True, text=True,
                             env=os.environ | {"TMPDIR": str(self.tmp)})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.last_stderr = run.stderr
        return json.loads(run.stdout)["systemMessage"] if run.stdout.strip() else None

    def test_an_edit_in_the_working_tree_is_reported(self):
        self.hook("SessionStart")
        self.write("docs/adr/0001-a.md", "changed\n")
        message = self.hook("Stop")
        self.assertIn("docs/adr/0001-a.md", message)
        self.assertIn("working tree", message)

    def test_each_change_is_reported_once(self):
        self.hook("SessionStart")
        self.write("CONTEXT.md", "changed\n")
        self.assertIsNotNone(self.hook("Stop"))
        self.assertIsNone(self.hook("Stop"))

    def test_a_quiet_turn_reports_nothing(self):
        self.hook("SessionStart")
        self.write("modbench/src/a.ts", "changed\n")
        self.assertIsNone(self.hook("Stop"))

    def test_a_reported_edit_is_not_reported_again_when_committed(self):
        self.hook("SessionStart")
        self.write("CONTEXT.md", "changed\n")
        self.hook("Stop")
        self.commit("context")
        self.assertIsNone(self.hook("Stop"))

    def test_a_dirty_file_from_before_the_session_is_reported_when_committed(self):
        self.write("CONTEXT.md", "changed\n")
        self.hook("SessionStart")
        self.commit("context")
        self.assertIn("CONTEXT.md: committed in", self.hook("Stop"))

    def test_a_change_to_the_guard_settings_or_hooks_is_reported(self):
        self.hook("SessionStart")
        self.write(".claude/settings.json", '{"permissions": {}}\n')
        self.write(".claude/hooks/spec-guard.py", "gone\n")
        message = self.hook("Stop")
        self.assertIn(".claude/settings.json", message)
        self.assertIn(".claude/hooks/spec-guard.py", message)

    def test_a_corrupt_state_file_starts_a_fresh_baseline(self):
        self.hook("SessionStart")
        self.state().write_text("{not json")
        self.assertIsNone(self.hook("Stop"))
        self.write("CONTEXT.md", "changed\n")
        self.assertIn("CONTEXT.md", self.hook("Stop"))

    def test_state_files_older_than_a_week_are_pruned(self):
        self.state().parent.mkdir(parents=True)
        old, recent = self.state("old-session"), self.state("recent-session")
        old.write_text("{}")
        recent.write_text("{}")
        eight_days_ago = time.time() - 8 * 86400
        os.utime(old, (eight_days_ago, eight_days_ago))
        self.hook("SessionStart")
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

    def test_a_missing_spec_guard_is_silent_and_logged(self):
        alone = self.tmp / "alone"
        alone.mkdir()
        shutil.copy(HOOK, alone / HOOK.name)
        self.assertIsNone(self.hook("SessionStart", script=alone / HOOK.name))
        self.assertIn("spec-watch", self.last_stderr)

    def test_a_plumbing_commit_that_leaves_the_working_tree_alone_is_reported_with_its_commit(self):
        self.hook("SessionStart")
        blob = self.git("hash-object", "-w", "--stdin", stdin="evil\n")
        index = pathlib.Path(self.scratch.name, "index")
        env = os.environ | {"GIT_INDEX_FILE": str(index)}
        run = lambda *a: subprocess.run(["git", *a], cwd=self.repo, env=env, capture_output=True, text=True, check=True).stdout.strip()
        run("read-tree", "HEAD")
        run("update-index", "--cacheinfo", f"100644,{blob},docs/adr/0001-a.md")
        tree = run("write-tree")
        commit = self.git("commit-tree", tree, "-p", "HEAD", "-m", "quiet rewrite")
        self.git("update-ref", "refs/heads/main", commit)
        message = self.hook("Stop")
        self.assertIn("docs/adr/0001-a.md: committed in " + commit[:7] + " quiet rewrite", message)
        self.assertNotIn("working tree", message)

    def test_an_edit_committed_in_the_same_turn_is_reported_as_committed(self):
        self.hook("SessionStart")
        self.write("modbench/CLAUDE.md", "changed\n")
        self.commit("module rules")
        message = self.hook("Stop")
        self.assertIn("modbench/CLAUDE.md: committed in", message)
        self.assertEqual(message.count("modbench/CLAUDE.md"), 1, message)

    def test_undoing_a_reported_edit_is_reported(self):
        self.hook("SessionStart")
        self.write("CLAUDE.md", "changed\n")
        self.hook("Stop")
        self.git("checkout", "--", "CLAUDE.md")
        self.assertIn("CLAUDE.md", self.hook("Stop"))

    def test_a_resumed_session_keeps_its_baseline(self):
        self.hook("SessionStart")
        self.write("CONTEXT.md", "changed\n")
        self.hook("SessionStart")
        self.assertIn("CONTEXT.md", self.hook("Stop"))

    def test_a_stop_without_a_baseline_records_one_silently(self):
        self.assertIsNone(self.hook("Stop"))
        self.write("CONTEXT.md", "changed\n")
        self.assertIn("CONTEXT.md", self.hook("Stop"))

    def test_a_git_error_is_silent_and_logged(self):
        self.assertIsNone(self.hook("SessionStart", cwd=self.tmp))
        self.assertIn("spec-watch", self.last_stderr)

    def test_a_new_and_a_deleted_protected_file_are_reported(self):
        self.hook("SessionStart")
        self.write("docs/adr/0002-b.md", "new\n")
        (self.repo / "docs/architecture/commands.md").unlink()
        message = self.hook("Stop")
        self.assertIn("docs/adr/0002-b.md", message)
        self.assertIn("docs/architecture/commands.md", message)


if __name__ == "__main__":
    unittest.main()
