import pathlib
import threading
import unittest

import medit
from tests.fixture_medit import (
    CONDITIONS,
    EMPTY_MOD,
    LIGHT,
    LIGHT_RECORD,
    OVERWRITE,
    RECIPE,
    RECIPE_FILE,
    changed,
    fixture_medit,
    holding_unsaved,
    source_folder,
    init_mod,
    watcher_resends_load_order,
    window_of,
)

NEW_PLUGIN = 'MBDevNew.esp'


class WriteAgainstTheFixtureInstance(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = self.enterContext(fixture_medit())
        init_mod(self.fixture, CONDITIONS.origin)
        self.source = source_folder(self.fixture.instance, CONDITIONS.origin)
        self.enterContext(window_of(self.fixture.url))

    def recipe_file(self) -> pathlib.Path:
        [recipe_file] = self.source.rglob(RECIPE_FILE)
        return recipe_file

    def select_after_the_watcher(self, sql: str) -> list[medit.JsonRecord]:
        watcher_resends_load_order(self.fixture)
        return medit.select(sql)

    def test_creates_a_record_in_the_plugins_source_and_returns_its_form_key(self) -> None:
        form_key = medit.create_record(CONDITIONS.name, 'npc_')
        self.assertTrue(form_key.endswith(f':{CONDITIONS.name}'))
        self.assertTrue(any(line.startswith('??') for line in changed(self.source)))

    def test_copies_a_record_as_new_into_the_plugins_source_and_returns_the_copys_form_key(self) -> None:
        form_key = medit.copy(LIGHT.name, LIGHT_RECORD, CONDITIONS.name, mode='new')
        self.assertTrue(form_key.endswith(f':{CONDITIONS.name}'))
        self.assertTrue(any(line.startswith('??') for line in changed(self.source)))

    def test_copies_a_record_as_an_override_under_its_own_form_key(self) -> None:
        form_key = medit.copy(LIGHT.name, LIGHT_RECORD, CONDITIONS.name)
        self.assertEqual(form_key, LIGHT_RECORD)
        self.assertTrue(any(line.startswith('??') for line in changed(self.source)))

    def test_deletes_a_record_from_the_plugins_source(self) -> None:
        recipe_file = self.recipe_file()
        medit.delete(CONDITIONS.name, RECIPE)
        self.assertFalse(recipe_file.exists())
        self.assertIn(f' D {recipe_file.relative_to(self.source).as_posix()}', changed(self.source))

    def test_a_select_after_an_edit_returns_the_edited_row(self) -> None:
        medit.edit(CONDITIONS.name, RECIPE, 'set', 'EditorID', 'MBDevEditedRecipe')
        self.assertEqual(
            self.select_after_the_watcher(
                f"SELECT editor_id FROM records WHERE form_key = '{RECIPE}' AND plugin = '{CONDITIONS.name}'"),
            [{'editor_id': 'MBDevEditedRecipe'}])

    def test_a_select_after_a_create_returns_the_created_row(self) -> None:
        form_key = medit.create_record(CONDITIONS.name, 'npc_')
        self.assertEqual(
            self.select_after_the_watcher(f"SELECT plugin FROM records WHERE form_key = '{form_key}'"),
            [{'plugin': CONDITIONS.name}])

    def test_a_select_after_a_copy_returns_the_copied_row(self) -> None:
        form_key = medit.copy(LIGHT.name, LIGHT_RECORD, CONDITIONS.name, mode='new')
        self.assertEqual(
            self.select_after_the_watcher(f"SELECT plugin FROM records WHERE form_key = '{form_key}'"),
            [{'plugin': CONDITIONS.name}])

    def test_a_select_after_a_delete_returns_no_row(self) -> None:
        medit.delete(CONDITIONS.name, RECIPE)
        self.assertEqual(
            self.select_after_the_watcher(
                f"SELECT form_key FROM records WHERE form_key = '{RECIPE}' AND plugin = '{CONDITIONS.name}'"),
            [])

    def test_raises_for_a_delete_of_a_file_held_unsaved_and_deletes_nothing(self) -> None:
        recipe_file = self.recipe_file()
        with holding_unsaved(self.fixture, recipe_file), self.assertRaises(medit.MEditError) as raised:
            medit.delete(CONDITIONS.name, RECIPE)
        self.assertIn(str(recipe_file), str(raised.exception))
        self.assertTrue(recipe_file.exists())

    def test_raises_for_a_copy_into_a_plugin_with_no_source_and_writes_nothing(self) -> None:
        with self.assertRaises(medit.MEditError) as raised:
            medit.copy(CONDITIONS.name, RECIPE, LIGHT.name, mode='new')
        self.assertIn(f'{LIGHT.name} is not a compiled plugin', str(raised.exception))
        self.assertEqual(changed(self.source), [])

    def test_creates_a_plugin_in_a_mod_with_its_source(self) -> None:
        medit.create_plugin(NEW_PLUGIN, CONDITIONS.origin)
        self.assertTrue((self.fixture.instance / 'mods' / CONDITIONS.origin / NEW_PLUGIN).exists())
        self.assertTrue(any('MBDevNew' in line for line in changed(self.source)))

    def test_a_write_into_the_created_plugin_lands_once_the_watchers_snapshot_holds_it(self) -> None:
        created = medit.create_plugin(NEW_PLUGIN, CONDITIONS.origin)
        watcher_resends_load_order(self.fixture, created)
        self.assertTrue(medit.create_record(created, 'npc_').endswith(f':{NEW_PLUGIN}'))

    def test_a_write_into_the_created_plugin_waits_for_the_watchers_snapshot_that_holds_it(self) -> None:
        created = medit.create_plugin(NEW_PLUGIN, CONDITIONS.origin)
        watcher = threading.Timer(1, watcher_resends_load_order, [self.fixture, created])
        watcher.start()
        self.addCleanup(watcher.join)
        self.assertTrue(medit.create_record(created, 'npc_').endswith(f':{NEW_PLUGIN}'))

    def test_creates_a_plugin_in_a_mod_that_holds_no_plugin(self) -> None:
        medit.create_plugin(NEW_PLUGIN, EMPTY_MOD)
        self.assertTrue((self.fixture.instance / 'mods' / EMPTY_MOD / NEW_PLUGIN).exists())

    def test_creates_a_plugin_in_overwrite_with_no_source(self) -> None:
        medit.create_plugin(NEW_PLUGIN, OVERWRITE)
        self.assertTrue((self.fixture.instance / 'overwrite' / NEW_PLUGIN).exists())
        self.assertEqual(changed(self.source), [])

    def test_raises_for_a_create_of_a_plugin_in_a_place_the_load_order_does_not_offer_and_writes_nothing(self) -> None:
        with self.assertRaises(medit.MEditError) as raised:
            medit.create_plugin(NEW_PLUGIN, 'No Such Mod')
        self.assertIn('No Such Mod', str(raised.exception))
        self.assertEqual(changed(self.source), [])

    def test_raises_for_a_create_of_a_plugin_the_mod_already_holds(self) -> None:
        with self.assertRaises(medit.MEditError):
            medit.create_plugin(CONDITIONS.name, CONDITIONS.origin)

    def test_raises_for_a_create_of_a_record_type_that_does_not_exist_and_writes_nothing(self) -> None:
        with self.assertRaises(medit.MEditError):
            medit.create_record(CONDITIONS.name, 'nothing')
        self.assertEqual(changed(self.source), [])


if __name__ == '__main__':
    unittest.main()
