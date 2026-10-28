import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from urllib.parse import urlparse

import medit
from tests.fixture_medit import (
    CONFLICTED_RECORD,
    fixture_medit,
    medit_answering,
    window_of,
)

SCRIPTS = pathlib.Path(__file__).resolve().parents[1]


class SelectAgainstTheFixtureInstance(unittest.TestCase):
    url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.url = cls.enterClassContext(fixture_medit()).url

    def test_returns_each_row_the_select_selects_as_a_dict_of_its_columns(self) -> None:
        with window_of(self.url):
            rows = medit.select("SELECT form_key, editor_id FROM records WHERE editor_id LIKE '10mmFrom%' ORDER BY editor_id")
        self.assertEqual(rows, [
            {'form_key': CONFLICTED_RECORD, 'editor_id': '10mmFromA'},
            {'form_key': CONFLICTED_RECORD, 'editor_id': '10mmFromB'},
        ])

    def test_raises_the_reason_the_door_refuses_a_select(self) -> None:
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.select('SELECT * FROM information_schema.tables')
        self.assertIn('information_schema', str(raised.exception))

    def test_a_terminal_of_the_window_imports_medit_and_reaches_that_windows_medit(self) -> None:
        with window_of(self.url):
            records = len(medit.select('SELECT form_key FROM records'))
        self.assertGreater(records, 0)
        with tempfile.TemporaryDirectory() as elsewhere:
            run = subprocess.run(
                [sys.executable, '-c', "import medit; print(len(medit.select('SELECT form_key FROM records')))"],
                check=False, cwd=elsewhere, capture_output=True, text=True,
                env={**os.environ, 'PYTHONPATH': str(SCRIPTS), 'MEDIT_PORT': str(urlparse(self.url).port)})
        self.assertEqual((run.returncode, run.stdout.strip()), (0, str(records)), run.stderr)


class SelectWithoutAWindow(unittest.TestCase):
    def test_two_windows_never_cross_for_a_script_reaches_the_port_its_terminal_holds(self) -> None:
        with medit_answering(200, {'rows': [{'window': 'A'}]}) as a, medit_answering(200, {'rows': [{'window': 'B'}]}) as b:
            with window_of(a):
                self.assertEqual(medit.select('SELECT 1'), [{'window': 'A'}])
            with window_of(b):
                self.assertEqual(medit.select('SELECT 1'), [{'window': 'B'}])

    def _error_with_no_port(self) -> str:
        with mock.patch.dict(os.environ), self.assertRaises(medit.MEditError) as raised:
            os.environ.pop('MEDIT_PORT', None)
            medit.select('SELECT 1')
        return str(raised.exception)

    def test_raises_naming_a_terminal_when_the_launcher_holds_no_port(self) -> None:
        self.assertIn('terminal', self._error_with_no_port())

    def test_raises_naming_a_notebook_when_the_launcher_holds_no_port(self) -> None:
        self.assertIn('notebook', self._error_with_no_port())

    def test_raises_naming_a_debug_launch_when_the_launcher_holds_no_port(self) -> None:
        self.assertIn('Run and Debug', self._error_with_no_port())

    def test_raises_the_detail_of_a_problem_mEdit_answers(self) -> None:
        problem = {'status': 503, 'detail': "mEdit's record index is not ready: still reading."}
        with medit_answering(503, problem) as url, window_of(url), self.assertRaises(medit.MEditError) as raised:
            medit.select('SELECT 1')
        self.assertEqual(str(raised.exception), "mEdit's record index is not ready: still reading.")

    def test_raises_the_status_of_an_answer_that_is_not_a_problem(self) -> None:
        with medit_answering(502, b'<html>Bad Gateway</html>') as url, window_of(url), self.assertRaises(medit.MEditError) as raised:
            medit.select('SELECT 1')
        self.assertEqual(str(raised.exception), 'mEdit answered 502.')

    def test_raises_when_nothing_answers_on_the_port(self) -> None:
        with medit_answering(200, {}) as url:
            pass
        with window_of(url), self.assertRaises(medit.MEditError) as raised:
            medit.select('SELECT 1')
        self.assertIn(str(urlparse(url).port), str(raised.exception))


if __name__ == '__main__':
    unittest.main()
