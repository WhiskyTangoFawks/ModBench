"""Process checks shared by the tests that stop process groups."""
import os
import time


def alive(pid):
    try:
        os.kill(pid, 0)
        with open(f"/proc/{pid}/stat") as stat:
            return stat.read().split(") ")[1][0] != "Z"
    except (ProcessLookupError, FileNotFoundError):
        return False


def wait_gone(pid, seconds=5):
    deadline = time.monotonic() + seconds
    while alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not alive(pid)
