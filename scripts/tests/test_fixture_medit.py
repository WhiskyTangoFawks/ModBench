import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
from unittest import mock

from tests.fixture_medit import (
    INSTANCE,
    call,
    changed,
    copy_checked_in,
    fixture_medit,
    hand_load_order,
    medit_answering,
    stop,
)

READY = {'version': 1, 'state': 'Ready'}


class FixtureMEdit(unittest.TestCase):
    def test_medit_holds_the_fixture_instances_load_order_from_a_copy_of_it_and_stops_with_the_harness(self) -> None:
        checked_in = changed(INSTANCE)
        with fixture_medit() as fixture:
            plugins = call('GET', fixture.url + '/plugins')
        self.assertEqual([(plugin['name'], plugin['origin']) for plugin in plugins], [
            ('MBDevFixes.esm', 'MB-DEV Fixes'),
            ('MBDevFixesAddon.esp', 'MB-DEV Fixes Addon'),
            ('MBDevConflictA.esp', 'MB-DEV Conflict A'),
            ('MBDevConflictB.esp', 'MB-DEV Conflict B'),
            ('MBDevLight.esl', 'MB-DEV Light'),
            ('MBDevConditions.esp', 'MB-DEV Conditions'),
            ('MBDevMissingMaster.esp', 'MB-DEV Missing Master'),
            ('MBDevPatchAB.esp', 'MB-DEV Patch A+B'),
        ])
        self.assertEqual(changed(INSTANCE), checked_in)
        with self.assertRaises(urllib.error.URLError):
            call('GET', fixture.url + '/health')


class CopyCheckedIn(unittest.TestCase):
    def test_copies_the_files_git_tracks_and_none_it_ignores_or_has_not_been_told_of(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source, destination = pathlib.Path(temporary) / 'source', pathlib.Path(temporary) / 'copy'
            (source / 'mods' / 'A').mkdir(parents=True)
            (source / 'mods' / 'A' / 'A.esp').write_bytes(b'TES4')
            (source / '.gitignore').write_text('/modbench/\n')
            subprocess.run(['git', 'init', '-q'], cwd=source, check=True)
            subprocess.run(['git', 'add', '.'], cwd=source, check=True)
            (source / 'modbench').mkdir()
            (source / 'modbench' / 'index.duckdb').write_bytes(b'derived')
            (source / 'loadorder.txt').write_text('left by a run')

            copy_checked_in(source, destination)

            self.assertEqual(
                sorted(path.relative_to(destination).as_posix() for path in destination.rglob('*') if path.is_file()),
                ['.gitignore', 'mods/A/A.esp'])


class Stop(unittest.TestCase):
    def test_a_process_that_ignores_terminate_is_killed_after_the_grace(self) -> None:
        with subprocess.Popen(
                [sys.executable, '-c', 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(1,flush=True);time.sleep(60)'],
                stdout=subprocess.PIPE) as ignoring:
            assert ignoring.stdout is not None
            ignoring.stdout.readline()
            with mock.patch('tests.fixture_medit.STOP_GRACE_S', 0.2):
                stop(ignoring)
            self.assertIsNotNone(ignoring.poll())


class HandLoadOrder(unittest.TestCase):
    def test_a_put_slower_than_one_request_is_waited_for_within_the_load_order_deadline(self) -> None:
        with medit_answering(200, READY, put_delay_s=0.6) as url, mock.patch('tests.fixture_medit.REQUEST_TIMEOUT_S', 0.2):
            hand_load_order(url, {})

    def test_a_put_that_outlasts_the_load_order_deadline_fails(self) -> None:
        with medit_answering(200, READY, put_delay_s=2) as url, mock.patch('tests.fixture_medit.LOAD_ORDER_TIMEOUT_S', 0.3):
            started = time.monotonic()
            with self.assertRaises(OSError):
                hand_load_order(url, {})
            self.assertLess(time.monotonic() - started, 1)


if __name__ == '__main__':
    unittest.main()
