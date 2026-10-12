"""Observes slot-run.sh with a fake in_slot, systemd-run and systemctl that log what they are handed."""
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "slot-run.sh"

FAKE_SLOT = 'in_slot() { echo "in_slot $1 $2"; "${@:3}"; }\n'
FAKE_SYSTEMD_RUN = """#!/bin/bash
echo "systemd-run $*" >> "$LOG"
[[ -n ${NO_SCOPE:-} ]] && exit 1
while [[ $1 == -* ]]; do shift; done
exec "$@"
"""
FAKE_SYSTEMCTL = '#!/bin/bash\necho "systemctl $*" >> "$LOG"\n'


class SlotRun(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        validate = self.dir / ".claude/skills/validate"
        validate.mkdir(parents=True)
        shutil.copy(SCRIPT, validate)
        (validate / "slot.sh").write_text(FAKE_SLOT)
        self.script = validate / "slot-run.sh"
        tools = self.dir / "bin"
        tools.mkdir()
        for name, text in (("systemd-run", FAKE_SYSTEMD_RUN), ("systemctl", FAKE_SYSTEMCTL)):
            (tools / name).write_text(text)
            (tools / name).chmod(0o755)
        self.log = self.dir / "log"
        self.log.touch()
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("BUILD_SLOT_HELD", "MSBUILDDISABLENODEREUSE", "SharedCompilationId")}
        self.env |= {"PATH": f"{tools}:{os.environ['PATH']}", "LOG": str(self.log)}

    def slot_run(self, command, **env):
        return subprocess.run(["bash", str(self.script), "bash", "-c", command],
                              capture_output=True, text=True, timeout=30, env=self.env | env)

    def test_a_run_waits_for_one_of_two_build_slots(self):
        run = self.slot_run("echo ran")
        self.assertEqual(run.stdout, "in_slot build 2\nran\n")

    def test_the_build_slot_count_follows_the_environment(self):
        run = self.slot_run("echo ran", MEDIT_BUILD_SLOTS="1")
        self.assertEqual(run.stdout, "in_slot build 1\nran\n")

    def test_the_slot_watches_the_directory_the_run_started_in(self):
        worktree = self.dir / "worktree"
        worktree.mkdir()
        (self.script.parent / "slot.sh").write_text('in_slot() { echo "watching $ROOT"; }\n')
        run = subprocess.run(["bash", str(self.script), "true"], cwd=worktree,
                             capture_output=True, text=True, timeout=30, env=self.env)
        self.assertEqual(run.stdout, f"watching {worktree}\n")

    def test_a_run_fails_with_its_command_status(self):
        self.assertEqual(self.slot_run("exit 7").returncode, 7)

    def test_a_run_is_in_a_scope_it_stops_once_the_command_exits(self):
        self.slot_run("echo ran")
        scoped = [line for line in self.log.read_text().splitlines() if "--unit=" in line]
        self.assertEqual(len(scoped), 1)
        self.assertRegex(scoped[0], r"^systemd-run --user --scope --quiet --collect --unit=medit-build-\d+ bash -c echo ran$")
        unit = re.search(r"--unit=(\S+)", scoped[0])[1]
        self.assertEqual(self.log.read_text().splitlines()[-1], f"systemctl --user stop {unit}.scope")

    def test_a_scoped_run_compiles_on_a_compiler_server_of_its_own(self):
        run = self.slot_run('echo "server $SharedCompilationId"')
        unit = re.search(r"--unit=(\S+)", self.log.read_text())[1]
        self.assertEqual(run.stdout.splitlines()[-1], f"server {unit}")

    def test_where_systemd_gives_no_scope_the_run_is_unscoped(self):
        run = self.slot_run('echo "ran ${SharedCompilationId-on the shared server}"; exit 7', NO_SCOPE="1")
        self.assertEqual(run.stdout, "in_slot build 2\nran on the shared server\n")
        self.assertEqual(run.returncode, 7)
        self.assertNotIn("systemctl", self.log.read_text())

    def test_what_a_run_starts_holds_the_slot_and_leaves_no_msbuild_node(self):
        run = self.slot_run('echo "$BUILD_SLOT_HELD $MSBUILDDISABLENODEREUSE"')
        self.assertEqual(run.stdout.splitlines()[-1], "1 1")

    def test_a_run_inside_the_slot_neither_waits_for_it_nor_leaves_its_scope(self):
        run = self.slot_run("echo ran; exit 7", BUILD_SLOT_HELD="1")
        self.assertEqual(run.stdout, "ran\n")
        self.assertEqual(run.returncode, 7)
        self.assertEqual(self.log.read_text(), "")


if __name__ == "__main__":
    unittest.main()
