import pathlib
import subprocess
import sys
import unittest
from unittest import mock
import urllib.error

from tests.fixture_medit import call, fixture_medit, stop

CHECKED_IN_INSTANCE = pathlib.Path(__file__).resolve().parents[2] / 'DevList'


def files_of(folder):
    return sorted(folder.rglob('*'))


class FixtureMEdit(unittest.TestCase):
    def test_medit_holds_the_fixture_instances_load_order_from_a_copy_of_it_and_stops_with_the_harness(self):
        checked_in = files_of(CHECKED_IN_INSTANCE)
        with fixture_medit() as url:
            plugins = call('GET', url + '/plugins')
        self.assertEqual([(plugin['name'], plugin['origin']) for plugin in plugins], [
            ('MBDevConflictB.esp', 'MB-DEV Conflict B'),
            ('MBDevConflictA.esp', 'MB-DEV Conflict A'),
            ('MBDevLight.esl', 'MB-DEV Light'),
            ('MBDevConditions.esp', 'MB-DEV Conditions'),
            ('MBDevMissingMaster.esp', 'MB-DEV Missing Master'),
        ])
        self.assertEqual(files_of(CHECKED_IN_INSTANCE), checked_in)
        with self.assertRaises(urllib.error.URLError):
            call('GET', url + '/health')


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


if __name__ == '__main__':
    unittest.main()
