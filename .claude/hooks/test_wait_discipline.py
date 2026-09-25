"""Observes the wait-discipline hook's stdin-JSON contract: gate commands carry a timeout, and a
subagent waits in the foreground."""
import json
import pathlib
import subprocess
import unittest

HOOK = pathlib.Path(__file__).resolve().parent / "wait-discipline.py"
TRANSCRIPT = "/home/x/.claude/projects/p/abc.jsonl"
TOP = {}
SUB = {"agent_id": "a60846e1b0b69da89", "agent_type": "general-purpose"}


def hook(tool, caller, **tool_input):
    payload = {"tool_name": tool, "transcript_path": TRANSCRIPT, "tool_input": tool_input} | caller
    return subprocess.run(["python3", HOOK], input=json.dumps(payload), capture_output=True, text=True)


class GateTimeout(unittest.TestCase):
    def test_dotnet_test_without_timeout_is_blocked(self):
        self.assertEqual(hook("Bash", TOP, command="dotnet test -v minimal").returncode, 2)

    def test_run_gates_without_timeout_is_blocked(self):
        self.assertEqual(hook("Bash", TOP, command="bash .claude/skills/validate/run-gates.sh --wait").returncode, 2)

    def test_detached_wait_without_timeout_is_blocked(self):
        self.assertEqual(hook("Bash", TOP, command="bash .claude/skills/validate/detached.sh wait gates").returncode, 2)

    def test_run_gates_detach_returns_at_once_and_needs_no_timeout(self):
        self.assertEqual(hook("Bash", TOP, command="bash .claude/skills/validate/run-gates.sh --backend --detach").returncode, 0)

    def test_gate_with_timeout_below_the_wait_span_is_blocked(self):
        run = hook("Bash", TOP, command="bash .claude/skills/validate/run-gates.sh --wait", timeout=300000)
        self.assertEqual(run.returncode, 2)

    def test_gate_with_timeout_passes(self):
        run = hook("Bash", TOP, command="bash .claude/skills/validate/run-gates.sh --wait", timeout=600000)
        self.assertEqual(run.returncode, 0)

    def test_gate_named_inside_quotes_is_data(self):
        self.assertEqual(hook("Bash", TOP, command="git commit -m 'run-gates.sh --wait'").returncode, 0)


class SubagentForeground(unittest.TestCase):
    def test_top_level_background_bash_passes(self):
        self.assertEqual(hook("Bash", TOP, command="sleep 5", run_in_background=True).returncode, 0)

    def test_subagent_background_bash_is_blocked(self):
        run = hook("Bash", SUB, command="sleep 5", run_in_background=True)
        self.assertEqual(run.returncode, 2)
        self.assertIn("detached.sh", run.stderr)

    def test_subagent_foreground_bash_passes(self):
        self.assertEqual(hook("Bash", SUB, command="sleep 5").returncode, 0)

    def test_subagent_monitor_is_blocked(self):
        self.assertEqual(hook("Monitor", SUB, command="tail -f x.log", description="x", timeout_ms=1000, persistent=False).returncode, 2)

    def test_top_level_monitor_passes(self):
        self.assertEqual(hook("Monitor", TOP, command="tail -f x.log", description="x", timeout_ms=1000, persistent=False).returncode, 0)
