"""Observes the wait-discipline hook's stdin-JSON contract: gate commands carry a timeout, a build
or test runs in the build slot, and a subagent waits in the foreground."""
import json
import pathlib
import subprocess
import unittest

HOOK = pathlib.Path(__file__).resolve().parent / "wait-discipline.py"
SLOT_RUN = HOOK.parents[1] / "skills/validate/slot-run.sh"
TRANSCRIPT = "/home/x/.claude/projects/p/abc.jsonl"
TOP = {}
SUB = {"agent_id": "a60846e1b0b69da89", "agent_type": "general-purpose"}


def hook(tool, caller, **tool_input):
    payload = {"tool_name": tool, "transcript_path": TRANSCRIPT, "tool_input": tool_input} | caller
    return subprocess.run(["python3", HOOK], input=json.dumps(payload), capture_output=True, text=True)


class GateTimeout(unittest.TestCase):
    def test_a_slotted_dotnet_test_without_timeout_is_blocked(self):
        self.assertEqual(hook("Bash", TOP, command=f"bash {SLOT_RUN} dotnet test -v minimal").returncode, 2)

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

    def test_run_gates_after_cd_without_timeout_is_blocked(self):
        self.assertEqual(hook("Bash", TOP, command="cd /x && bash .claude/skills/validate/run-gates.sh").returncode, 2)

    def test_run_gates_by_path_without_timeout_is_blocked(self):
        self.assertEqual(hook("Bash", TOP, command="./.claude/skills/validate/run-gates.sh --comments").returncode, 2)

    def test_run_gates_on_a_later_line_or_under_a_shell_option_without_timeout_is_blocked(self):
        for command in ("cd /x\n./.claude/skills/validate/run-gates.sh --backend",
                        "bash -x .claude/skills/validate/run-gates.sh",
                        "sh .claude/skills/validate/run-gates.sh"):
            with self.subTest(command=command):
                self.assertEqual(hook("Bash", TOP, command=command).returncode, 2)

    def test_reading_run_gates_needs_no_timeout(self):
        for command in ("cat .claude/skills/validate/run-gates.sh",
                        "git diff main...x -- .claude/skills/validate/run-gates.sh",
                        "grep -n flock .claude/skills/validate/run-gates.sh",
                        "cat .claude/skills/validate/slot.sh .claude/skills/validate/run-gates.sh"):
            with self.subTest(command=command):
                self.assertEqual(hook("Bash", TOP, command=command).returncode, 0)

    def test_gate_named_inside_quotes_is_data(self):
        self.assertEqual(hook("Bash", TOP, command="git commit -m 'run-gates.sh --wait'").returncode, 0)


class BuildSlot(unittest.TestCase):
    def check(self, command, tool="Bash", **tool_input):
        return hook(tool, TOP, command=command, timeout=600000, **tool_input)

    def test_a_build_or_test_outside_the_slot_is_blocked_with_the_form_to_use(self):
        for command in ("dotnet test -v minimal", "dotnet build", "cd MEditService && dotnet test --filter X",
                        "npm run test:unit -- src/x.test.ts", "npm run build", "npm test",
                        "MSBUILDDISABLENODEREUSE=1 dotnet build", "dotnet format --verify-no-changes",
                        "cd modbench && npx vitest run src/x", "npm run package",
                        "dotnet publish MEditService.Http -c Release"):
            with self.subTest(command=command):
                run = self.check(command)
                self.assertEqual(run.returncode, 2)
                self.assertIn(f"bash {SLOT_RUN} ", run.stderr)

    def test_a_build_through_the_slot_passes(self):
        for command in (f"bash {SLOT_RUN} dotnet test -v minimal",
                        f"cd MEditService && bash {SLOT_RUN} dotnet build",
                        f"cd modbench; bash {SLOT_RUN} npm run test:unit",
                        f"bash .claude/skills/validate/detached.sh start t bash {SLOT_RUN} dotnet test"):
            with self.subTest(command=command):
                self.assertEqual(self.check(command).returncode, 0)

    def test_each_build_in_a_chain_goes_through_the_slot(self):
        self.assertEqual(self.check(f"bash {SLOT_RUN} dotnet build && dotnet test").returncode, 2)

    def test_a_detached_build_outside_the_slot_is_blocked(self):
        self.assertEqual(self.check("bash .claude/skills/validate/detached.sh start t dotnet test").returncode, 2)

    def test_a_background_build_outside_the_slot_is_blocked(self):
        self.assertEqual(self.check("dotnet build", run_in_background=True).returncode, 2)

    def test_a_dotnet_run_that_builds_is_blocked_even_in_the_slot(self):
        for command in ("dotnet run --project MEditService.Http", f"bash {SLOT_RUN} dotnet run --project X"):
            with self.subTest(command=command):
                run = self.check(command)
                self.assertEqual(run.returncode, 2)
                self.assertIn("--no-build", run.stderr)

    def test_a_dotnet_run_that_does_not_build_passes(self):
        for command in ("dotnet run --no-build --project MEditService.Http",
                        f"bash {SLOT_RUN} dotnet run --no-build --project X"):
            with self.subTest(command=command):
                self.assertEqual(self.check(command).returncode, 0)

    def test_a_command_that_only_names_a_build_passes(self):
        for command in ("dotnet build-server shutdown", "git commit -m 'dotnet test'", "grep -rn dotnet docs",
                        ".claude/skills/windows-vm/vm.sh ssh 'cd C:\\work; dotnet test'"):
            with self.subTest(command=command):
                self.assertEqual(self.check(command).returncode, 0)


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
