import json
import pathlib
import unittest
import urllib.error
import urllib.request

from tests.fixture_medit import fixture_medit

CHECKED_IN_INSTANCE = pathlib.Path(__file__).resolve().parents[2] / 'DevList'


def get(url, path):
    with urllib.request.urlopen(url + path, timeout=10) as response:
        return json.load(response)


def files_of(folder):
    return sorted(folder.rglob('*'))


class FixtureMEdit(unittest.TestCase):
    def test_medit_holds_the_fixture_instances_load_order_from_a_copy_of_it(self):
        checked_in = files_of(CHECKED_IN_INSTANCE)
        with fixture_medit() as url:
            plugins = get(url, '/plugins')
        self.assertEqual([(plugin['name'], plugin['origin']) for plugin in plugins], [
            ('MBDevConflictB.esp', 'MB-DEV Conflict B'),
            ('MBDevConflictA.esp', 'MB-DEV Conflict A'),
            ('MBDevLight.esl', 'MB-DEV Light'),
            ('MBDevConditions.esp', 'MB-DEV Conditions'),
            ('MBDevMissingMaster.esp', 'MB-DEV Missing Master'),
        ])
        self.assertEqual(files_of(CHECKED_IN_INSTANCE), checked_in)

    def test_medit_stops_with_the_harness(self):
        with fixture_medit() as url:
            pass
        with self.assertRaises(urllib.error.URLError):
            get(url, '/health')


if __name__ == '__main__':
    unittest.main()
