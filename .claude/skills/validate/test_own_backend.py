"""Observes own-backend.sh: each caller reaches the backend it started, on a port no other run
shares, and on every exit path stops that backend's whole process group and nothing else."""
import os
import pathlib
import signal
import subprocess
import tempfile
import textwrap
import time
import unittest

HELPER = pathlib.Path(__file__).resolve().parent / "own-backend.sh"

FAKE_BACKEND = textwrap.dedent("""
    import http.server, os, pathlib, subprocess, sys
    token, pid_file = sys.argv[1], sys.argv[2]
    host, port = sys.argv[sys.argv.index("--urls") + 1].rsplit("/", 1)[1].rsplit(":", 1)
    child = subprocess.Popen(["sleep", "600"])
    pathlib.Path(pid_file).write_text(f"{os.getpid()} {child.pid}")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = (token if self.path == "/token" else "ok").encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    http.server.HTTPServer((host, int(port)), Handler).serve_forever()
""")


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    with open(f"/proc/{pid}/stat") as stat:
        return stat.read().split(") ")[1][0] != "Z"


def wait_gone(pid, seconds=5):
    deadline = time.monotonic() + seconds
    while alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    return not alive(pid)


class OwnBackend(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="own-backend-test-"))
        self.fake = self.dir / "fake_backend.py"
        self.fake.write_text(FAKE_BACKEND)

    def pid_file(self, token):
        return self.dir / f"{token}.pids"

    def pids(self, token):
        return [int(p) for p in self.pid_file(token).read_text().split()]

    def run_with_backend(self, token, client, server=None):
        server = server or ["python3", str(self.fake), token, str(self.pid_file(token))]
        script = f'source "{HELPER}"; start_own_backend "$@" || exit 1; {client}'
        return subprocess.Popen(["bash", "-c", script, "_", *server], start_new_session=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def test_concurrent_callers_each_reach_the_backend_they_started(self):
        runs = {token: self.run_with_backend(token, 'curl -sf "$OWN_BACKEND_URL/token"; sleep 1')
                for token in ("first", "second")}
        for token, run in runs.items():
            out, _ = run.communicate(timeout=30)
            self.assertEqual(run.returncode, 0, out)
            self.assertEqual(out.strip().splitlines()[-1], token)

    def test_stops_the_backend_and_its_children_and_keeps_the_callers_exit_status(self):
        run = self.run_with_backend("fails", 'curl -sf "$OWN_BACKEND_URL/health" >/dev/null && exit 3')
        run.communicate(timeout=30)
        self.assertEqual(run.returncode, 3)
        for pid in self.pids("fails"):
            self.assertTrue(wait_gone(pid), f"pid {pid} outlived the caller")

    def test_stops_the_backend_when_the_caller_is_interrupted(self):
        run = self.run_with_backend("interrupted", 'echo up; sleep 600')
        self.assertEqual(run.stdout.readline().strip(), "up")
        os.killpg(run.pid, signal.SIGINT)
        run.communicate(timeout=10)
        for pid in self.pids("interrupted"):
            self.assertTrue(wait_gone(pid), f"pid {pid} outlived the interrupted caller")

    def test_leaves_a_process_that_only_shares_the_backends_name_alive(self):
        decoy = subprocess.Popen(["MEditService.Http.Tests", "600"], executable="sleep")
        try:
            run = self.run_with_backend("decoy", 'curl -sf "$OWN_BACKEND_URL/health" >/dev/null')
            run.communicate(timeout=30)
            self.assertEqual(run.returncode, 0)
            self.assertTrue(alive(decoy.pid))
        finally:
            decoy.kill()
            decoy.wait()

    def test_backend_that_exits_before_listening_fails_the_start_with_its_output(self):
        run = self.run_with_backend("dead", "echo reached-client",
                                    server=["python3", "-c", "print('boom'); raise SystemExit(1)"])
        out, _ = run.communicate(timeout=30)
        self.assertEqual(run.returncode, 1)
        self.assertIn("boom", out)
        self.assertNotIn("reached-client", out)


if __name__ == "__main__":
    unittest.main()
