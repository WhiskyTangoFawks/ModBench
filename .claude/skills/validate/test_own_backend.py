import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import textwrap
import time
import unittest

HELPER = pathlib.Path(__file__).resolve().parent / "own-backend.sh"

FAKE_BACKEND = textwrap.dedent("""
    import http.server, os, pathlib, socket, subprocess, sys, time
    token, pid_file = sys.argv[1], sys.argv[2]
    host, port = sys.argv[sys.argv.index("--urls") + 1].rsplit("/", 1)[1].rsplit(":", 1)
    child = subprocess.Popen(["sleep", "600"])
    pathlib.Path(pid_file).write_text(f"{os.getpid()} {child.pid}")
    if "--silent-listener-first" in sys.argv:
        silent = socket.create_server((host, 0))
        time.sleep(1)

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


def started_by_fake_backend(pid, token):
    try:
        argv = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except FileNotFoundError:
        return False
    return token.encode() in argv or argv[:2] == [b"sleep", b"600"]


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

    def run_with_backend(self, token, client, server=None, before="", fake_args=(), env=None):
        server = server or ["python3", str(self.fake), token, str(self.pid_file(token)), *fake_args]
        script = f'{before}\nsource "{HELPER}"; start_own_backend "$@" || exit 1; {client}'
        run = subprocess.Popen(["bash", "-c", script, "_", *server], start_new_session=True, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(self.kill_leftovers, run, token)
        return run

    def kill_leftovers(self, run, token):
        pids = self.pids(token) if self.pid_file(token).exists() else []
        leftovers = [pid for pid in pids if started_by_fake_backend(pid, token)]
        for kill, target in [(os.killpg, run.pid), *((os.kill, pid) for pid in leftovers)]:
            try:
                kill(target, signal.SIGKILL)
            except ProcessLookupError:
                pass
        run.communicate()

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

    def test_stops_the_backend_when_the_caller_is_terminated(self):
        run = self.run_with_backend("terminated", 'sleep 600')
        client_running = lambda: subprocess.run(["pgrep", "-g", str(run.pid), "-x", "sleep"],
                                                capture_output=True).returncode == 0
        deadline = time.monotonic() + 10
        while not client_running() and time.monotonic() < deadline:
            time.sleep(0.05)
        os.killpg(run.pid, signal.SIGTERM)
        run.communicate(timeout=10)
        self.assertEqual(run.returncode, 143)
        for pid in self.pids("terminated"):
            self.assertTrue(wait_gone(pid), f"pid {pid} outlived the terminated caller")

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

    def test_reaches_the_listener_that_answers_health_when_another_opened_first(self):
        run = self.run_with_backend("two-listeners", 'curl -sf "$OWN_BACKEND_URL/token"',
                                    fake_args=["--silent-listener-first"])
        out, _ = run.communicate(timeout=30)
        self.assertEqual(run.returncode, 0, out)
        self.assertEqual(out.strip().splitlines()[-1], "two-listeners")

    def test_without_ss_the_start_fails_at_once_naming_it(self):
        tools = self.dir / "bin"
        tools.mkdir()
        for tool in ["bash", "python3", "setsid", "pgrep", "paste", "awk", "grep", "curl", "sleep",
                     "mktemp", "tail", "rm", "seq"]:
            (tools / tool).symlink_to(shutil.which(tool))
        run = self.run_with_backend("no-ss", "echo reached-client", env={**os.environ, "PATH": str(tools)})
        out, _ = run.communicate(timeout=10)
        self.assertEqual(run.returncode, 1)
        self.assertIn("`ss`", out)
        self.assertNotIn("reached-client", out)
        self.assertFalse(self.pid_file("no-ss").exists(), "a backend started without a way to find its port")

    def test_with_job_control_on_the_start_refuses_before_starting_a_backend(self):
        run = self.run_with_backend("job-control", "echo reached-client", before="set -m")
        out, _ = run.communicate(timeout=10)
        self.assertEqual(run.returncode, 1)
        self.assertIn("job control", out)
        self.assertNotIn("reached-client", out)
        self.assertFalse(self.pid_file("job-control").exists(), "a backend started outside the caller's reach")


if __name__ == "__main__":
    unittest.main()
