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
    TIER_PAUSED = "true"

    def setUp(self):
        self.repo = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.repo)
        for kind in ("", ".comments"):
            self.addCleanup(shutil.rmtree, pathlib.Path("/tmp", f"medit-reports.{pathlib.Path(self.repo).name}{kind}"), ignore_errors=True)
        self.validate = pathlib.Path(self.repo, ".claude/skills/validate")
        self.validate.mkdir(parents=True)
        script = self.validate / "run-gates.sh"
        script.write_text(SCRIPT.read_text().replace("MERGE_TIER_PAUSED=true", f"MERGE_TIER_PAUSED={self.TIER_PAUSED}", 1))
        shutil.copy(SCRIPT.parent / "select_gates.py", self.validate)
        (self.validate / "slot-run.sh").write_text('echo "slot-run: $*"\n')
        for path in ("MEditService/Core/a.cs", "modbench/src/a.ts", "scripts/a.py", "spec/a.d2"):
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
    EVERY_GATE = "--backend --api-drift --frontend --scripts --docs"

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

    def test_a_backend_change_since_main_runs_the_frontend_gate(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.write("MEditService/Core/a.cs", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertEqual(self.selected(), self.slot_line("--backend --api-drift --frontend"))

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
        shutil.copy(SCRIPT.parent / "reports.py", self.validate)
        shutil.copy(SCRIPT.parent / "check_test_times.py", self.validate)
        shutil.copy(SCRIPT.parent / "check_test_data.py", self.validate)
        shutil.copy(SCRIPT.parent / "check_test_only_code.py", self.validate)
        shutil.copy(SCRIPT.parent / "skips.py", self.validate)
        shutil.copy(SCRIPT.parent / "test-budgets.toml", self.validate)
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

    def trx(self, outcome, slow_seconds=0):
        name = pathlib.Path(self.repo, "fake.trx")
        slow = (f'<UnitTestResult testId="s" testName="Fake.Slow" duration="00:00:{slow_seconds:02d}" '
                'endTime="2026-10-02T19:01:00+00:00" outcome="Passed" />') if slow_seconds else ""
        name.write_text(
            '<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><TestDefinitions>'
            + "".join(f'<UnitTest id="{test}"><TestMethod codeBase="/b/MEditService.Http.Tests.dll" /></UnitTest>' for test in "as")
            + '</TestDefinitions><Results>'
            f'<UnitTestResult testId="a" testName="Fake.ATest" duration="00:00:00.1" endTime="2026-10-02T19:00:01+00:00" outcome="{outcome}" />'
            f'{slow}</Results></TestRun>')
        return str(name)

    def run_after_changing(self, path, *flags, **env):
        self.write(path, "edited")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "edit")
        run = self.gates(*flags, BUILD_SLOT_HELD="1", PATH=f"{self.bin}:{os.environ['PATH']}", **env)
        return run, self.calls.read_text().splitlines() if self.calls.exists() else []


class BranchTests(FakeDotnet):
    """A filter on the command line replaces the branch's filter in MEditService/Directory.Build.props."""

    def filter_present_per_dotnet_test(self, calls):
        return ["--filter" in call for call in calls if call.startswith("test ")]

    def test_the_tests_of_a_branch_that_touches_http_pass_no_filter(self):
        _, calls = self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend")
        self.assertEqual(self.filter_present_per_dotnet_test(calls), [False, False], calls)

    def test_the_docs_scans_of_a_branch_pass_no_filter(self):
        _, calls = self.run_after_changing("spec/a.d2", "--docs")
        self.assertEqual(self.filter_present_per_dotnet_test(calls), [False], calls)


class TimeReport(FakeDotnet):
    def test_a_run_in_the_slot_names_each_test_over_100_ms_and_the_wall_time_against_the_branch_budget(self) -> None:
        run, _ = self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend", FAKE_TRX=self.trx("Passed", 5))
        self.assertIn("5.00 s  Fake.Slow", run.stdout)
        self.assertNotIn("Fake.ATest", run.stdout)
        self.assertRegex(run.stdout, r"Wall time \d+ s of 300 s budget\n")

    def test_a_unittest_run_leaves_its_log_with_each_tests_time_for_the_report(self):
        self.write(".claude/hooks/test_probe.py",
                   "import unittest\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n        pass\n")
        self.run_after_changing("spec/a.d2", "--docs")
        log = pathlib.Path("/tmp", f"medit-reports.{pathlib.Path(self.repo).name}", "logs", "hooks.unittest")
        self.assertIn("test_probe (test_probe.Probe.test_probe)", log.read_text().split("Slowest test durations")[1])

    def test_a_run_in_the_slot_names_committed_test_data_over_its_size_and_backend_code_only_tests_reach(self):
        self.write("MEditService/MEditService.Http/Source.cs", "public class Http {\n    public int OnlyTests() => 1;\n}\nclass Uses { Http http; }")
        self.write("MEditService/MEditService.Http.Tests/Source.cs", "class T { int n = new Http().OnlyTests(); }")
        self.write("MEditService/MEditService.Http.Tests/TestData/big.bin", "x" * 65537)
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "data and code")
        run, _ = self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend")
        self.assertIn("64.0 KB  MEditService/MEditService.Http.Tests/TestData/big.bin", run.stdout)
        self.assertIn("--- 1 TEST DATA FILES OVER 64 KB ---", run.stdout)
        self.assertIn("OnlyTests  MEditService.Http/Source.cs", run.stdout)
        self.assertIn("--- 1 MEMBERS ONLY TESTS REACH ---", run.stdout)
        self.assertNotIn("REPORT FAILED", run.stdout)

    def switch_on(self, script: str) -> None:
        switched = self.validate / script
        switched.write_text(switched.read_text().replace("FAILS_THE_RUN = False", "FAILS_THE_RUN = True"))

    def run_with_the_switch_of(self, script: str) -> subprocess.CompletedProcess[str]:
        self.write("MEditService/MEditService.Http/Source.cs", "public class Http {\n    public int OnlyTests() => 1;\n}\nclass Uses { Http http; }")
        self.write("MEditService/MEditService.Http.Tests/Source.cs", "class T { int n = new Http().OnlyTests(); }")
        self.write("MEditService/MEditService.Http.Tests/TestData/big.bin", "x" * 65537)
        self.switch_on(script)
        return self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend")[0]

    def test_the_switch_of_the_test_data_report_fails_the_run(self):
        self.assertIn("--- TEST DATA REPORT FAILED ---", self.run_with_the_switch_of("check_test_data.py").stdout)

    def test_the_switch_of_the_backend_report_fails_the_run(self):
        self.assertIn("--- BACKEND TEST-ONLY CODE REPORT FAILED ---", self.run_with_the_switch_of("check_test_only_code.py").stdout)

    def test_the_switch_of_the_time_budgets_fails_a_run_with_a_box_over_its_budget(self) -> None:
        self.write(".claude/skills/validate/test-budgets.toml", 'other = 60\n[boxes]\n"MEditService.Http.Tests" = 4\n')
        self.switch_on("check_test_times.py")
        run, _ = self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend", FAKE_TRX=self.trx("Passed", 5))
        self.assertIn("    5.0 s of    4 s  MEditService.Http.Tests: OVER BUDGET by 1.0 s\n", run.stdout)
        self.assertIn("--- TEST TIME REPORT FAILED ---", run.stdout)
        self.assertEqual(run.returncode, 1)

    def test_the_comment_gate_alone_prints_the_time_report_of_its_unittests_and_no_other(self):
        self.write(".claude/hooks/test_probe.py",
                   "import unittest\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n        pass\n")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-q", "-m", "probe")
        run = self.gates("--comments")
        self.assertRegex(run.stdout, r"=== Test times and budget ===\n--- 0 TESTS OVER 100 ms ---\n +0\.0 s of +\d+ s  the tests of no box\n"
                                     r" +0\.0 s  hooks\n--- 0 BUDGETS OVERRUN OR MISSING ---\nWall time \d+ s of 300 s budget\n")
        log = pathlib.Path("/tmp", f"medit-reports.{pathlib.Path(self.repo).name}.comments", "logs", "hooks.unittest")
        self.assertIn("test_probe (test_probe.Probe.test_probe)", log.read_text().split("Slowest test durations")[1])
        self.assertNotIn("TEST DATA FILES", run.stdout)

    def test_a_time_report_that_cannot_read_a_report_fails_the_run_saying_so(self):
        run, _ = self.run_after_changing("MEditService/MEditService.Http/a.cs", "--backend", FAKE_TRX="/dev/null")
        self.assertIn("--- TEST TIME REPORT FAILED ---", run.stdout)

    def test_the_docs_scans_beside_no_backend_run_write_a_trx_for_the_report(self):
        _, calls = self.run_after_changing("spec/a.d2", "--docs")
        self.assertRegex(calls[0], r"--logger trx --results-directory /tmp/medit-reports\.[^/ ]+/backend ")
        self.assertTrue(calls[0].endswith("MEditService.Architecture.Tests"), calls)


