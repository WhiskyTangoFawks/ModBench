import contextlib
import json
import subprocess
import unittest

import medit
from tests.fixture_medit import call, fixture_medit, source_folder, track
from tests.test_select import window_of

TRACKED = 'MB-DEV Conditions'
RECIPE = '000800:MBDevConditions.esp'


def files_and_bytes(folder):
    return sorted((str(path), path.read_bytes()) for path in folder.rglob('*') if path.is_file())


class EditAgainstTheFixtureInstance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.medit = contextlib.ExitStack()
        cls.fixture = cls.medit.enter_context(fixture_medit())
        track(cls.fixture, TRACKED)
        cls.source = source_folder(cls.fixture.instance, TRACKED)
        [cls.recipe_file] = cls.source.rglob('MBDevConditionedRecipe - *.json')

    @classmethod
    def tearDownClass(cls):
        cls.medit.close()

    def test_writes_an_edited_field_to_the_records_file_as_a_working_tree_change(self):
        with window_of(self.fixture.url):
            medit.edit('MBDevConditions.esp', RECIPE, 'set', 'Conditions[0].ComparisonValue', 7.5)
        self.assertEqual(json.loads(self.recipe_file.read_text())['Conditions'][0]['ComparisonValue'], 7.5)
        changed = subprocess.run(
            ['git', 'status', '--porcelain', '-z'], cwd=self.source, capture_output=True, text=True, check=True).stdout
        self.assertEqual(changed, f' M {self.recipe_file.relative_to(self.source).as_posix()}\0')

    def test_raises_for_a_plugin_with_no_source_and_writes_nothing(self):
        light = self.fixture.instance / 'mods' / 'MB-DEV Light'
        before = files_and_bytes(light)
        with window_of(self.fixture.url), self.assertRaises(medit.MEditError) as raised:
            medit.edit('MBDevLight.esl', '000800:MBDevLight.esl', 'set', 'EditorID', 'Renamed')
        self.assertIn('MBDevLight.esl is not tracked', str(raised.exception))
        self.assertEqual(files_and_bytes(light), before)
        self.assertFalse(source_folder(self.fixture.instance, 'MB-DEV Light').exists())

    def test_raises_naming_a_file_held_unsaved_and_writes_nothing(self):
        saved = self.recipe_file.read_text()
        self.hold_unsaved(self.recipe_file, saved + ' ')
        with window_of(self.fixture.url), self.assertRaises(medit.MEditError) as raised:
            medit.edit('MBDevConditions.esp', RECIPE, 'set', 'Conditions[0].ComparisonValue', 9.5)
        self.assertIn(str(self.recipe_file), str(raised.exception))
        self.assertEqual(self.recipe_file.read_text(), saved)

    def hold_unsaved(self, path, text):
        call('PUT', self.fixture.url + '/unsaved-documents', {'documents': [{'path': str(path), 'text': text}]})
        self.addCleanup(call, 'PUT', self.fixture.url + '/unsaved-documents', {'documents': []})


if __name__ == '__main__':
    unittest.main()
