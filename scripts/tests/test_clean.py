import contextlib
import copy
import io
import json
import sqlite3
import unittest
from collections.abc import Generator
from unittest import mock

import medit
from default.clean import Cleaned, clean

MASTER = medit.Plugin('Master.esm', 'Master Mod')
PATCH = medit.Plugin('Patch.esp', 'Patch Mod')
CELL = '000800:Master.esm'
REFERENCE = '000801:Master.esm'
ITEM = '000802:Master.esm'
OTHER = medit.Plugin('Other.esp', 'Other Mod')
DELETED = 0x20
PERSISTENT = 0x400
INITIALLY_DISABLED = 0x800
FLAGS = 'MajorRecordFlagsRaw'
TELEPORT = 'TeleportDestination'
ENABLE_PARENT = 'EnableParent'
IDENTICAL_TO_MASTER = 'IdenticalToMaster'
OVERRIDE = 'Override'


class FakeIndex:
    """mEdit's record index as clean reads and writes it through medit: each copy with its document and the state
    mEdit judges it in against its master, the plugins active, and the copies each holds."""

    def __init__(self, *active: medit.Plugin) -> None:
        self.active = set(active)
        self.documents: dict[tuple[medit.Plugin, str], tuple[str, medit.JsonRecord]] = {}
        self.parents: dict[tuple[medit.Plugin, str], str] = {}
        self.states: dict[tuple[medit.Plugin, str], str] = {}

    def hold(
            self, plugin: medit.Plugin, form_key: str, record_type: str, document: medit.JsonRecord | None = None,
            parent: str | None = None, state: str = OVERRIDE) -> None:
        self.documents[plugin, form_key] = (record_type, {'FormKey': form_key, **(document or {})})
        if parent is not None:
            self.parents[plugin, form_key] = parent
        self.states[plugin, form_key] = state

    def select(self, sql: str) -> medit.Rows:
        plugins = self.active | {plugin for plugin, _ in self.documents}
        with contextlib.closing(sqlite3.connect(':memory:')) as index:
            index.row_factory = sqlite3.Row
            index.execute('CREATE TABLE records (form_key, plugin, origin, record_type, body, is_active, form_key_plugin)')
            index.execute('CREATE TABLE holdings (plugin, origin, parent, child)')
            index.execute('CREATE TABLE view_columns (view_name, column_name)')
            index.executemany('INSERT INTO records VALUES (?, ?, ?, ?, ?, ?, ?)', [
                *((f'000000:{plugin.name}', plugin.name, plugin.origin, 'header', '{}', plugin in self.active, plugin.name)
                  for plugin in plugins),
                *((form_key, plugin.name, plugin.origin, record_type, json.dumps(document), plugin in self.active, form_key.split(':')[1])
                  for (plugin, form_key), (record_type, document) in self.documents.items())])
            index.executemany('INSERT INTO holdings VALUES (?, ?, ?, ?)', [
                (plugin.name, plugin.origin, parent, child) for (plugin, child), parent in self.parents.items()])
            index.executemany('INSERT INTO view_columns VALUES (?, ?)', {
                (record_type, column) for record_type, document in self.documents.values() for column in document})
            rows = [json.dumps({'row': dict(row)}) for row in index.execute(sql)]
        return medit.Rows(io.BytesIO('\n'.join([*rows, json.dumps({'end': True})]).encode()))

    def compare(self, form_keys: list[str], plugin: medit.Plugin) -> dict[str, list[medit.RecordCopy]]:
        return {
            form_key: [medit.RecordCopy(holder, state) for (holder, held), state in self.states.items() if held == form_key]
            for form_key in form_keys}

    def read(self, plugin: medit.Plugin, form_key: str) -> medit.JsonRecord:
        return copy.deepcopy(self.documents[plugin, form_key][1])

    def edit(self, plugin: medit.Plugin, form_key: str, op: medit.EditOp, path: str, value: object) -> None:
        *members, last = path.split('.')
        document = self.documents[plugin, form_key][1]
        for member in members:
            document = document[member]
        if value is None:
            document.pop(last)
        else:
            document[last] = value

    def delete(self, plugin: medit.Plugin, form_key: str) -> None:
        del self.documents[plugin, form_key]
        del self.states[plugin, form_key]
        for held in [held for held, parent in self.parents.items() if held[0] == plugin and parent == form_key]:
            del self.parents[held]
            self.delete(*held)

    def form_keys(self, plugin: medit.Plugin) -> set[str]:
        return {form_key for held, form_key in self.documents if held == plugin}


@contextlib.contextmanager
def faked_index() -> Generator[FakeIndex]:
    index = FakeIndex(MASTER, PATCH)
    with mock.patch.multiple(
            medit, select=index.select, compare=index.compare, read=index.read, edit=index.edit, delete=index.delete):
        yield index


