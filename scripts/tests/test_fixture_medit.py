import contextlib
import http.server
import json
import pathlib
import subprocess
import threading
import time
import sys
import unittest
from unittest import mock
import urllib.error

from tests.fixture_medit import call, fixture_medit, hand_load_order, stop

CHECKED_IN_INSTANCE = pathlib.Path(__file__).resolve().parents[2] / 'DevList'


def files_of(folder):
    return sorted(folder.rglob('*'))


class FixtureMEdit(unittest.TestCase):
    def test_medit_holds_the_fixture_instances_load_order_from_a_copy_of_it_and_stops_with_the_harness(self):
        checked_in = files_of(CHECKED_IN_INSTANCE)
        with fixture_medit() as fixture:
            plugins = call('GET', fixture.url + '/plugins')
        self.assertEqual([(plugin['name'], plugin['origin']) for plugin in plugins], [
            ('MBDevConflictB.esp', 'MB-DEV Conflict B'),
            ('MBDevConflictA.esp', 'MB-DEV Conflict A'),
            ('MBDevLight.esl', 'MB-DEV Light'),
            ('MBDevConditions.esp', 'MB-DEV Conditions'),
            ('MBDevMissingMaster.esp', 'MB-DEV Missing Master'),
        ])
        self.assertEqual(files_of(CHECKED_IN_INSTANCE), checked_in)
        with self.assertRaises(urllib.error.URLError):
            call('GET', fixture.url + '/health')


class Stop(unittest.TestCase):
    def test_a_process_that_ignores_terminate_is_killed_after_the_grace(self):
        ignoring = subprocess.Popen(
            [sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(1,flush=True);time.sleep(60)'],
            stdout=subprocess.PIPE)
        ignoring.stdout.readline()
        with mock.patch('tests.fixture_medit.STOP_GRACE_S', 0.2):
            stop(ignoring)
        self.assertIsNotNone(ignoring.poll())
        ignoring.stdout.close()


@contextlib.contextmanager
def medit_whose_put_takes(seconds):
    class Handler(http.server.BaseHTTPRequestHandler):
        def reply(self, body):
            payload = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_PUT(self):
            self.rfile.read(int(self.headers['Content-Length']))
            time.sleep(seconds)
            self.reply({'version': 1})

        def do_GET(self):
            self.reply({'version': 1, 'state': 'Ready'})

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()


class HandLoadOrder(unittest.TestCase):
    def test_a_put_slower_than_one_request_is_waited_for_within_the_load_order_deadline(self):
        with medit_whose_put_takes(0.6) as url, mock.patch('tests.fixture_medit.REQUEST_TIMEOUT_S', 0.2):
            hand_load_order(url, {})

    def test_a_put_that_outlasts_the_load_order_deadline_fails(self):
        with medit_whose_put_takes(2) as url, mock.patch('tests.fixture_medit.LOAD_ORDER_TIMEOUT_S', 0.3):
            started = time.monotonic()
            with self.assertRaises(OSError):
                hand_load_order(url, {})
            self.assertLess(time.monotonic() - started, 1)


if __name__ == '__main__':
    unittest.main()
