"""Observes detached.sh: start returns at once and refuses a second start, wait blocks one
bounded call at a time, delivers the verdict once and mirrors the command's exit."""
import pathlib
import subprocess
import unittest
import uuid

SCRIPT = pathlib.Path(__file__).resolve().parent / "detached.sh"
STATE = pathlib.Path("/tmp/medit-detached")


def detached(*args):
    return subprocess.run(["bash", SCRIPT, *args], capture_output=True, text=True)


class Detached(unittest.TestCase):
    def setUp(self):
        self.name = f"test-{uuid.uuid4().hex}"

    def test_wait_returns_3_while_running_then_0_on_success(self):
        self.assertEqual(detached("start", self.name, "bash", "-c", "sleep 2; echo finished").returncode, 0)
        self.assertEqual(detached("wait", self.name, "1").returncode, 3)
        done = detached("wait", self.name, "10")
        self.assertEqual(done.returncode, 0)
        self.assertIn("finished", done.stdout)

    def test_wait_returns_1_and_shows_output_on_failure(self):
        detached("start", self.name, "bash", "-c", "echo boom; exit 7")
        done = detached("wait", self.name, "10")
        self.assertEqual(done.returncode, 1)
        self.assertIn("boom", done.stdout)
        self.assertIn("EXIT=7", done.stdout)

    def test_output_without_trailing_newline_still_passes(self):
        detached("start", self.name, "printf", "ok")
        self.assertEqual(detached("wait", self.name, "10").returncode, 0)

    def test_wait_returns_2_when_nothing_was_started(self):
        self.assertEqual(detached("wait", self.name, "1").returncode, 2)

    def test_verdict_is_delivered_once(self):
        detached("start", self.name, "true")
        self.assertEqual(detached("wait", self.name, "10").returncode, 0)
        again = detached("wait", self.name, "1")
        self.assertEqual(again.returncode, 2)
        self.assertIn(str(STATE / f"{self.name}.log"), again.stdout)

    def test_second_start_while_running_is_refused(self):
        detached("start", self.name, "sleep", "2")
        second = detached("start", self.name, "true")
        self.assertEqual(second.returncode, 1)
        self.assertIn("already running", second.stdout)
        detached("wait", self.name, "10")

    def test_run_that_died_without_a_verdict_returns_4(self):
        detached("start", self.name, "bash", "-c", "echo partial; kill -9 $PPID")
        died = detached("wait", self.name, "10")
        self.assertEqual(died.returncode, 4)
        self.assertIn("without a verdict", died.stdout)

    def test_recorded_pid_reused_by_another_process_returns_4(self):
        (STATE / f"{self.name}.log").write_text("partial\n")
        (STATE / f"{self.name}.pid").write_text("1\nnot-the-real-start-time\n")
        self.assertEqual(detached("wait", self.name, "1").returncode, 4)
