import contextlib
import subprocess
import unittest

import medit
from tests.fixture_medit import call, fixture_medit, source_folder, track
from tests.test_select import window_of

TRACKED = 'MB-DEV Conditions'
PLUGIN = 'MBDevConditions.esp'
RECIPE = '000800:MBDevConditions.esp'
LIGHT_RECORD = '000800:MBDevLight.esl'


def changed(folder):
    return subprocess.run(
        ['git', 'status', '--porcelain', '-z'], cwd=folder, capture_output=True, text=True, check=True).stdout.split('\0')[:-1]


class WriteAgainstTheFixtureInstance(unittest.TestCase):
    def setUp(self):
        self.medit = contextlib.ExitStack()
        self.addCleanup(self.medit.close)
        self.fixture = self.medit.enter_context(fixture_medit())
        track(self.fixture, TRACKED)
        self.source = source_folder(self.fixture.instance, TRACKED)
        self.medit.enter_context(window_of(self.fixture.url))

    def hold_unsaved(self, path):
        call('PUT', self.fixture.url + '/unsaved-documents', {'documents': [{'path': str(path), 'text': path.read_text() + ' '}]})

    def test_creates_a_record_in_the_plugins_source_and_returns_its_form_key(self):
        form_key = medit.create(PLUGIN, 'npc_')
        self.assertTrue(form_key.endswith(f':{PLUGIN}'))
        self.assertTrue(any(line.startswith('??') for line in changed(self.source)))

    def test_copies_a_record_as_new_into_the_plugins_source_and_returns_the_copys_form_key(self):
        form_key = medit.copy('MBDevLight.esl', LIGHT_RECORD, PLUGIN, mode='new')
        self.assertTrue(form_key.endswith(f':{PLUGIN}'))
        self.assertTrue(any(line.startswith('??') for line in changed(self.source)))

    def test_copies_a_record_as_an_override_under_its_own_form_key(self):
        form_key = medit.copy('MBDevLight.esl', LIGHT_RECORD, PLUGIN)
        self.assertEqual(form_key, LIGHT_RECORD)
        self.assertTrue(any(line.startswith('??') for line in changed(self.source)))

    def test_deletes_a_record_from_the_plugins_source(self):
        [recipe_file] = self.source.rglob('MBDevConditionedRecipe - *.json')
        medit.delete(PLUGIN, RECIPE)
        self.assertFalse(recipe_file.exists())
        self.assertIn(f' D {recipe_file.relative_to(self.source).as_posix()}', changed(self.source))

    def test_a_select_after_an_edit_returns_the_edited_row(self):
        medit.edit(PLUGIN, RECIPE, 'set', 'EditorID', 'MBDevEditedRecipe')
        self.assertEqual(
            medit.select(f"SELECT editor_id FROM records WHERE form_key = '{RECIPE}' AND plugin = '{PLUGIN}'"),
            [{'editor_id': 'MBDevEditedRecipe'}])

    def test_a_select_after_a_create_returns_the_created_row(self):
        form_key = medit.create(PLUGIN, 'npc_')
        self.assertEqual(
            medit.select(f"SELECT plugin FROM records WHERE form_key = '{form_key}'"), [{'plugin': PLUGIN}])

    def test_a_select_after_a_delete_returns_no_row(self):
        medit.delete(PLUGIN, RECIPE)
        self.assertEqual(medit.select(f"SELECT form_key FROM records WHERE form_key = '{RECIPE}' AND plugin = '{PLUGIN}'"), [])

    def test_raises_for_a_delete_of_a_file_held_unsaved_and_deletes_nothing(self):
        [recipe_file] = self.source.rglob('MBDevConditionedRecipe - *.json')
        self.hold_unsaved(recipe_file)
        with self.assertRaises(medit.MEditError) as raised:
            medit.delete(PLUGIN, RECIPE)
        self.assertIn(str(recipe_file), str(raised.exception))
        self.assertTrue(recipe_file.exists())

    def test_raises_for_a_copy_into_a_plugin_with_no_source_and_writes_nothing(self):
        with self.assertRaises(medit.MEditError) as raised:
            medit.copy(PLUGIN, RECIPE, 'MBDevLight.esl', mode='new')
        self.assertIn('MBDevLight.esl is not tracked', str(raised.exception))
        self.assertEqual(changed(self.source), [])

    def test_raises_for_a_create_of_a_record_type_that_does_not_exist_and_writes_nothing(self):
        with self.assertRaises(medit.MEditError):
            medit.create(PLUGIN, 'nothing')
        self.assertEqual(changed(self.source), [])


if __name__ == '__main__':
    unittest.main()
