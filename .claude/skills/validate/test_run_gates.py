"""Observes run-gates.sh: a branch behind where it lands is refused, a gate run takes the build slot,
and the change since where it lands selects the gates."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "run-gates.sh"
REFUSAL = "behind main"


def git(repo, *args):
    subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                   check=True, capture_output=True)


class BehindMain(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo)
        validate = pathlib.Path(self.repo, ".claude/skills/validate")
        validate.mkdir(parents=True)
        shutil.copy(SCRIPT, validate)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "base")
        git(self.repo, "branch", "behind")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "ahead")
        git(self.repo, "checkout", "-q", "behind")

    def gates(self, *flags):
        return subprocess.run(["bash", str(pathlib.Path(self.repo, ".claude/skills/validate/run-gates.sh")), *flags],
                              capture_output=True, text=True, timeout=60)

    def test_a_branch_behind_main_is_refused(self):
        run = self.gates()
        self.assertEqual(run.returncode, 1)
        self.assertIn(REFUSAL, run.stdout)
        self.assertNotIn("=== Gate 1", run.stdout)

    def test_a_gate_beside_the_comment_gate_is_refused_behind_main(self):
        run = self.gates("--comments", "--docs")
        self.assertEqual(run.returncode, 1)
        self.assertIn(REFUSAL, run.stdout)

    def test_the_comment_gate_alone_runs_behind_main(self):
        run = self.gates("--comments")
        self.assertNotIn(REFUSAL, run.stdout)
        self.assertIn("Gate 1", run.stdout)


class GateRepo(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo)
        self.validate = pathlib.Path(self.repo, ".claude/skills/validate")
        self.validate.mkdir(parents=True)
        shutil.copy(SCRIPT, self.validate)
        shutil.copy(SCRIPT.parent / "select_gates.py", self.validate)
        (self.validate / "slot-run.sh").write_text('echo "slot-run: $*"\n')
        for path in ("MEditService/Core/a.cs", "modbench/src/a.ts", "spec/a.d2"):
            self.write(path, "x")
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "base")

    def write(self, path, text):
        file = pathlib.Path(self.repo, path)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def gates(self, *flags, **env):
        clean = {k: v for k, v in os.environ.items() if k != "BUILD_SLOT_HELD"}
        return subprocess.run(["bash", str(self.validate / "run-gates.sh"), *flags],
                              capture_output=True, text=True, timeout=60, env=clean | env)

    def slot_line(self, flags):
        return f"slot-run: bash {self.validate / 'run-gates.sh'} {flags}"


class InTheSlot(GateRepo):
    def test_a_gate_run_that_builds_or_tests_runs_in_the_build_slot(self):
        for flag in ("--backend", "--frontend", "--api-drift", "--docs", "--scripts"):
            with self.subTest(flag=flag):
                self.assertEqual(self.gates(flag).stdout, self.slot_line(flag) + "\n")

    def test_the_comment_gate_alone_takes_no_slot(self):
        self.assertNotIn("slot-run:", self.gates("--comments").stdout)

    def test_a_gate_run_in_the_slot_does_not_take_it_again(self):
        run = self.gates("--frontend", BUILD_SLOT_HELD="1")
        self.assertNotIn("slot-run:", run.stdout)
        self.assertIn("=== Gate 1", run.stdout)


class SelectedByChange(GateRepo):
    EVERY_GATE = "--backend --api-drift --scripts --frontend --docs"

    def selected(self):
        return self.gates().stdout.splitlines()[-1]

    def test_main_itself_runs_every_gate(self):
        self.assertEqual(self.selected(), self.slot_line(self.EVERY_GATE))

    def test_main_with_an_uncommitted_edit_runs_every_gate(self):
        self.write("spec/a.d2", "edited")
        self.assertEqual(self.selected(), self.slot_line(self.EVERY_GATE))

    def test_a_branch_ahead_of_main_runs_the_gates_its_diff_can_break(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.write("spec/a.d2", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertEqual(self.selected(), self.slot_line("--docs"))

    def branch_tracking_an_integration_branch_with_a_backend_change(self):
        git(self.repo, "checkout", "-q", "-b", "integration")
        self.write("MEditService/Core/a.cs", "edited")
        git(self.repo, "commit", "-q", "-am", "backend")
        git(self.repo, "checkout", "-q", "--track", "-b", "ticket", "integration")

    def test_a_branch_tracking_a_local_branch_runs_the_gates_its_diff_since_that_branch_can_break(self):
        self.branch_tracking_an_integration_branch_with_a_backend_change()
        self.write("spec/a.d2", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertEqual(self.selected(), self.slot_line("--docs"))

    def test_a_branch_behind_the_local_branch_it_tracks_is_refused(self):
        self.branch_tracking_an_integration_branch_with_a_backend_change()
        git(self.repo, "checkout", "-q", "integration")
        git(self.repo, "commit", "-q", "--allow-empty", "-m", "ahead")
        git(self.repo, "checkout", "-q", "ticket")
        run = self.gates()
        self.assertEqual(run.returncode, 1)
        self.assertIn("behind integration", run.stdout)

    def test_a_branch_tracking_a_remote_branch_runs_the_gates_its_diff_since_main_can_break(self):
        self.branch_tracking_an_integration_branch_with_a_backend_change()
        git(self.repo, "config", "branch.ticket.remote", "origin")
        self.write("spec/a.d2", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertIn("--backend", self.selected())

    def test_a_branch_changing_only_a_non_ascii_path_runs_the_gates_it_can_break(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.write("modbench/src/test/Ñoño's Retexture/a.ts", "x")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "fixture")
        self.assertEqual(self.selected(), self.slot_line("--frontend"))


class FakeDotnet(GateRepo):
    DOTNET_RECORDING_ITS_ARGUMENTS = """#!/bin/sh
