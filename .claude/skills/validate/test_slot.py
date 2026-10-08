"""Observes in_slot with a fake gate command, on lock files of its own kind."""
import fcntl
import os
import pathlib
import select
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import uuid

from processes import wait_gone

SLOT = pathlib.Path(__file__).resolve().parent / "slot.sh"


class InSlot(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.root = self.dir / "root"
        self.root.mkdir()
        self.kind = f"test-{uuid.uuid4().hex}"
        self.addCleanup(lambda: [lock.unlink() for lock in pathlib.Path("/tmp").glob(f"medit-{self.kind}-gate.*.lock")])

    def in_slot(self, slots, command, path=None):
        env = {**os.environ, "ROOT": str(self.root), **({"PATH": path} if path else {})}
        run = subprocess.Popen(["bash", "-c", f'source "$1"; in_slot {self.kind} {slots} bash -c "$2"', "_", SLOT, command],
                               env=env, start_new_session=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(run.wait)
        self.addCleanup(run.kill)
        return run

    def lock(self, slot):
        return open(f"/tmp/medit-{self.kind}-gate.{slot}.lock", "a")

    def hold(self, slot):
        lock = self.lock(slot)
        fcntl.flock(lock, fcntl.LOCK_EX)
        self.addCleanup(lock.close)
        return lock

    def free(self, slot):
        with self.lock(slot) as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                return False

    def await_line(self, run, text):
        deadline = time.monotonic() + 10
        while (left := deadline - time.monotonic()) > 0 and select.select([run.stdout], [], [], left)[0]:
            line = run.stdout.readline()
            if text in line:
                return
            if not line:
                break
        self.fail(f"no line holding {text!r}")

    def pids(self, *names):
        files = [self.dir / name for name in names]
        deadline = time.monotonic() + 10
        while not all(f.exists() and f.read_text().strip() for f in files):
            self.assertLess(time.monotonic(), deadline, "the command never started")
            time.sleep(0.05)
        pids = [int(f.read_text()) for f in files]
        for f in files:
            f.unlink()
        self.addCleanup(lambda: [subprocess.run(["kill", "-KILL", str(pid)], capture_output=True) for pid in pids])
        return pids

    def in_slot_with_a_grandchild(self):
        """A gate command whose leader and grandchild both outlive any test unless killed."""
        run = self.in_slot(1, f"sleep 60 & echo $! > {self.dir}/grandchild; echo $$ > {self.dir}/leader; wait")
        return run, self.pids("leader", "grandchild")

    def assertGone(self, pids):
        self.assertEqual([pid for pid in pids if not wait_gone(pid)], [])

    def test_removing_the_worktree_kills_the_run_and_frees_its_slot(self):
        run, pids = self.in_slot_with_a_grandchild()
        shutil.rmtree(self.root)
        _, err = run.communicate(timeout=30)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("worktree gone", err)
        self.assertGone(pids)
        self.assertTrue(self.free(1))

    def test_killing_the_caller_kills_the_run_and_frees_its_slot(self):
        for kill in (os.kill, os.killpg):
            with self.subTest(kill=kill.__name__):
                run, pids = self.in_slot_with_a_grandchild()
                kill(run.pid, signal.SIGKILL)
                _, err = run.communicate(timeout=30)
                self.assertIn("caller gone", err)
                self.assertGone(pids)
                self.assertTrue(self.free(1))

    def test_a_waiter_whose_caller_is_gone_never_runs(self):
        first = self.hold(1)
        run = self.in_slot(1, f"touch {self.dir}/ran")
        self.await_line(run, f"=== Waiting for a {self.kind} gate slot ===")
        os.kill(run.pid, signal.SIGKILL)
        _, err = run.communicate(timeout=10)
        first.close()
        self.assertIn("caller gone", err)
        self.assertFalse((self.dir / "ran").exists())

    def test_ctrl_c_at_the_caller_stops_the_run_and_frees_its_slot(self):
        run = self.in_slot(1, f"echo $$ > {self.dir}/leader; bash -c 'echo $$ > {self.dir}/child; exec sleep 60'")
        pids = self.pids("leader", "child")
        os.killpg(run.pid, signal.SIGINT)
        run.communicate(timeout=30)
        self.assertEqual(run.returncode, 130)
        self.assertGone(pids)
        self.assertTrue(self.free(1))

    def test_a_process_the_run_leaves_behind_does_not_hold_the_slot(self):
        run = self.in_slot(1, f"setsid sleep 60 >/dev/null 2>&1 & echo $! > {self.dir}/lingering")
        run.communicate(timeout=10)
        self.pids("lingering")
        self.assertEqual(run.returncode, 0)
        self.assertTrue(self.free(1))

    def test_a_waiter_runs_in_the_slot_that_frees_first(self):
        self.hold(1)
        second = self.hold(2)
        run = self.in_slot(2, "echo ran")
        self.await_line(run, f"=== Waiting for a {self.kind} gate slot ===")
        second.close()
        out, _ = run.communicate(timeout=10)
        self.assertNotIn("Waiting", out)
        self.assertIn("ran", out)

    def test_a_failing_command_fails_with_its_own_status(self):
        run = self.in_slot(1, "exit 7")
        run.communicate(timeout=10)
        self.assertEqual(run.returncode, 7)

    def test_a_command_that_exits_99_runs_once(self):
        run = self.in_slot(2, f"echo ran >> {self.dir}/runs; exit 99")
        run.communicate(timeout=10)
        self.assertEqual(run.returncode, 99)
        self.assertEqual((self.dir / "runs").read_text(), "ran\n")

    def test_without_setsid_the_command_still_runs_in_a_slot(self):
        tools = self.dir / "bin"
        tools.mkdir()
        for tool in ["bash", "flock", "seq", "sleep"]:
            (tools / tool).symlink_to(shutil.which(tool))
        self.hold(1)
        run = self.in_slot(2, f"echo ran; exit 7", path=str(tools))
        out, _ = run.communicate(timeout=10)
        self.assertEqual(run.returncode, 7)
        self.assertIn("ran", out)
        self.assertTrue(self.free(2))


if __name__ == "__main__":
    unittest.main()
