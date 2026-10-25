import json
import pathlib
import unittest

import medit
from tests.fixture_medit import (
    CONDITIONS,
    LIGHT,
    LIGHT_RECORD,
    RECIPE,
    RECIPE_FILE,
    Fixture,
    changed,
    decompile_and_commit_mod,
    file_stamps,
    fixture_medit,
    holding_unsaved,
    source_folder,
    window_of,
)


class EditAgainstTheFixtureInstance(unittest.TestCase):
    fixture: Fixture
    source: pathlib.Path
    recipe_file: pathlib.Path

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = cls.enterClassContext(fixture_medit())
        decompile_and_commit_mod(cls.fixture, CONDITIONS.origin)
        cls.source = source_folder(cls.fixture.instance, CONDITIONS.origin)
        [cls.recipe_file] = cls.source.rglob(RECIPE_FILE)

    def test_writes_an_edited_field_to_the_records_file_as_a_working_tree_change(self) -> None:
        with window_of(self.fixture.url):
            medit.edit(CONDITIONS.name, RECIPE, 'set', 'Conditions[0].ComparisonValue', 7.5)
        self.assertEqual(json.loads(self.recipe_file.read_text())['Conditions'][0]['ComparisonValue'], 7.5)
        self.assertEqual(changed(self.source), [f' M {self.recipe_file.relative_to(self.source).as_posix()}'])

    def test_raises_for_a_plugin_with_no_source_and_writes_nothing(self) -> None:
        light = self.fixture.instance / 'mods' / LIGHT.origin
        before = file_stamps(light)
        with window_of(self.fixture.url), self.assertRaises(medit.MEditError) as raised:
            medit.edit(LIGHT.name, LIGHT_RECORD, 'set', 'EditorID', 'Renamed')
        self.assertIn(f'{LIGHT.name} is not a compiled plugin', str(raised.exception))
        self.assertEqual(file_stamps(light), before)
        self.assertFalse(source_folder(self.fixture.instance, LIGHT.origin).exists())

    def test_raises_naming_a_file_held_unsaved_and_writes_nothing(self) -> None:
        saved = self.recipe_file.read_text()
        with (
                window_of(self.fixture.url), holding_unsaved(self.fixture, self.recipe_file),
                self.assertRaises(medit.MEditError) as raised):
            medit.edit(CONDITIONS.name, RECIPE, 'set', 'Conditions[0].ComparisonValue', 9.5)
        self.assertIn(str(self.recipe_file), str(raised.exception))
        self.assertEqual(self.recipe_file.read_text(), saved)

    def test_sends_no_value_when_given_no_value_so_a_set_without_one_is_refused(self) -> None:
        with window_of(self.fixture.url), self.assertRaises(medit.MEditError) as raised:
            medit.edit(CONDITIONS.name, RECIPE, 'set', 'Conditions[0].ComparisonValue')
        self.assertIn('set takes a value', str(raised.exception))

    def test_raises_naming_a_malformed_field_path_and_writes_nothing(self) -> None:
        saved = self.recipe_file.read_text()
        with window_of(self.fixture.url), self.assertRaises(medit.MEditError) as raised:
            medit.edit(CONDITIONS.name, RECIPE, 'set', 'Conditions[0]].ComparisonValue', 9.5)
        self.assertIn('Conditions[0]].ComparisonValue', str(raised.exception))
        self.assertEqual(self.recipe_file.read_text(), saved)


if __name__ == '__main__':
    unittest.main()
