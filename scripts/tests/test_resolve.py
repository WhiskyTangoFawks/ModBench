import contextlib
import unittest

import medit
from tests.fixture_medit import fixture_medit
from tests.test_select import window_of


class ResolveAgainstTheFixtureInstance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.medit = contextlib.ExitStack()
        cls.url = cls.medit.enter_context(fixture_medit())

    @classmethod
    def tearDownClass(cls):
        cls.medit.close()

    def test_names_a_plugin_by_its_file_name_with_its_origin(self):
        with window_of(self.url):
            [light] = medit.resolve('MBDevLight.esl')
        self.assertEqual(light, {'plugin': {'name': 'MBDevLight.esl', 'origin': 'MB-DEV Light'}, 'form_key': None, 'editor_id': None})

    def test_names_a_record_by_its_editor_id_or_form_key_and_several_names_in_one_call(self):
        with window_of(self.url):
            by_editor_id, by_form_key = medit.resolve('10mmFromA', '004822:Fallout4.esm')
        self.assertEqual(by_editor_id['form_key'], '004822:Fallout4.esm')
        self.assertEqual(by_form_key['form_key'], '004822:Fallout4.esm')
        self.assertIsNone(by_editor_id['plugin'])

    def test_picks_a_plugin_by_the_origin_given_with_its_name(self):
        with window_of(self.url):
            [light] = medit.resolve(('MBDevLight.esl', 'MB-DEV Light'))
        self.assertEqual(light['plugin']['origin'], 'MB-DEV Light')

    def test_raises_naming_a_name_that_means_nothing(self):
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.resolve('MBDevLight.esl', 'NoSuchThing')
        self.assertIn('NoSuchThing', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