echo "$*" >> {calls}
if [ "$1" = test ] && [ -n "$FAKE_TRX" ]; then
  while [ $# -gt 1 ]; do
    [ "$1" = --results-directory ] && cp "$FAKE_TRX" "$2/fake.trx"
    shift
  done
fi
"""

    def setUp(self):
        super().setUp()
        shutil.copy(SCRIPT.parent / "select_backend_tests.py", self.validate)
        shutil.copy(SCRIPT.parent / "check_test_times.py", self.validate)
        shutil.copy(SCRIPT.parent / "skips.py", self.validate)
        self.project("RecordIndex")
        self.project("RecordIndex.Tests", "RecordIndex")
        self.project("Commands")
        self.project("Http", "Commands")
        self.project("Http.Tests", "Http")
        self.project("Architecture.Tests")
        self.calls = pathlib.Path(self.repo, "dotnet-calls")
        self.bin = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.bin)
        dotnet = self.bin / "dotnet"
        dotnet.write_text(self.DOTNET_RECORDING_ITS_ARGUMENTS.format(calls=self.calls))
        dotnet.chmod(0o755)
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "projects")
        git(self.repo, "checkout", "-q", "-b", "feature")

    def project(self, name, *references):
        test_sdk = '<PackageReference Include="Microsoft.NET.Test.Sdk" />' if name.endswith(".Tests") else ""
        self.write(f"MEditService/MEditService.{name}/MEditService.{name}.csproj", test_sdk + "".join(
            f'<ProjectReference Include="..\\MEditService.{r}\\MEditService.{r}.csproj" />' for r in references))

    def trx(self, outcome):
        name = pathlib.Path(self.repo, "fake.trx")
        name.write_text(
            '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>'
            f'<UnitTestResult testName="Fake.ATest" duration="00:00:00.1" endTime="2026-10-02T19:00:01+00:00" outcome="{outcome}" />'
            '</Results></TestRun>')
        return str(name)

    def run_after_changing(self, path, *flags, **env):
        self.write(path, "edited")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "edit")
        for results in ("medit-test-results", "medit-main-test-results", "medit-skip-logs", "medit-unit-results"):
            self.addCleanup(shutil.rmtree, f"/tmp/{results}.{pathlib.Path(self.repo).name}", ignore_errors=True)
        run = self.gates(*flags, BUILD_SLOT_HELD="1", PATH=f"{self.bin}:{os.environ['PATH']}", **env)
        return run, self.calls.read_text().splitlines() if self.calls.exists() else []


class BranchTests(FakeDotnet):
    UNMARKED_RUN = "--filter Kind!=RealSize&Kind!=Smoke"

    def filter_present_per_dotnet_test(self, calls):
        return [self.UNMARKED_RUN in call for call in calls if call.startswith("test ")]

    def test_the_tests_of_a_branch_that_touches_http_leave_out_the_kinds_that_wait_for_main(self):
        _, calls = self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend")
        self.assertEqual(self.filter_present_per_dotnet_test(calls), [True, True], calls)

    def test_the_docs_scans_of_a_branch_leave_out_the_kinds_that_wait_for_main(self):
        _, calls = self.run_after_changing("spec/a.d2", "--docs")
        self.assertEqual(self.filter_present_per_dotnet_test(calls), [True], calls)

    def test_a_skipped_test_does_not_fail_a_branch(self):
        run, _ = self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend", FAKE_TRX=self.trx("NotExecuted"))
        self.assertNotIn("SKIPPED", run.stdout)


class MergeToMain(FakeDotnet):
    MODE = "--merge-to-main"
    WORLD_RUN = "--filter Kind=RealSize|Kind=Smoke"

    def world_runs(self, calls):
        return [call for call in calls if self.WORLD_RUN in call]

    def test_the_mode_runs_the_real_size_and_smoke_tests_beside_the_gates_of_the_diff(self):
        _, calls = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("Passed"))
        self.assertEqual(len(self.world_runs(calls)), 1, calls)

    def test_the_mode_runs_the_gates_the_whole_diff_since_main_can_break_not_the_diff_since_the_branch_it_tracks(self):
        git(self.repo, "checkout", "-q", "-b", "integration")
        self.write("modbench/src/a.ts", "edited")
        git(self.repo, "commit", "-q", "-am", "frontend")
        git(self.repo, "checkout", "-q", "--track", "-b", "ticket", "integration")
        self.write("spec/a.d2", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertEqual(self.gates(self.MODE).stdout.splitlines()[-1], self.slot_line(f"{self.MODE} --frontend --docs"))

    def test_a_run_that_executed_no_test_fails(self):
        run, _ = self.run_after_changing("spec/a.d2", self.MODE)
        self.assertIn("No test of real size or smoke ran.", run.stdout)
        self.assertEqual(run.returncode, 1)

    def test_a_skipped_test_fails_the_run_naming_it(self):
        run, _ = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("NotExecuted"))
        self.assertIn("skipped  Fake.ATest", run.stdout)
        self.assertEqual(run.returncode, 1)

    def test_a_run_that_skipped_no_test_reports_no_skip(self):
        run, _ = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("Passed"))
        self.assertNotIn("skipped  ", run.stdout)

    def windows_vm_test(self, body):
        self.write(".claude/skills/windows-vm/test_probe.py",
                   f"import unittest\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n        {body}\n")

    def test_the_gate_runner_tests_include_the_windows_vm_skills_tests(self):
        self.windows_vm_test("self.fail('windows-vm test ran')")
        run, _ = self.run_after_changing("spec/a.d2", "--comments")
        self.assertIn("windows-vm test ran", run.stderr)

    def test_the_gate_runner_tests_run_without_a_windows_vm_skill_test(self):
        run, _ = self.run_after_changing("spec/a.d2", "--comments")
        self.assertNotIn("windows-vm", run.stderr)

    def test_a_skipped_python_test_fails_the_run_naming_it(self):
        self.windows_vm_test("self.skipTest('no vm')")
        run, _ = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("Passed"))
        self.assertIn("skipped  test_probe (test_probe.Probe.test_probe)", run.stdout)


if __name__ == '__main__':
    unittest.main()