class FrontendDependencies(FakeDotnet):
    def setUp(self):
        super().setUp()
        npm = self.bin / "npm"
        npm.write_text(f'#!/bin/sh\necho "npm $*" >> {self.calls}\n[ "$FAKE_NPM_FAILS" ] && exit 1\nexit 0\n')
        npm.chmod(0o755)

    def test_a_checkout_with_no_node_modules_installs_them_before_the_frontend_gates(self):
        _, calls = self.run_after_changing("modbench/src/a.ts", "--frontend")
        self.assertEqual(calls, ["npm ci"])

    def test_a_failed_install_fails_the_frontend_gates_at_once_saying_so(self):
        run, _ = self.run_after_changing("modbench/src/a.ts", "--frontend", FAKE_NPM_FAILS="1")
        self.assertIn("npm ci failed", run.stderr)
        self.assertIn("--- FRONTEND GATES FAILED ---", run.stdout)

    def test_a_checkout_that_has_them_installs_nothing(self):
        self.write("modbench/node_modules/.bin/vitest", "")
        pathlib.Path(self.repo, "modbench/node_modules/.bin/vitest").chmod(0o755)
        _, calls = self.run_after_changing("modbench/src/a.ts", "--frontend")
        self.assertEqual(calls, [])


class MergeToMainPaused(FakeDotnet):
    NOTICE = "The merge-to-main tier is paused until epic #2450 lands"

    def test_the_mode_reports_against_the_merge_to_main_budget_though_it_runs_the_branch_gates(self):
        run, _ = self.run_after_changing("spec/a.d2", "--merge-to-main")
        self.assertRegex(run.stdout, r"Wall time \d+ s of 600 s budget\n")

    def test_the_mode_runs_the_branch_gates_and_says_the_tier_is_paused(self):
        run, calls = self.run_after_changing("spec/a.d2", "--merge-to-main")
        self.assertIn(self.NOTICE, run.stdout)
        self.assertEqual([call for call in calls if "--filter" in call], [], calls)
        self.assertNotIn("=== Skipped tests ===", run.stdout)

    def test_the_environment_form_of_the_mode_says_the_tier_is_paused(self):
        run, _ = self.run_after_changing("spec/a.d2", MEDIT_MERGE_TO_MAIN="true")
        self.assertEqual(run.stdout.count(self.NOTICE), 1, run.stdout)

    def test_a_branch_run_does_not_say_it(self):
        run, _ = self.run_after_changing("spec/a.d2")
        self.assertNotIn(self.NOTICE, run.stdout)

    def test_the_mode_runs_the_branch_diff_since_the_branch_it_tracks(self):
        git(self.repo, "checkout", "-q", "-b", "integration")
        self.write("modbench/src/a.ts", "edited")
        git(self.repo, "commit", "-q", "-am", "frontend")
        git(self.repo, "checkout", "-q", "--track", "-b", "ticket", "integration")
        self.write("spec/a.d2", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertEqual(self.gates("--merge-to-main").stdout.splitlines()[-1], self.slot_line("--docs"))


class MergeToMain(FakeDotnet):
    TIER_PAUSED = "false"
    MODE = "--merge-to-main"

    def test_the_report_reads_a_merge_to_main_against_its_budget_of_ten_minutes(self):
        run, _ = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("Passed"))
        self.assertRegex(run.stdout, r"Wall time \d+ s of 600 s budget\n")

    def test_the_mode_runs_the_gates_the_whole_diff_since_main_can_break_not_the_diff_since_the_branch_it_tracks(self):
        git(self.repo, "checkout", "-q", "-b", "integration")
        self.write("modbench/src/a.ts", "edited")
        git(self.repo, "commit", "-q", "-am", "frontend")
        git(self.repo, "checkout", "-q", "--track", "-b", "ticket", "integration")
        self.write("spec/a.d2", "edited")
        git(self.repo, "commit", "-q", "-am", "edit")
        self.assertEqual(self.gates(self.MODE).stdout.splitlines()[-1], self.slot_line("--frontend --docs"))

    def test_a_skipped_test_fails_the_run_naming_it(self):
        run, _ = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("NotExecuted"))
        self.assertIn("skipped  Fake.ATest", run.stdout)
        self.assertEqual(run.returncode, 1)

    def test_the_gate_runner_tests_run_as_branch_runs(self):
        self.write(".claude/skills/validate/test_probe.py",
                   "import os, unittest\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n"
                   "        self.assertNotIn('MEDIT_MERGE_TO_MAIN', os.environ)\n")
        run, _ = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("Passed"))
        self.assertNotIn("test_probe", run.stdout)

    def test_a_skipped_python_test_fails_the_run_naming_it(self):
        self.write(".claude/hooks/test_probe.py",
                   "import unittest\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n        self.skipTest('no probe')\n")
        run, _ = self.run_after_changing("spec/a.d2", self.MODE, FAKE_TRX=self.trx("Passed"))
        self.assertIn("skipped  test_probe (test_probe.Probe.test_probe)", run.stdout)


if __name__ == '__main__':
    unittest.main()
