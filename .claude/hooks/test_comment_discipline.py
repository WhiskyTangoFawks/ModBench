"""Observes the two seams the comment discipline exposes: Vale over a text fragment, and the
write hook's stdin-JSON contract. Forbidden tokens are spelled as split literals so this file
passes the gate it tests."""
import json
import pathlib
import subprocess
import unittest

HOOKS = pathlib.Path(__file__).resolve().parent
ROOT = HOOKS.parent.parent
VALE = subprocess.run(["bash", ROOT / ".claude/skills/validate/install-vale.sh"],
                      capture_output=True, text=True, check=True).stdout.strip()

HISTORY = "previ" "ously"
TICKET = "#" "742"


def vale(text, ext, config=".vale.ini"):
    run = subprocess.run([VALE, f"--config={config}", "--output=JSON", f"--ext={ext}"],
                         input=text, capture_output=True, text=True, cwd=ROOT)
    return [a["Check"] for alerts in json.loads(run.stdout or "{}").values() for a in alerts]


def hook(path, text, tool="Write"):
    key = "new_string" if tool == "Edit" else "content"
    payload = {"tool_name": tool, "tool_input": {"file_path": path, key: text}}
    return subprocess.run(["python3", HOOKS / "comment-write.py"], input=json.dumps(payload),
                          capture_output=True, text=True)


class ValeRules(unittest.TestCase):
    def test_two_crefs_in_one_doc_comment(self):
        two = '/// <summary>See <see cref="B"/> and <see cref="C"/>.</summary>\npublic int X;\n'
        self.assertIn("Repo.Cref", vale(two, ".cs"))

    def test_two_links_in_one_ts_doc_comment(self):
        two = "/** See {@link B} and {@link C}. */\nexport const x = 1;\n"
        self.assertIn("Repo.Cref", vale(two, ".ts"))

    def test_history_in_a_string_literal_via_the_raw_pass(self):
        code = f'var s = "this {HISTORY} held";\n'
        self.assertIn("Repo.History", vale(code, ".cs", config=".vale-raw.ini"))

    def test_raw_pass_covers_scripts_and_project_files(self):
        for ext in (".py", ".sh", ".yml", ".json", ".mjs", ".csproj", ".props"):
            with self.subTest(ext=ext):
                self.assertIn("Repo.History", vale(f"x = '{HISTORY}'\n", ext, config=".vale-raw.ini"))

    def test_comment_pass_covers_python_comments(self):
        self.assertIn("Repo.CommentLength", vale("# " + "word " * 41 + "\n", ".py"))

    def test_one_cref_passes(self):
        one = '/// <summary>See <see cref="B"/>.</summary>\npublic int X;\n'
        self.assertNotIn("Repo.Cref", vale(one, ".cs"))


class WriteHook(unittest.TestCase):
    def test_refuses_two_crefs(self):
        run = hook("a.cs", '/// <summary>See <see cref="B"/> and <see cref="C"/>.</summary>\npublic int X;\n')
        self.assertEqual(run.returncode, 2, run.stderr)


    def test_refuses_a_history_word_in_a_comment(self):
        run = hook("a.ts", f"// this {HISTORY} did X\nexport const a = 1;\n")
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn("History", run.stderr)

    def test_refuses_a_history_word_in_a_string_literal(self):
        run = hook("a.ts", f'export const s = "{HISTORY} held";\n')
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn("History", run.stderr)

    def test_reports_a_comment_hit_once(self):
        run = hook("a.ts", f"// this {HISTORY} did X\nexport const a = 1;\n")
        self.assertEqual(run.stderr.count("History"), 1, run.stderr)

    def test_refuses_an_oversize_comment_in_an_mjs_file(self):
        run = hook("eslint.config.mjs", "// " + "word " * 41 + "\nexport default [];\n")
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn("40", run.stderr)

    def test_accepts_a_present_tense_comment(self):
        run = hook("a.ts", "// the cap is a constraint from the format\nexport const a = 1;\n")
        self.assertEqual(run.returncode, 0, run.stderr)


if __name__ == "__main__":
    unittest.main()
