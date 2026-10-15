import unittest

import medit
from tests.fixture_medit import CONFLICTED_RECORD, LIGHT, fixture_medit, window_of


class ResolveAgainstTheFixtureInstance(unittest.TestCase):
    url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.url = cls.enterClassContext(fixture_medit()).url

    def test_names_a_plugin_by_its_file_name_with_its_origin(self) -> None:
        with window_of(self.url):
            [light] = medit.resolve(LIGHT.name)
        self.assertEqual(light, LIGHT)

    def test_names_a_record_by_its_editor_id_or_form_key_and_several_names_in_one_call(self) -> None:
        with window_of(self.url):
            by_editor_id, by_form_key = medit.resolve('10mmFromA', CONFLICTED_RECORD)
        record = medit.RecordName(CONFLICTED_RECORD, '10mmFromA')
        self.assertEqual(by_editor_id, record)
        self.assertEqual(by_form_key, record)

    def test_picks_a_plugin_by_the_origin_given_with_its_name(self) -> None:
        with window_of(self.url):
            [light] = medit.resolve(LIGHT)
        self.assertEqual(light, LIGHT)

    def test_raises_for_a_plugin_that_is_not_in_the_origin_given(self) -> None:
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.resolve((LIGHT.name, 'NoSuchMod'))
        self.assertIn('NoSuchMod', str(raised.exception))

    def test_raises_naming_a_name_that_means_nothing(self) -> None:
        with window_of(self.url), self.assertRaises(medit.MEditError) as raised:
            medit.resolve(LIGHT.name, 'NoSuchThing')
        self.assertIn('NoSuchThing', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
