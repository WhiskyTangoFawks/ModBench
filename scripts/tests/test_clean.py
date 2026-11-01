import threading
import unittest
from collections.abc import Generator
from contextlib import contextmanager

import medit
from default.clean import clean
from tests.fixture_medit import (
    CONDITIONS,
    CONFLICT_A,
    PLUGINS,
    Fixture,
    call,
    fixture_medit,
    init_source_mod,
    plugin_entry,
    window_of,
)

PATCH = medit.Plugin('MBDevPatchAB.esp', 'MB-DEV Patch A+B')
ITEM_A = '000800:MBDevConflictA.esp'
WATCH_INTERVAL_S = 0.25
DELETED = 0x20
INITIALLY_DISABLED = 0x800


def resend_with(fixture: Fixture, created: list[medit.Plugin]) -> None:
    enabled = [plugin_entry(fixture.instance, plugin, len(PLUGINS) + at) for at, plugin in enumerate(created)]
    call('PUT', fixture.url + '/load-order', {
        **fixture.load_order, 'plugins': fixture.load_order['plugins'] + enabled,
        'active': fixture.load_order['active'] + [plugin._asdict() for plugin in created]})


@contextmanager
def watching(fixture: Fixture, created: list[medit.Plugin]) -> Generator[None]:
    stopped = threading.Event()

    def resend() -> None:
        while not stopped.wait(WATCH_INTERVAL_S):
            resend_with(fixture, created)

    watcher = threading.Thread(target=resend, daemon=True)
    watcher.start()
    try:
        yield
    finally:
        stopped.set()
        watcher.join()


class CleanAgainstTheFixtureInstance(unittest.TestCase):
    fixture: Fixture
    created: list[medit.Plugin]

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = cls.enterClassContext(fixture_medit())
        cls.created = []
        init_source_mod(cls.fixture, PATCH.origin)
        init_source_mod(cls.fixture, CONDITIONS.origin)
        cls.enterClassContext(window_of(cls.fixture.url))
        cls.enterClassContext(watching(cls.fixture, cls.created))

    def keys_of(self, plugin: medit.Plugin) -> set[str]:
        return {row['form_key'] for row in medit.select(f"SELECT form_key FROM records WHERE plugin = '{plugin.name}'")}

    def enabled(self, name: str) -> medit.Plugin:
        plugin = medit.create_plugin(name, CONDITIONS.origin)
        self.created.append(plugin)
        return plugin

    def test_removes_an_override_identical_to_the_record_it_overrides_and_keeps_the_others(self) -> None:
        medit.copy(CONFLICT_A, ITEM_A, PATCH, replace=True)
        before = self.keys_of(PATCH)
        cleaned = clean(PATCH)
        self.assertEqual(cleaned.identical_to_master, [ITEM_A])
        self.assertEqual(cleaned.undeleted_and_disabled, [])
        self.assertEqual(before - self.keys_of(PATCH), {ITEM_A})

    def test_removes_an_override_identical_to_the_master_though_a_plugin_loaded_between_them_changed_the_record(self) -> None:
        later = self.enabled('MBDevCleanAfterPatch.esp')
        medit.copy(CONFLICT_A, ITEM_A, later)
        cleaned = clean(later)
        self.assertEqual(cleaned.identical_to_master, [ITEM_A])

    def test_keeps_an_override_identical_to_the_previous_override_but_not_to_the_master(self) -> None:
        later = self.enabled('MBDevCleanCopiesPatch.esp')
        medit.copy(PATCH, ITEM_A, later)
        cleaned = clean(later)
        self.assertEqual(cleaned.identical_to_master, [])
        self.assertIn(ITEM_A, self.keys_of(later))

    def test_undeletes_disables_and_moves_underground_a_deleted_reference_and_enables_it_opposite_the_player(self) -> None:
        base = self.enabled('MBDevCleanBase.esp')
        player = medit.create_record(base, 'misc')
        medit.edit(base, player, 'set', 'EditorID', 'PlayerRef')
        cell = medit.create_record(base, 'cell')
        reference = medit.create_record(base, 'refr', container=cell)
        medit.edit(base, reference, 'set', 'Base', ITEM_A)
        cleaned_plugin = self.enabled('MBDevCleanDeleted.esp')
        medit.copy(base, reference, cleaned_plugin)
        medit.edit(cleaned_plugin, reference, 'set', 'MajorRecordFlagsRaw', DELETED)
        cleaned = clean(cleaned_plugin)
        self.assertEqual(cleaned.undeleted_and_disabled, [reference])
        record = medit.read(cleaned_plugin, reference)
        self.assertEqual(
            [record['MajorRecordFlagsRaw'], record['Position'], record['EnableParent']['Reference'], record['EnableParent']['Flags']],
            [INITIALLY_DISABLED, '0, 0, -30000', player, ['SetEnableStateToOppositeOfParent']])

    def test_leaves_a_deleted_reference_its_master_holds_no_base_for(self) -> None:
        own = self.enabled('MBDevCleanOwnDeleted.esp')
        cell = medit.create_record(own, 'cell')
        reference = medit.create_record(own, 'refr', container=cell)
        medit.edit(own, reference, 'set', 'MajorRecordFlagsRaw', DELETED)
        self.assertEqual(clean(own).undeleted_and_disabled, [])
        self.assertEqual(medit.read(own, reference)['MajorRecordFlagsRaw'], DELETED)
