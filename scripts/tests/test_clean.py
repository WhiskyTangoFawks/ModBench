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


class Created:
    def __init__(self) -> None:
        self.enabled: list[medit.Plugin] = []
        self.disabled: list[medit.Plugin] = []


def resend_with(fixture: Fixture, created: Created) -> None:
    enabled = [plugin_entry(fixture.instance, plugin, len(PLUGINS) + at) for at, plugin in enumerate(created.enabled)]
    disabled = [plugin_entry(fixture.instance, plugin, None) for plugin in created.disabled]
    call('PUT', fixture.url + '/load-order', {
        **fixture.load_order, 'plugins': fixture.load_order['plugins'] + enabled + disabled,
        'active': fixture.load_order['active'] + [plugin._asdict() for plugin in created.enabled]})


@contextmanager
def watching(fixture: Fixture, created: Created) -> Generator[None]:
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
    created: Created

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = cls.enterClassContext(fixture_medit())
        cls.created = Created()
        init_source_mod(cls.fixture, PATCH.origin)
        init_source_mod(cls.fixture, CONDITIONS.origin)
        cls.enterClassContext(window_of(cls.fixture.url))
        cls.enterClassContext(watching(cls.fixture, cls.created))

    def keys_of(self, plugin: medit.Plugin) -> set[str]:
        return {row['form_key'] for row in medit.select(f"SELECT form_key FROM records WHERE plugin = '{plugin.name}'")}

    def test_removes_an_override_identical_to_the_record_it_overrides_and_keeps_the_others(self) -> None:
        medit.copy(CONFLICT_A, ITEM_A, PATCH, replace=True)
        before = self.keys_of(PATCH)
        cleaned = clean(PATCH)
        self.assertEqual(cleaned.identical_to_master, [ITEM_A])
        self.assertEqual(cleaned.undeleted_and_disabled, [])
        self.assertEqual(before - self.keys_of(PATCH), {ITEM_A})

    def test_undeletes_and_disables_a_deleted_reference(self) -> None:
        created = medit.create_plugin('MBDevCleanEnabled.esp', CONDITIONS.origin)
        self.created.enabled.append(created)
        cell = medit.create_record(created, 'cell')
        reference = medit.create_record(created, 'refr', container=cell)
        medit.edit(created, reference, 'set', 'MajorRecordFlagsRaw', DELETED)
        cleaned = clean(created)
        self.assertEqual(cleaned.undeleted_and_disabled, [reference])
        self.assertEqual(medit.read(created, reference)['MajorRecordFlagsRaw'], INITIALLY_DISABLED)

    def test_refuses_a_plugin_outside_the_load_order_rather_than_cleaning_part_of_it(self) -> None:
        created = medit.create_plugin('MBDevCleanDisabled.esp', CONDITIONS.origin)
        self.created.disabled.append(created)
        with self.assertRaisesRegex(medit.MEditError, 'no place in the load order'):
            clean(created)
