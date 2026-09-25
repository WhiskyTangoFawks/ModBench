"""Observes the spec guard's stdin-JSON contract: a subagent never writes a protected spec file, and a
main-session shell write to one is put to the maintainer."""
import json
import pathlib
import subprocess
import unittest

HOOK = pathlib.Path(__file__).resolve().parent / "spec-guard.py"
MAIN = "/home/x/mEdit"


def hook(tool, subagent=True, **tool_input):
    payload = {"tool_name": tool, "tool_input": tool_input, "session_id": "s", "cwd": MAIN}
    if subagent:
        payload |= {"agent_id": "a1", "agent_type": "general-purpose"}
    run = subprocess.run(["python3", HOOK], input=json.dumps(payload), capture_output=True, text=True)
    if run.returncode != 0:
        raise AssertionError(run.stderr)
    return json.loads(run.stdout)["hookSpecificOutput"] if run.stdout.strip() else {}


def decision(tool, subagent=True, **tool_input):
    return hook(tool, subagent, **tool_input).get("permissionDecision")


class SubagentFileTools(unittest.TestCase):
    def test_an_edit_to_an_adr_is_denied_with_the_flow(self):
        out = hook("Edit", file_path=f"{MAIN}/docs/adr/0012-plugin-identity.md", old_string="a", new_string="b")
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("maintainer's source of truth", out["permissionDecisionReason"])
        self.assertIn("exact before/after text in your report", out["permissionDecisionReason"])

    def test_every_protected_file_is_denied_in_every_checkout(self):
        for root in (MAIN, f"{MAIN}/.claude/worktrees/agent-1", "/home/x/mEdit-fix-9"):
            for rel in ("docs/architecture/surfaces/mods.md", "docs/adr/0003-no-exclusive-ownership.md",
                        "CONTEXT.md", "CLAUDE.md", "modbench/src/mods/CLAUDE.md"):
                with self.subTest(path=f"{root}/{rel}"):
                    self.assertEqual(decision("Write", file_path=f"{root}/{rel}", content="x"), "deny")

    def test_a_notebook_edit_is_denied_by_its_notebook_path(self):
        self.assertEqual(decision("NotebookEdit", notebook_path=f"{MAIN}/docs/adr/n.ipynb", new_source="x"), "deny")

    def test_a_relative_path_is_matched_too(self):
        self.assertEqual(decision("Edit", file_path="docs/architecture/commands.md", old_string="a", new_string="b"), "deny")

    def test_code_and_neighbouring_docs_pass(self):
        for rel in ("modbench/src/mods/index.ts", "docs/agents/issue-tracker.md", "docs/adrs.md",
                    "docs/research/adr-notes.md", "NOT-CLAUDE.md", "CLAUDE.md.bak", ".claude/settings.json"):
            with self.subTest(path=rel):
                self.assertIsNone(decision("Write", file_path=f"{MAIN}/{rel}", content="x"))


