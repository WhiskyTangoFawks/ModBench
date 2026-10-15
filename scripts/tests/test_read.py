import contextlib
import unittest

import medit
from tests.fixture_medit import fixture_medit
from tests.test_select import medit_answering, window_of


class ReadAgainstTheFixtureInstance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.medit = contextlib.ExitStack()
        cls.url = cls.medit.enter_context(fixture_medit()).url

    @classmethod
    def tearDownClass(cls):
        cls.medit.close()

    def test_reads_a_copy_whole_under_the_names_of_plugin_source(self):
        with window_of(self.url):
            recipe = medit.read('MBDevConditions.esp', '000800:MBDevConditions.esp')
        self.assertEqual(recipe['EditorID'], 'MBDevConditionedRecipe')
        self.assertEqual(recipe['Conditions'][0]['Data']['Function'], 'GetLevel')

    def test_reads_the_copy_of_the_plugin_named_with_its_origin(self):
        with window_of(self.url):
            a, b = (medit.read(plugin, '004822:Fallout4.esm') for plugin in (
                ('MBDevConflictA.esp', 'MB-DEV Conflict A'), ('MBDevConflictB.esp', 'MB-DEV Conflict B')))
        self.assertEqual((a['EditorID'], b['EditorID']), ('10mmFromA', '10mmFromB'))

    def test_raises_for_a_plugin_that_holds_no_such_record(self):
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.read('MBDevLight.esl', '000801:MBDevLight.esl')
        self.assertIn('no such record', str(raised.exception))

    def test_reads_the_copy_a_row_names(self):
        with window_of(self.url):
            [row] = medit.select("SELECT form_key, plugin, origin FROM records WHERE editor_id = '10mmFromB'")
            recipe = medit.read((row['plugin'], row['origin']), row['form_key'])
        self.assertEqual(recipe['EditorID'], '10mmFromB')

    def test_raises_naming_a_record_given_as_a_plugin(self):
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.read('10mmFromA', '004822:Fallout4.esm')
        self.assertIn("10mmFromA is not a plugin", str(raised.exception))

    def test_finds_no_record_that_references_a_record_nothing_references(self):
        with window_of(self.url):
            self.assertEqual(medit.referenced_by('000800:MBDevLight.esl'), [])


class ReferencesAnswered(unittest.TestCase):
    def test_names_each_referrer_by_the_index_names_with_its_plugin_and_origin(self):
        answer = [{
            'formKey': '000800:Mod.esp', 'plugin': 'Mod.esp', 'origin': 'Some Mod', 'fieldPath': 'Conditions[0].Data.ParameterOneRecord',
            'recordType': 'cobj', 'recordTypeName': 'Constructible Object', 'editorId': 'Recipe'}]
        with medit_answering(200, answer) as url, window_of(url):
            referrers = medit.referenced_by('000800:Other.esp')
        self.assertEqual(referrers, [medit.Referrer(
            medit.Plugin('Mod.esp', 'Some Mod'), '000800:Mod.esp', 'Conditions[0].Data.ParameterOneRecord', 'cobj', 'Recipe')])


if __name__ == '__main__':
    unittest.main()