def hold_deleted_reference(index: FakeIndex, flags: int, base: str | None = ITEM) -> None:
    index.hold(MASTER, REFERENCE, 'refr', {'Base': base})
    index.hold(PATCH, REFERENCE, 'refr', {
        FLAGS: flags, 'Position': '1, 2, 3', TELEPORT: {'Door': ITEM}, ENABLE_PARENT: {'Reference': ITEM, 'Flags': []}})


class Clean(unittest.TestCase):
    def test_removes_an_override_only_when_its_own_copy_is_identical_to_its_master(self) -> None:
        for state, others_state, removed in [
                (IDENTICAL_TO_MASTER, OVERRIDE, [ITEM]),
                (OVERRIDE, OVERRIDE, []),
                ('IdenticalToMasterWinsConflict', OVERRIDE, []),
                (OVERRIDE, IDENTICAL_TO_MASTER, [])]:
            with self.subTest(state=state, others_state=others_state), faked_index() as index:
                index.hold(OTHER, ITEM, 'misc', state=others_state)
                index.hold(PATCH, ITEM, 'misc', state=state)
                self.assertEqual(clean(PATCH), Cleaned(removed, []))
                self.assertEqual(index.form_keys(PATCH), {ITEM} - set(removed))

    def test_removes_a_cell_identical_to_its_master_with_its_references_only_once_each_is_identical(self) -> None:
        for reference_state, removed, left in [(IDENTICAL_TO_MASTER, [CELL], set()), (OVERRIDE, [], {CELL, REFERENCE})]:
            with self.subTest(reference_state=reference_state), faked_index() as index:
                index.hold(PATCH, CELL, 'cell', state=IDENTICAL_TO_MASTER)
                index.hold(PATCH, REFERENCE, 'refr', parent=CELL, state=reference_state)
                self.assertEqual(clean(PATCH).identical_to_master, removed)
                self.assertEqual(index.form_keys(PATCH), left)

    def test_undeletes_and_disables_a_deleted_reference_with_no_teleport_or_enable_parent_lowering_it_unless_persistent(self) -> None:
        for flags, disabled, position in [
                (DELETED, INITIALLY_DISABLED, '1, 2, -30000'),
                (DELETED | PERSISTENT, PERSISTENT | INITIALLY_DISABLED, '1, 2, 3')]:
            with self.subTest(flags=flags), faked_index() as index:
                hold_deleted_reference(index, flags)
                self.assertEqual(clean(PATCH), Cleaned([], [REFERENCE]))
                reference = index.read(PATCH, REFERENCE)
                self.assertEqual(
                    [reference[FLAGS], reference['Position'], TELEPORT in reference, ENABLE_PARENT in reference],
                    [disabled, position, False, False])

    def test_skips_a_deleted_reference_whose_master_places_no_base_saying_so(self) -> None:
        with faked_index() as index, self.assertLogs('clean') as logged:
            hold_deleted_reference(index, DELETED, base=None)
            self.assertEqual(clean(PATCH), Cleaned([], []))
            self.assertEqual(index.read(PATCH, REFERENCE)[FLAGS], DELETED)
        self.assertEqual(logged.output, [
            f'INFO:clean:Skipping: {REFERENCE}', 'WARNING:clean:<Warning: Plugin contains 1 deleted references which can not be undeleted>'])

    def test_reads_the_base_of_the_active_master_not_of_a_plugin_of_its_name_that_is_not_active(self) -> None:
        with faked_index() as index, self.assertLogs('clean'):
            hold_deleted_reference(index, DELETED, base=None)
            index.hold(medit.Plugin(MASTER.name, 'Inactive Mod'), REFERENCE, 'refr', {'Base': ITEM})
            self.assertEqual(clean(PATCH).undeleted_and_disabled, [])

    def test_warns_of_a_deleted_navmesh_and_leaves_it(self) -> None:
        with faked_index() as index, self.assertLogs('clean', 'WARNING') as logged:
            index.hold(PATCH, ITEM, 'navm', {FLAGS: DELETED})
            clean(PATCH)
            self.assertEqual(index.read(PATCH, ITEM)[FLAGS], DELETED)
        self.assertEqual(logged.output, ['WARNING:clean:<Warning: Plugin contains 1 deleted NavMeshes which can not be undeleted>'])

    def test_refuses_a_plugin_that_is_not_active(self) -> None:
        inactive = medit.Plugin('Inactive.esp', 'Inactive Mod')
        with faked_index() as index, self.assertRaisesRegex(medit.MEditError, '^Inactive.esp is not active'):
            index.hold(inactive, '000800:Inactive.esp', 'misc')
            clean(inactive)


if __name__ == '__main__':
    unittest.main()
