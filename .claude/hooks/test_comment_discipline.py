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


class WriteHook(unittest.TestCase):
    def test_refuses_a_history_word_in_a_comment(self):
        run = hook("a.ts", f"// this {HISTORY} did X\nexport const a = 1;\n")
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn("History", run.stderr)

    def test_accepts_a_present_tense_comment(self):
        run = hook("a.ts", "// the cap is a constraint from the format\nexport const a = 1;\n")
        self.assertEqual(run.returncode, 0, run.stderr)


if __name__ == "__main__":
    unittest.main()
