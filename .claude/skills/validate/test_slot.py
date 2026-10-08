"""Observes in_slot with a fake gate command, on lock files of its own kind."""
import fcntl
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
import uuid

SLOT = pathlib.Path(__file__).resolve().parent / "slot.sh"


class InSlot(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.root = self.dir / "root"
        self.root.mkdir()
        self.kind = f"test-{uuid.uuid4().hex}"
        self.addCleanup(lambda: [lock.unlink() for lock in pathlib.Path("/tmp").glob(f"medit-{self.kind}-gate.*.lock")])

    def in_slot(self, slots, command):
        run = subprocess.Popen(["bash", "-c", f'source "$1"; in_slot {self.kind} {slots} bash -c "$2"', "_", SLOT, command],
                               env={**os.environ, "ROOT": str(self.root)}, start_new_session=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(run.wait)
        self.addCleanup(run.kill)
        return run

    def hold(self, slot):
        lock = open(f"/tmp/medit-{self.kind}-gate.{slot}.lock", "a")
        fcntl.flock(lock, fcntl.LOCK_EX)
        self.addCleanup(lock.close)
        return lock

    def free(self, slot):
        with open(f"/tmp/medit-{self.kind}-gate.{slot}.lock", "a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                return False

    def in_slot_with_a_grandchild(self):
        """A gate command whose leader and grandchild both outlive any test unless killed."""
        run = self.in_slot(1, f"sleep 60 & echo $! > {self.dir}/grandchild; echo $$ > {self.dir}/leader; wait")
        deadline = time.monotonic() + 10
        files = [self.dir / "leader", self.dir / "grandchild"]
        while not all(f.exists() and f.read_text().strip() for f in files):
            self.assertLess(time.monotonic(), deadline, "the command never started")
            time.sleep(0.05)
        pids = [int(f.read_text()) for f in files]
        for f in files:
            f.unlink()
        self.addCleanup(lambda: [subprocess.run(["kill", "-KILL", str(pid)], capture_output=True) for pid in pids])
        return run, pids

    def assertGone(self, pids):
        def alive(pid):
            try:
                return pathlib.Path(f"/proc/{pid}/stat").read_text().split(")")[-1].split()[0] != "Z"
            except FileNotFoundError:
                return False
        deadline = time.monotonic() + 5
        while any(alive(pid) for pid in pids) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual([pid for pid in pids if alive(pid)], [])

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

    def test_a_waiter_runs_in_the_slot_that_frees_first(self):
        self.hold(1)
        second = self.hold(2)
        run = self.in_slot(2, "echo ran")
        time.sleep(2.5)
        second.close()
        out, _ = run.communicate(timeout=10)
        self.assertEqual(out.count(f"=== Waiting for a {self.kind} gate slot ==="), 1)
        self.assertIn("ran", out)

    def test_a_failing_command_fails_with_its_own_status(self):
        run = self.in_slot(1, "exit 7")
        run.communicate(timeout=10)
        self.assertEqual(run.returncode, 7)


if __name__ == "__main__":
    unittest.main()
