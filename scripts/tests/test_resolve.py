import contextlib
import unittest

import medit
from tests.fixture_medit import fixture_medit
from tests.test_select import window_of


class ResolveAgainstTheFixtureInstance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.medit = contextlib.ExitStack()
        cls.url = cls.medit.enter_context(fixture_medit()).url

    @classmethod
    def tearDownClass(cls):
        cls.medit.close()

    def test_names_a_plugin_by_its_file_name_with_its_origin(self):
        with window_of(self.url):
            [light] = medit.resolve('MBDevLight.esl')
        self.assertEqual(light, medit.Plugin('MBDevLight.esl', 'MB-DEV Light'))

    def test_names_a_record_by_its_editor_id_or_form_key_and_several_names_in_one_call(self):
        with window_of(self.url):
            by_editor_id, by_form_key = medit.resolve('10mmFromA', '004822:Fallout4.esm')
        record = medit.RecordName('004822:Fallout4.esm', '10mmFromA')
        self.assertEqual(by_editor_id, record)
        self.assertEqual(by_form_key, record)

    def test_picks_a_plugin_by_the_origin_given_with_its_name(self):
        with window_of(self.url):
            [light] = medit.resolve(('MBDevLight.esl', 'MB-DEV Light'))
        self.assertEqual(light.origin, 'MB-DEV Light')

    def test_raises_for_a_plugin_that_is_not_in_the_origin_given(self):
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.resolve(('MBDevLight.esl', 'NoSuchMod'))
        self.assertIn('NoSuchMod', str(raised.exception))

    def test_raises_naming_a_name_that_means_nothing(self):
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.resolve('MBDevLight.esl', 'NoSuchThing')
        self.assertIn('NoSuchThing', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
