import unittest

import medit
from tests.fixture_medit import (
    CONDITIONS,
    CONFLICT_A,
    CONFLICT_B,
    CONFLICTED_RECORD,
    LIGHT,
    LIGHT_RECORD,
    RECIPE,
    fixture_medit,
    medit_answering,
    window_of,
)


class ReadAgainstTheFixtureInstance(unittest.TestCase):
    url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.url = cls.enterClassContext(fixture_medit()).url

    def test_reads_a_copy_whole_under_the_names_of_plugin_source(self) -> None:
        with window_of(self.url):
            recipe = medit.read(CONDITIONS.name, RECIPE)
        self.assertEqual(recipe['EditorID'], 'MBDevConditionedRecipe')
        self.assertEqual(recipe['Conditions'][0]['Data']['Function'], 'GetLevel')

    def test_reads_the_copy_of_the_plugin_named_with_its_origin(self) -> None:
        with window_of(self.url):
            a, b = (medit.read(plugin, CONFLICTED_RECORD) for plugin in (CONFLICT_A, CONFLICT_B))
        self.assertEqual((a['EditorID'], b['EditorID']), ('10mmFromA', '10mmFromB'))

    def test_compares_each_copy_of_a_record_with_the_master_in_load_order(self) -> None:
        with window_of(self.url):
            copies = medit.compare(['000800:MBDevConflictA.esp'])['000800:MBDevConflictA.esp']
        self.assertEqual(
            [(copy.plugin.name, copy.conflict_this) for copy in copies],
            [(CONFLICT_A.name, 'Master'), ('MBDevPatchAB.esp', 'Override')])

    def test_compares_a_record_within_a_plugin_and_its_masters(self) -> None:
        with window_of(self.url):
            within = medit.compare([CONFLICTED_RECORD], CONFLICT_A)[CONFLICTED_RECORD]
            everywhere = medit.compare([CONFLICTED_RECORD])[CONFLICTED_RECORD]
        self.assertIn(CONFLICT_B.name, [copy.plugin.name for copy in everywhere])
        self.assertEqual([copy.plugin.name for copy in within], [CONFLICT_A.name])

    def test_raises_for_a_plugin_that_holds_no_such_record(self) -> None:
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.read(LIGHT.name, '000801:MBDevLight.esl')
        self.assertIn('no such record', str(raised.exception))

    def test_reads_the_copy_a_row_names(self) -> None:
        with window_of(self.url):
            [row] = medit.select("SELECT form_key, plugin, origin FROM records WHERE editor_id = '10mmFromB'")
            recipe = medit.read((row['plugin'], row['origin']), row['form_key'])
        self.assertEqual(recipe['EditorID'], '10mmFromB')

    def test_raises_naming_a_record_given_as_a_plugin(self) -> None:
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.read('10mmFromB', CONFLICTED_RECORD)
        self.assertIn('10mmFromB is not a plugin', str(raised.exception))

    def test_finds_no_record_that_references_a_record_nothing_references(self) -> None:
        with window_of(self.url):
            self.assertEqual(medit.referenced_by(LIGHT_RECORD), [])


class ReferencesAnswered(unittest.TestCase):
    def test_names_each_referrer_by_the_index_names_with_its_plugin_and_origin(self) -> None:
        answer = [{
            'formKey': '000800:Mod.esp', 'plugin': 'Mod.esp', 'origin': 'Some Mod', 'fieldPath': 'Conditions[0].Data.ParameterOneRecord',
            'recordType': 'cobj', 'recordTypeName': 'Constructible Object', 'editorId': 'Recipe'}]
        with medit_answering(200, answer) as url, window_of(url):
            referrers = medit.referenced_by('000800:Other.esp')
        self.assertEqual(referrers, [medit.Referrer(
            medit.Plugin('Mod.esp', 'Some Mod'), '000800:Mod.esp', 'Conditions[0].Data.ParameterOneRecord', 'cobj', 'Recipe')])


if __name__ == '__main__':
    unittest.main()
