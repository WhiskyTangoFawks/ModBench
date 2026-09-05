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

    def test_a_date_in_a_comment_or_prose(self):
        self.assertIn("Repo.Date", vale("// maintainer ruling 2026-09-01\nconst a = 1;\n", ".ts"))
        self.assertIn("Repo.Date", vale("Ruling 2026-09-01: the grid renders the stack.\n", ".md"))

    def test_the_raw_pass_treats_a_date_in_a_string_literal_as_data(self):
        alerts = vale(f'const d = "{HISTORY} 2024-01-01";\n', ".ts", config=".vale-raw.ini")
        self.assertIn("Repo.History", alerts)
        self.assertNotIn("Repo.Date", alerts)

    def test_our_ticket_numbers_anywhere_in_text(self):
        for text in (f"// see {TICKET}\n", f"// fixed ({TICKET})\n", f"x = 'issue {TICKET}'\n",
                     f"// two fixes, {TICKET} among them\n"):
            with self.subTest(text=text):
                self.assertIn("Repo.Ticket", vale(text, ".ts", config=".vale-raw.ini"))
        self.assertIn("Repo.Ticket", vale(f"See {TICKET}.\n", ".md"))

    def test_external_trackers_hex_colours_and_enumerations_are_not_tickets(self):
        n = "#" "688"
        for text in (f"Mutagen {n}", f"Mutagen-{n}", f"Mutagen-Modding/Mutagen{n}", f"upstream {n}/{n}",
                     f"VS Code {n}", "color: '#123456'", "var(--x, #123)", "divergence #2, AC #4"):
            with self.subTest(text=text):
                self.assertNotIn("Repo.Ticket", vale(f"// {text}\n", ".ts", config=".vale-raw.ini"))

    def test_filler_gets_a_quick_fix(self):
        self.assertIn("Repo.Filler", vale("// in order to load the plugin\n", ".ts"))

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

    def test_checks_an_edit_by_its_new_string(self):
        run = hook("a.ts", f"// this {HISTORY} did X\n", tool="Edit")
        self.assertEqual(run.returncode, 2, run.stderr)

    def test_refuses_a_history_string_literal_in_an_mjs_file(self):
        run = hook("esbuild.mjs", f'const s = "{HISTORY} held";\n')
        self.assertEqual(run.returncode, 2, run.stderr)

    def test_refuses_a_ticket_number_in_a_config_file(self):
        run = hook("a.yml", f"# from {TICKET}\nkey: 1\n")
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn("commit message", run.stderr)

    def test_a_warning_does_not_block_the_write(self):
        run = hook("a.ts", "// sorted in order to match the file\nexport const a = 1;\n")
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_accepts_a_present_tense_comment(self):
        run = hook("a.ts", "// the cap is a constraint from the format\nexport const a = 1;\n")
        self.assertEqual(run.returncode, 0, run.stderr)


if __name__ == "__main__":
    unittest.main()
