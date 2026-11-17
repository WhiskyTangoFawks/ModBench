"""Observes slot-run.sh waiting on the Windows VM and on an acceptance run, through a fake docker and a scratch folder of runs."""
import fcntl
import os
import pathlib
import select
import shutil
import signal
import subprocess
import tempfile
import unittest
import uuid

from processes import alive, wait_gone

SKILLS = pathlib.Path(__file__).resolve().parent.parent

FAKE_DOCKER = """#!/bin/bash
echo "docker $*" >> "$LOG"
[[ $1 == ps && -e $VM_RUNNING ]] && echo 0123456789ab
exit 0
"""
FAKE_CODE = '#!/bin/bash\necho launched > "$LAUNCHED"\n'
WAIT_S = 30
SUCCEED = "#!/bin/bash\nexit 0\n"
NO_SCOPE = "#!/bin/bash\nexit 1\n"


class HeavyRuns(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.kind = f"test-{uuid.uuid4().hex}"
        self.buffers = {}
        self.addCleanup(lambda: [lock.unlink() for lock in pathlib.Path("/tmp").glob(f"medit-{self.kind}-slot.*.lock")])
        tools = self.dir / "bin"
        tools.mkdir()
        for name, text in (("docker", FAKE_DOCKER), ("ssh", SUCCEED), ("scp", SUCCEED), ("Xvfb", SUCCEED), ("code", FAKE_CODE),
                           ("systemd-run", NO_SCOPE)):
            (tools / name).write_text(text)
            (tools / name).chmod(0o755)
        self.log = self.dir / "log"
        self.log.touch()
        self.vm_running = self.dir / "vm-running"
        self.accept_runs = self.dir / "accept"
        self.accept_runs.mkdir()
        self.launched = self.dir / "launched"
        os.mkfifo(self.launched)
        self.env = {k: v for k, v in os.environ.items() if k not in ("BUILD_SLOT_HELD", "SLOT_INSIDE")}
        self.env |= {"PATH": f"{tools}:{os.environ['PATH']}", "LOG": str(self.log), "VM_RUNNING": str(self.vm_running), "LAUNCHED": str(self.launched),
                     "MEDIT_SLOT_KIND": self.kind, "SLOT_ACCEPT_PREFIX": f"{self.accept_runs}/run.",
                     "MODBENCH_WINDOWS_HOME": str(self.dir / "vm")}

    def start(self, *command, cwd=None, **env):
        run = subprocess.Popen(command, cwd=cwd, env=self.env | env, start_new_session=True,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(run.stdout.close)
        self.addCleanup(run.wait)
        self.addCleanup(lambda: subprocess.run(["kill", "-KILL", "--", f"-{run.pid}"], capture_output=True))
        return run

    def slot_run(self, **env):
        return self.start("bash", str(SKILLS / "validate/slot-run.sh"), "echo", "ran", **env)

    def line(self, run):
        """The next line a run printed. A run that prints nothing fails the test instead of hanging the suite."""
        buffered = self.buffers.get(run.pid, b"")
        while b"\n" not in buffered:
            ready, _, _ = select.select([run.stdout], [], [], WAIT_S)
            self.assertTrue(ready, "the run printed nothing")
            chunk = os.read(run.stdout.fileno(), 4096)
            if not chunk:
                break
            buffered += chunk
        text, _, self.buffers[run.pid] = buffered.partition(b"\n")
        return text.decode() + "\n" if text or buffered else ""

    def launch_signal(self):
        descriptor = os.open(self.launched, os.O_RDONLY | os.O_NONBLOCK)
        self.addCleanup(os.close, descriptor)
        ready, _, _ = select.select([descriptor], [], [], WAIT_S)
        self.assertTrue(ready, "code was never launched")
        return os.read(descriptor, 64).decode()

    def waiting_on(self, run):
        """What a run that waits names, read before the run is let go. A run that did not wait prints `ran` here."""
        self.assertEqual(self.line(run), f"=== Waiting for a {self.kind} slot ===\n")
        return self.line(run).strip()

    def ran_after(self, run):
        self.assertEqual(self.line(run), "ran\n")
        self.assertEqual(run.wait(timeout=WAIT_S), 0)

    def start_acceptance_run(self, processes=1):
        """A run folder whose pids file names `processes` stand-ins, as accept.sh stamps them."""
        run = self.accept_runs / "run.A1B2"
        run.mkdir()
        started = []
        for _ in range(processes):
            pid = int(subprocess.run(["bash", "-c", "sleep 600 >/dev/null 2>&1 & echo $!"],
                                     capture_output=True, text=True, check=True).stdout)
            self.addCleanup(subprocess.run, ["kill", "-KILL", str(pid)], capture_output=True)
            started.append(pid)
            with open(run / "pids", "a") as pids:
                pids.write(f"{pid} {self.start_time(pid)}\n")
        return started, run

    def start_time(self, pid):
        return pathlib.Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]

    def hold_the_slot(self):
        lock = open(f"/tmp/medit-{self.kind}-slot.1.lock", "a")
        fcntl.flock(lock, fcntl.LOCK_EX)
        self.addCleanup(lock.close)
        return lock

    def test_a_run_waits_while_the_vm_is_up_and_runs_once_it_is_not(self):
        self.vm_running.touch()
        run = self.slot_run()
        self.assertIn("Windows VM", self.waiting_on(run))
        self.vm_running.unlink()
        self.ran_after(run)

    def test_a_run_waits_while_an_acceptance_run_is_up_and_runs_once_it_is_not_however_it_ended(self):
        for ending in (signal.SIGKILL, signal.SIGTERM):
            with self.subTest(ending=ending.name):
                (xvfb,), run_dir = self.start_acceptance_run()
                run = self.slot_run()
                self.assertIn(str(run_dir), self.waiting_on(run))
                os.kill(xvfb, ending)
                self.assertTrue(wait_gone(xvfb))
                self.ran_after(run)
                shutil.rmtree(run_dir)

    def test_an_acceptance_run_is_up_while_any_process_of_it_is(self):
        (xvfb, code), run_dir = self.start_acceptance_run(processes=2)
        os.kill(xvfb, signal.SIGKILL)
        self.assertTrue(wait_gone(xvfb))
        run = self.slot_run()
        self.assertIn(str(run_dir), self.waiting_on(run))
        os.kill(code, signal.SIGKILL)
        self.assertTrue(wait_gone(code))
        self.ran_after(run)

    def test_a_pid_that_went_to_another_process_neither_holds_the_slot_nor_is_stopped_by_down(self):
        (stranger,), run_dir = self.start_acceptance_run()
        (run_dir / "pids").write_text(f"{stranger} 1\n")
        self.ran_after(self.slot_run())
        down = subprocess.run(["bash", str(SKILLS / "acceptance/accept.sh"), "down", str(run_dir)],
                              env=self.env | {"MODBENCH_ACCEPT_HOME": str(self.dir / "state")}, capture_output=True, text=True, timeout=WAIT_S)
        self.assertEqual(down.returncode, 0, down.stderr)
        self.assertTrue(alive(stranger))

    def test_down_stops_the_processes_the_run_recorded(self):
        (xvfb,), run_dir = self.start_acceptance_run()
        subprocess.run(["bash", str(SKILLS / "acceptance/accept.sh"), "down", str(run_dir)],
                       env=self.env | {"MODBENCH_ACCEPT_HOME": str(self.dir / "state")}, capture_output=True, check=True, timeout=WAIT_S)
        self.assertTrue(wait_gone(xvfb))
        self.assertFalse(run_dir.exists())

    def test_a_run_inside_a_session_runs_beside_that_session_only(self):
        self.vm_running.touch()
        self.ran_after(self.slot_run(SLOT_INSIDE="windows-vm"))
        self.start_acceptance_run()
        self.ran_after(self.slot_run(SLOT_INSIDE="windows-vm,acceptance"))
        self.assertIn("Windows VM", self.waiting_on(self.slot_run(SLOT_INSIDE="acceptance")))

    def test_a_run_with_no_heavy_run_up_does_not_wait(self):
        self.ran_after(self.slot_run())

    def test_a_run_with_no_acceptance_folder_prints_nothing_to_stderr(self):
        run = subprocess.run(["bash", str(SKILLS / "validate/slot-run.sh"), "true"], env=self.env,
                             capture_output=True, text=True, timeout=WAIT_S)
        self.assertEqual(run.stderr, "")

    def test_vm_up_waits_for_a_gate_run_that_holds_the_slot_and_then_starts_the_vm(self):
        lock = self.hold_the_slot()
        up = self.start("bash", str(SKILLS / "windows-vm/vm.sh"), "up")
        self.assertEqual(self.line(up), f"=== Waiting for a {self.kind} slot ===\n")
        lock.close()
        up.wait(timeout=60)
        self.assertEqual(up.returncode, 0)
        self.assertIn("compose -f", self.log.read_text())
        self.assertIn(" up -d", self.log.read_text())

    def test_vm_up_does_not_wait_on_a_vm_that_is_already_up(self):
        self.vm_running.touch()
        up = self.start("bash", str(SKILLS / "windows-vm/vm.sh"), "up")
        up.wait(timeout=60)
        self.assertEqual(up.returncode, 0)

    def built_tree(self):
        scratch = self.dir / "scratch"
        for skill in ("acceptance", "validate"):
            shutil.copytree(SKILLS / skill, scratch / ".claude/skills" / skill)
        (scratch / "modbench/out").mkdir(parents=True)
        (scratch / "modbench/out/extension.js").touch()
        (scratch / "modbench/backend").mkdir()
        backend = scratch / "modbench/backend/MEditService.Http"
        backend.touch()
        backend.chmod(0o755)
        subprocess.run(["git", "init", "-q", str(scratch)], check=True)
        folder = self.dir / "instance"
        folder.mkdir()
        return scratch, folder

    def test_accept_up_waits_for_the_slot_before_it_launches_anything(self):
        scratch, folder = self.built_tree()
        self.hold_the_slot()
        up = self.start("bash", str(scratch / ".claude/skills/acceptance/accept.sh"), "up", str(folder), cwd=scratch,
                        MODBENCH_ACCEPT_HOME=str(self.dir / "state"))
        self.assertEqual(self.line(up), f"=== Waiting for a {self.kind} slot ===\n")

    def test_a_build_and_up_in_one_slot_run_hold_the_slot_into_the_launch(self):
        scratch, folder = self.built_tree()
        combined = self.start("bash", str(scratch / ".claude/skills/validate/slot-run.sh"), "bash", "-c",
                              f'echo built; "{scratch}/.claude/skills/acceptance/accept.sh" up "{folder}"',
                              cwd=scratch, MODBENCH_ACCEPT_HOME=str(self.dir / "state"), SLOT_KEEP_SCOPE="1")
        self.assertEqual(self.line(combined), "built\n")
        self.assertEqual(self.launch_signal(), "launched\n")
        self.assertEqual(self.line(self.slot_run()), f"=== Waiting for a {self.kind} slot ===\n")


if __name__ == "__main__":
    unittest.main()