class SubagentShellWrites(unittest.TestCase):
    def assert_denied(self, *commands):
        for command in commands:
            with self.subTest(command=command):
                self.assertEqual(decision("Bash", command=command), "deny")

    def test_sed_in_place(self):
        self.assert_denied("sed -i 's/a/b/' docs/adr/0001.md", "sed -i.bak -e 's/a/b/' CONTEXT.md",
                           "sed --in-place 's/a/b/' docs/architecture/commands.md", "sed -Ei 's/a/b/' CLAUDE.md",
                           f"sed -i 's/a/b/' {MAIN}/.claude/worktrees/agent-1/docs/adr/0001.md")

    def test_redirection_into_a_protected_file(self):
        self.assert_denied("echo x > docs/adr/0001.md", "echo x >> CONTEXT.md", "printf x >| CLAUDE.md",
                           "echo x 1>modbench/CLAUDE.md", "cat > docs/architecture/new.md <<'EOF'\nbody\nEOF")

    def test_tee(self):
        self.assert_denied("echo x | tee docs/adr/0001.md", "echo x | tee -a /home/x/mEdit-fix-9/CLAUDE.md")

    def test_move_copy_and_remove(self):
        self.assert_denied("mv docs/adr docs_old", "mv /tmp/x docs/adr/0001.md", "cp /tmp/x modbench/CLAUDE.md",
                           "rm -rf docs/architecture", "rm CONTEXT.md")

    def test_git_checkout_and_restore_of_a_path(self):
        self.assert_denied("git checkout evil -- docs/adr/0001.md", "git checkout evil docs/adr",
                           "git restore --source evil -- CONTEXT.md", "git -C /home/x/mEdit checkout HEAD~1 -- CLAUDE.md")

    def test_git_apply_of_a_patch_that_names_a_protected_file(self):
        self.assert_denied("git apply <<'EOF'\n--- a/docs/adr/0001.md\n+++ b/docs/adr/0001.md\n@@ -1 +1 @@\n-a\n+b\nEOF")

    def test_python_or_perl_writing_a_protected_file(self):
        self.assert_denied("python3 -c \"open('docs/adr/0001.md', 'w').write('x')\"",
                           "python3 - <<'EOF'\nfrom pathlib import Path\nPath('CONTEXT.md').write_text('x')\nEOF",
                           "perl -pi -e 's/a/b/' CLAUDE.md",
                           "perl -e 'open(my $f, \">\", \"docs/architecture/x.md\")'")

    def test_a_write_later_in_a_compound_command(self):
        self.assert_denied("cd /home/x/mEdit && git status && sed -i 's/a/b/' CLAUDE.md",
                           "bash -c \"echo x > docs/adr/0001.md\"")

    def test_known_limit_a_path_built_at_runtime_passes(self):
        self.assertIsNone(decision("Bash", command="d=docs; sed -i 's/a/b/' $d/adr/0001.md"))
        self.assertIsNone(decision("Bash", command="python3 -c \"open('docs/'+'adr/0001.md','w').write('x')\""))

    def test_known_limit_a_script_path_held_in_a_variable_passes(self):
        self.assertIsNone(decision("Bash", command="python3 - <<'EOF'\np = 'CLAUDE.md'\nopen(p, 'w').write('x')\nEOF"))

    def test_known_limit_a_path_relative_to_a_changed_directory_passes(self):
        self.assertIsNone(decision("Bash", command="cd docs && sed -i 's/a/b/' adr/0001.md"))

    def test_known_limit_a_patch_or_script_in_another_file_passes(self):
        self.assertIsNone(decision("Bash", command="git apply /tmp/change.patch"))
        self.assertIsNone(decision("Bash", command="python3 /tmp/rewrite.py"))

    def test_known_limit_a_whole_tree_git_command_passes(self):
        self.assertIsNone(decision("Bash", command="git reset --hard evil"))


class SubagentShellReads(unittest.TestCase):
    def test_reads_of_protected_files_pass(self):
        for command in ("grep -rn ADR-0012 docs/adr", "cat CONTEXT.md", "sed -n '1,20p' docs/adr/0001.md",
                        "git diff main -- docs/adr", "git log --oneline -- CLAUDE.md", "git show main:docs/adr/0001.md",
                        "grep -l x docs/adr/* > /tmp/hits.txt", "cat docs/adr/0001.md 2>&1 | head -5",
                        "cp docs/adr/0001.md /tmp/0001.md", "python3 -c \"print(open('CONTEXT.md').read())\"",
                        "git commit -m 'rm docs/adr notes; sed -i CLAUDE.md'", "ls docs/architecture > /dev/null",
                        "git add docs/adr/0001.md", "git apply --check <<'EOF'\n--- a/docs/adr/0001.md\nEOF",
                        "python3 -c \"d = open('CLAUDE.md').read(); open('/tmp/o', 'w').write(d)\"",
                        "git commit -F - <<'EOF'\nrm docs/adr/0001.md\nEOF", "echo 'x > CLAUDE.md'"):
            with self.subTest(command=command):
                self.assertIsNone(decision("Bash", command=command))

    def test_writes_elsewhere_pass(self):
        for command in ("sed -i 's/a/b/' modbench/src/mods/index.ts", "echo x > /tmp/out.txt",
                        "rm -rf modbench/out", "git checkout main -- modbench/package.json"):
            with self.subTest(command=command):
                self.assertIsNone(decision("Bash", command=command))


class MainSessionShell(unittest.TestCase):
    def test_a_shell_write_to_a_protected_file_is_put_to_the_maintainer(self):
        out = hook("Bash", subagent=False, command="git checkout evil -- docs/adr/0001.md")
        self.assertEqual(out["permissionDecision"], "ask")
        self.assertIn("docs/adr/0001.md", out["permissionDecisionReason"])

    def test_a_shell_read_passes(self):
        self.assertEqual(hook("Bash", subagent=False, command="cat docs/adr/0001.md"), {})


class MainSessionFileTools(unittest.TestCase):
    def test_an_edit_to_a_protected_file_is_left_to_the_ask_rules(self):
        self.assertEqual(hook("Edit", subagent=False, file_path=f"{MAIN}/docs/adr/0001.md", old_string="a", new_string="b"), {})


if __name__ == "__main__":
    unittest.main()
