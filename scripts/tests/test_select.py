import contextlib
import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import urlparse

import medit
from tests.fixture_medit import fixture_medit

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]


@contextlib.contextmanager
def window_of(url):
    with mock.patch.dict(os.environ, {'MEDIT_PORT': str(urlparse(url).port)}):
        yield


@contextlib.contextmanager
def medit_answering(status, body):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.do_GET()

        def do_GET(self):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()


class SelectAgainstTheFixtureInstance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.medit = contextlib.ExitStack()
        cls.url = cls.medit.enter_context(fixture_medit())

    @classmethod
    def tearDownClass(cls):
        cls.medit.close()

    def test_returns_each_row_the_select_selects_as_a_dict_of_its_columns(self):
        with window_of(self.url):
            rows = medit.select("SELECT form_key, editor_id FROM records WHERE editor_id LIKE '10mmFrom%' ORDER BY editor_id")
        self.assertEqual(rows, [
            {'form_key': '004822:Fallout4.esm', 'editor_id': '10mmFromA'},
            {'form_key': '004822:Fallout4.esm', 'editor_id': '10mmFromB'},
        ])

    def test_raises_the_reason_the_door_refuses_a_select(self):
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.select('SELECT * FROM information_schema.tables')
        self.assertIn('information_schema', str(raised.exception))

    def test_a_terminal_of_the_window_imports_medit_and_reaches_that_windows_medit(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            run = subprocess.run(
                [sys.executable, '-c', "import medit; print(len(medit.select('SELECT form_key FROM records')))"],
                cwd=elsewhere, capture_output=True, text=True,
                env={**os.environ, 'PYTHONPATH': str(SCRIPTS), 'MEDIT_PORT': str(urlparse(self.url).port)})
        self.assertEqual((run.returncode, run.stdout.strip()), (0, '9'), run.stderr)


class SelectWithoutAWindow(unittest.TestCase):
    def test_two_windows_never_cross_for_a_script_reaches_the_port_its_terminal_holds(self):
        with medit_answering(200, {'rows': [{'window': 'A'}]}) as a, medit_answering(200, {'rows': [{'window': 'B'}]}) as b:
            with window_of(a):
                self.assertEqual(medit.select('SELECT 1'), [{'window': 'A'}])
            with window_of(b):
                self.assertEqual(medit.select('SELECT 1'), [{'window': 'B'}])

    def test_raises_naming_the_terminal_when_the_terminal_holds_no_port(self):
        with mock.patch.dict(os.environ), self.assertRaises(medit.MEditError) as raised:
            os.environ.pop('MEDIT_PORT', None)
            medit.select('SELECT 1')
        self.assertIn('terminal', str(raised.exception))

    def test_raises_the_detail_of_a_problem_mEdit_answers(self):
        problem = {'status': 503, 'detail': "mEdit's index is not ready: still reading."}
        with medit_answering(503, problem) as url, window_of(url), self.assertRaises(medit.MEditError) as raised:
            medit.select('SELECT 1')
        self.assertEqual(str(raised.exception), "mEdit's index is not ready: still reading.")

    def test_raises_when_nothing_answers_on_the_port(self):
        with medit_answering(200, {}) as url:
            port = urlparse(url).port
        with mock.patch.dict(os.environ, {'MEDIT_PORT': str(port)}), self.assertRaises(medit.MEditError) as raised:
            medit.select('SELECT 1')
        self.assertIn(str(port), str(raised.exception))


if __name__ == '__main__':
    unittest.main()
