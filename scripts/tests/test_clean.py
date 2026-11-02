import itertools
import threading
import unittest
from collections.abc import Generator, Iterator
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
PERSISTENT = 0x400
INITIALLY_DISABLED = 0x800
FLAGS = 'MajorRecordFlagsRaw'


class Created:
    """A resend built before a plugin joined the list but sent after mEdit wrote it would be the snapshot the next read
    waits for, and would not name the plugin; the lock keeps a resend from straddling a creation."""

    def __init__(self) -> None:
        self.enabled: list[medit.Plugin] = []
        self.disabled: list[medit.Plugin] = []
        self.lock = threading.Lock()

    def create(self, name: str, origin: str, active: bool) -> medit.Plugin:
        with self.lock:
            plugin = medit.create_plugin(name, origin)
            (self.enabled if active else self.disabled).append(plugin)
            return plugin


def resend_with(fixture: Fixture, created: Created) -> None:
    with created.lock:
        send_load_order(fixture, created)


def send_load_order(fixture: Fixture, created: Created) -> None:
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
    names: Iterator[int]

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = cls.enterClassContext(fixture_medit())
        cls.created = Created()
        cls.names = itertools.count()
        init_source_mod(cls.fixture, PATCH.origin)
        init_source_mod(cls.fixture, CONDITIONS.origin)
        cls.enterClassContext(window_of(cls.fixture.url))
        cls.enterClassContext(watching(cls.fixture, cls.created))
        player_holder = cls.enabled('MBDevPlayerHolder.esp')
        cls.player = medit.create_record(player_holder, 'misc')
        medit.edit(player_holder, cls.player, 'set', 'EditorID', 'PlayerRef')

    @classmethod
    def enabled(cls, name: str | None = None) -> medit.Plugin:
        return cls.created.create(name or f'MBDevClean{next(cls.names)}.esp', CONDITIONS.origin, active=True)

    def keys_of(self, plugin: medit.Plugin) -> set[str]:
        return {row['form_key'] for row in medit.select(f"SELECT form_key FROM records WHERE plugin = '{plugin.name}'")}

    def cell_and_reference_in(self, plugin: medit.Plugin) -> tuple[str, str]:
        cell = medit.create_record(plugin, 'cell')
        return cell, medit.create_record(plugin, 'refr', container=cell)

    def deleted_override(self, base_set: bool = True, flags: int = DELETED) -> tuple[medit.Plugin, str]:
        master = self.enabled()
        _, reference = self.cell_and_reference_in(master)
        if base_set:
            medit.edit(master, reference, 'set', 'Base', ITEM_A)
        medit.edit(master, reference, 'set', 'Position', '1, 2, 3')
        medit.edit(master, reference, 'set', 'TeleportDestination.Door', ITEM_A)
        override = self.enabled()
        medit.copy(master, reference, override)
        medit.edit(override, reference, 'set', FLAGS, flags & PERSISTENT)
        medit.edit(override, reference, 'set', FLAGS, flags)
        return override, reference

    def test_removes_an_override_identical_to_the_record_it_overrides_and_keeps_the_others(self) -> None:
        medit.copy(CONFLICT_A, ITEM_A, PATCH, replace=True)
        before = self.keys_of(PATCH)
        cleaned = clean(PATCH)
        self.assertEqual(cleaned.identical_to_master, [ITEM_A])
        self.assertEqual(cleaned.undeleted_and_disabled, [])
        self.assertEqual(before - self.keys_of(PATCH), {ITEM_A})

    def test_removes_an_override_identical_to_the_master_though_a_plugin_loaded_between_them_changed_the_record(self) -> None:
        later = self.enabled()
        medit.copy(CONFLICT_A, ITEM_A, later)
        self.assertEqual(clean(later).identical_to_master, [ITEM_A])

    def test_keeps_an_override_identical_to_the_previous_override_but_not_to_the_master(self) -> None:
        later = self.enabled()
        medit.copy(PATCH, ITEM_A, later)
        self.assertEqual(clean(later).identical_to_master, [])
        self.assertIn(ITEM_A, self.keys_of(later))

    def test_removes_an_override_that_differs_from_the_master_only_in_its_version_stamp(self) -> None:
        later = self.enabled()
        medit.copy(CONFLICT_A, ITEM_A, later)
        medit.edit(later, ITEM_A, 'set', 'VersionControl', 123)
        self.assertEqual(clean(later).identical_to_master, [ITEM_A])

    def test_removes_a_cell_identical_to_its_master_once_its_references_are_removed(self) -> None:
        master = self.enabled()
        cell, reference = self.cell_and_reference_in(master)
        override = self.enabled()
        medit.copy(master, cell, override)
        medit.copy(master, reference, override)
        clean(override)
        self.assertEqual(self.keys_of(override) & {cell, reference}, set())

    def test_keeps_a_cell_identical_to_its_master_while_one_of_its_references_differs(self) -> None:
        master = self.enabled()
        cell, reference = self.cell_and_reference_in(master)
        override = self.enabled()
        medit.copy(master, cell, override)
        medit.copy(master, reference, override)
        medit.edit(override, reference, 'set', 'Scale', 2)
        clean(override)
        self.assertEqual(self.keys_of(override) & {cell, reference}, {cell, reference})

    def test_undeletes_disables_and_lowers_a_deleted_reference_keeping_x_and_y_and_enables_it_opposite_the_player(self) -> None:
        override, reference = self.deleted_override()
        self.assertEqual(clean(override).undeleted_and_disabled, [reference])
        record = medit.read(override, reference)
        self.assertEqual(
            [record[FLAGS], record['Position'], 'TeleportDestination' in record, record['EnableParent']['Reference'], record['EnableParent']['Flags']],
            [INITIALLY_DISABLED, '1, 2, -30000', False, self.player, ['SetEnableStateToOppositeOfParent']])

    def test_leaves_the_position_of_a_persistent_deleted_reference(self) -> None:
        override, reference = self.deleted_override(flags=DELETED | PERSISTENT)
        clean(override)
        self.assertEqual(medit.read(override, reference)['Position'], '1, 2, 3')

    def test_skips_a_deleted_reference_whose_master_holds_no_base_saying_so(self) -> None:
        override, reference = self.deleted_override(base_set=False)
        with self.assertLogs('clean') as logged:
            self.assertEqual(clean(override).undeleted_and_disabled, [])
        self.assertEqual(
            [logged.output[0], logged.output[1]],
            [f'INFO:clean:Skipping: {reference}', 'WARNING:clean:<Warning: Plugin contains 1 deleted references which can not be undeleted>'])
        self.assertEqual(medit.read(override, reference)[FLAGS], DELETED)

    def test_reads_the_base_of_the_master_in_the_load_order_not_of_a_plugin_of_the_same_name_that_is_not_active(self) -> None:
        master = self.enabled()
        _, reference = self.cell_and_reference_in(master)
        inactive = self.created.create(master.name, PATCH.origin, active=False)
        self.cell_and_reference_in(inactive)
        medit.edit(inactive, reference, 'set', 'Base', ITEM_A)
        override = self.enabled()
        medit.copy(master, reference, override)
        medit.edit(override, reference, 'set', FLAGS, DELETED)
        self.assertEqual(clean(override).undeleted_and_disabled, [])

    def test_warns_of_a_deleted_navmesh_and_leaves_it(self) -> None:
        plugin = self.enabled()
        cell, _ = self.cell_and_reference_in(plugin)
        navmesh = medit.create_record(plugin, 'navm', container=cell)
        medit.edit(plugin, navmesh, 'set', FLAGS, DELETED)
        with self.assertLogs('clean', 'WARNING') as logged:
            clean(plugin)
        self.assertEqual(logged.output, ['WARNING:clean:<Warning: Plugin contains 1 deleted NavMeshes which can not be undeleted>'])
        self.assertEqual(medit.read(plugin, navmesh)[FLAGS], DELETED)

    def test_refuses_a_plugin_that_is_not_active(self) -> None:
        inactive = self.created.create('MBDevCleanInactive.esp', CONDITIONS.origin, active=False)
        with self.assertRaisesRegex(medit.MEditError, 'is not active'):
            clean(inactive)

    def test_names_both_records_when_two_define_the_player_reference(self) -> None:
        second = self.enabled()
        duplicate = medit.create_record(second, 'misc')
        medit.edit(second, duplicate, 'set', 'EditorID', 'PlayerRef')
        self.addCleanup(medit.delete, second, duplicate)
        override, _ = self.deleted_override()
        with self.assertRaises(medit.MEditError) as raised:
            clean(override)
        self.assertIn(self.player, str(raised.exception))
        self.assertIn(duplicate, str(raised.exception))
