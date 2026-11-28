"""Observes test-wait-write.py's stdin-JSON contract: an edit that writes a wait on real time into a test is refused,
and every other edit passes."""
import json
import pathlib
import subprocess
import unittest

HOOK = pathlib.Path(__file__).resolve().parent / "test-wait-write.py"
TEST = "/home/x/modbench/MEditService/MEditService.Http.Tests/Api/WaitTests.cs"


def hook(tool: str, path: str, text: str) -> subprocess.CompletedProcess[str]:
    key = "new_string" if tool == "Edit" else "content"
    payload = {"tool_name": tool, "tool_input": {"file_path": path, key: text}}
    return subprocess.run(["python3", HOOK], input=json.dumps(payload), capture_output=True, text=True)


class TestWaitWrite(unittest.TestCase):
    def test_a_wait_on_real_time_written_to_a_test_is_refused_with_its_line(self):
        for tool in ("Edit", "Write"):
            with self.subTest(tool=tool):
                run = hook(tool, TEST, "x();\nawait Task.Delay(50);\n")
                self.assertEqual(run.returncode, 2)
                self.assertIn("line 2: await Task.Delay(50);", run.stderr)

    def test_a_wait_on_a_value_or_one_in_production_code_passes(self):
        for path, text in ((TEST, "await done.Task.WaitAsync(Waits.Patience);"),
                           ("/home/x/modbench/MEditService/MEditService.Http/Startup.cs", "await Task.Delay(50);")):
            with self.subTest(path=path):
                self.assertEqual(hook("Write", path, text).returncode, 0)
