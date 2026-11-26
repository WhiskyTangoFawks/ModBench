import json
import os
import unittest
from unittest import mock

import medit
from tests.fake_medit import Reply, Sent, medit_answering

PLUGIN = medit.Plugin('My Mod.esp', 'Mods A+B')
ADDRESS = {'name': PLUGIN.name, 'origin': PLUGIN.origin}
FORM_KEY = '000800:My Mod.esp'
QUOTED_FORM_KEY = '000800%3AMy%20Mod.esp'
RESOLVED = [{'plugin': ADDRESS}]
NAMED_RECORD = {'plugin': None, 'formKey': FORM_KEY, 'editorId': 'Recipe'}
SENT_RESOLVE = Sent('POST', '/names/resolve', {'names': [{'name': PLUGIN.name}]})
RECIPE = {'FormKey': FORM_KEY, 'EditorID': 'Recipe'}
STOPPED_SHORT = "mEdit's rows stopped before their last line, so they may not be every row the SELECT selects."
SELECTED = Sent('POST', '/records/select', {'sql': 'SELECT 1'})


def lines(*answered: medit.JsonRecord) -> bytes:
    return b''.join(json.dumps(line).encode() + b'\n' for line in answered)


class Reaching(unittest.TestCase):
    def test_reaches_the_medit_on_the_port_its_window_sets_at_each_call(self) -> None:
        for window in ('A', 'B'):
            with self.subTest(window), medit_answering(lines({'row': {'window': window}}, {'end': True})):
                self.assertEqual(list(medit.select('SELECT 1')), [{'window': window}])

    def test_raises_naming_where_a_script_reaches_mEdit_when_its_launcher_sets_no_port(self) -> None:
        with mock.patch.dict(os.environ), self.assertRaises(medit.MEditError) as raised:
            os.environ.pop('MEDIT_PORT', None)
            medit.select('SELECT 1')
        self.assertEqual(
            str(raised.exception),
            'This script has no mEdit to reach: run it in a terminal, a notebook or a Run and Debug launch of a Modbench window.')

    def test_raises_the_detail_of_a_problem_mEdit_answers_or_else_its_status(self) -> None:
        for reply, raised in [
                (Reply({'status': 503, 'detail': 'Not ready.'}, 503), 'Not ready.'),
                (Reply(b'<html>Bad Gateway</html>', 502), 'mEdit answered 502.')]:
            with self.subTest(raised), medit_answering(reply), self.assertRaisesRegex(medit.MEditError, f'^{raised}$'):
                medit.resolve(PLUGIN.name)

    def test_raises_naming_the_port_when_nothing_answers_on_it(self) -> None:
        refused_at_once = '0'
        with (
                mock.patch.dict(os.environ, {'MEDIT_PORT': refused_at_once}),
                self.assertRaisesRegex(medit.MEditError, f'port {refused_at_once}:')):
            medit.select('SELECT 1')


class Select(unittest.TestCase):
    def test_sends_the_sql_and_yields_each_row_until_the_line_that_ends_them(self) -> None:
        with medit_answering(lines({'row': {'n': 1}}, {'row': {'n': 2}}, {'end': True})) as sent:
            rows = list(medit.select('SELECT 1'))
        self.assertEqual((sent, rows), ([SELECTED], [{'n': 1}, {'n': 2}]))

    def test_raises_the_reason_the_rows_stop_after_a_row(self) -> None:
        for last, raised in [
                ({'refusal': 'OutOfMemory', 'detail': 'Out of memory.'}, 'Out of memory.'),
                ({'row': {'n': 2}}, STOPPED_SHORT)]:
            with (
                    self.subTest(raised), medit_answering(lines({'row': {'n': 1}}, last)),
                    self.assertRaises(medit.MEditError) as stopped):
                list(medit.select('SELECT 1'))
            self.assertEqual(str(stopped.exception), raised)

    def test_raises_saying_to_list_the_rows_at_a_second_read_or_a_truth_test(self) -> None:
        for name, second_read in [('second read', list), ('truth test', bool)]:
            with self.subTest(name), medit_answering(lines({'end': True})):
                rows = medit.select('SELECT 1')
                list(rows)
                with self.assertRaisesRegex(medit.MEditError, r'list\(\)'):
                    second_read(rows)


class Resolve(unittest.TestCase):
    def test_sends_each_name_with_the_origin_given_and_answers_each_as_a_plugin_or_a_record(self) -> None:
        with medit_answering([*RESOLVED, *RESOLVED, NAMED_RECORD]) as sent:
            named = medit.resolve(PLUGIN.name, PLUGIN, 'Recipe')
        self.assertEqual(sent, [Sent('POST', '/names/resolve', {'names': [{'name': PLUGIN.name}, ADDRESS, {'name': 'Recipe'}]})])
        self.assertEqual(named, [PLUGIN, PLUGIN, medit.RecordName(FORM_KEY, 'Recipe')])

    def test_raises_naming_a_name_given_as_a_plugin_that_names_a_record_and_sends_nothing_more(self) -> None:
        with (
                medit_answering([NAMED_RECORD]) as sent,
                self.assertRaisesRegex(medit.MEditError, '^Recipe is not a plugin.$')):
            medit.read('Recipe', FORM_KEY)
        self.assertEqual(len(sent), 1)


class Reading(unittest.TestCase):
    def test_reads_the_copy_of_the_plugin_resolved_quoting_each_part_of_its_address(self) -> None:
        with medit_answering(RESOLVED, {'fileName': 'Recipe.json', 'text': json.dumps(RECIPE)}) as sent:
            recipe = medit.read(PLUGIN.name, FORM_KEY)
        self.assertEqual(sent, [
            SENT_RESOLVE,
            Sent('GET', f'/plugins/My%20Mod.esp/records/{QUOTED_FORM_KEY}/rendered-document?origin=Mods%20A%2BB', None)])
        self.assertEqual(recipe, RECIPE)

    def test_compares_the_records_within_the_plugin_resolved_or_the_load_order_and_answers_each_records_copies(self) -> None:
        states = [{'formKey': FORM_KEY, 'copies': [{'plugin': ADDRESS, 'conflictThis': 'IdenticalToMaster'}]}]
        for plugin, replies, requests in [
                (PLUGIN.name, [RESOLVED, states], [SENT_RESOLVE, Sent('POST', '/records/copy-states', {'formKeys': [FORM_KEY], 'plugin': ADDRESS})]),
                (None, [states], [Sent('POST', '/records/copy-states', {'formKeys': [FORM_KEY]})])]:
            with self.subTest(plugin), medit_answering(*replies) as sent:
                compared = medit.compare([FORM_KEY], plugin)
            self.assertEqual(sent, requests)
            self.assertEqual(compared, {FORM_KEY: [medit.RecordCopy(PLUGIN, 'IdenticalToMaster')]})

    def test_names_each_referrer_with_its_plugin_and_origin(self) -> None:
        answer = [{
            'formKey': FORM_KEY, 'plugin': PLUGIN.name, 'origin': PLUGIN.origin, 'fieldPath': 'Conditions[0].Data.ParameterOneRecord',
            'recordType': 'cobj', 'recordTypeName': 'Constructible Object', 'editorId': 'Recipe'}]
        with medit_answering(answer) as sent:
            referrers = medit.referenced_by(FORM_KEY)
        self.assertEqual(sent, [Sent('GET', f'/records/{QUOTED_FORM_KEY}/references-in-active-or-compiled-plugins', None)])
        self.assertEqual(referrers, [medit.Referrer(PLUGIN, FORM_KEY, 'Conditions[0].Data.ParameterOneRecord', 'cobj', 'Recipe')])


class Writing(unittest.TestCase):
    def test_edits_at_the_hops_of_the_field_path_sending_a_value_only_when_given_one(self) -> None:
        hops = [
            {'kind': 'member', 'name': 'Conditions'}, {'kind': 'index', 'index': 0}, {'kind': 'member', 'name': 'ComparisonValue'}]
        edited = {
            'newFormKey': None, 'leftBehind': [{'plugin': ADDRESS, 'reason': 'Unreadable.'}],
            'copiesLeftBehind': [{'plugin': ADDRESS, 'formKey': FORM_KEY}], 'copiesUnread': 'Unread.'}
        for given, value in [((7.5,), {'value': 7.5}), ((None,), {'value': None}), ((), {})]:
            with self.subTest(value), medit_answering(RESOLVED, edited) as sent:
                answered = medit.edit(PLUGIN.name, FORM_KEY, 'set', 'Conditions[0].ComparisonValue', *given)
            self.assertEqual(sent[1], Sent(
                'POST', f'/records/{QUOTED_FORM_KEY}/edit', {'plugin': PLUGIN.name, 'origin': PLUGIN.origin, 'op': 'set', 'path': hops, **value}))
            self.assertEqual(answered, medit.Edited(
                None, [medit.SourceLeftBehind(PLUGIN, 'Unreadable.')], [medit.CopyLeftBehind(PLUGIN, FORM_KEY)], 'Unread.'))

    def test_raises_naming_a_malformed_field_path_and_sends_nothing(self) -> None:
        with medit_answering() as sent, self.assertRaisesRegex(medit.MEditError, r'^Conditions\[0\]\]\.Value is not a field path\.$'):
            medit.edit(PLUGIN.name, FORM_KEY, 'set', 'Conditions[0]].Value', 1)
        self.assertEqual(sent, [])

    def test_copies_the_record_of_the_plugin_resolved_into_the_destination_resolved_and_answers_the_copys_form_key(self) -> None:
        destination = {'name': 'Patch.esp', 'origin': 'Patches'}
        with medit_answering(RESOLVED, [{'plugin': destination}], {'formKey': '000801:Patch.esp'}) as sent:
            copied = medit.copy(PLUGIN.name, FORM_KEY, 'Patch.esp', mode='new', replace=True)
        self.assertEqual(sent[2], Sent('POST', '/records/copy', {
            'record': {'formKey': FORM_KEY, 'plugin': ADDRESS}, 'mode': 'new', 'destination': destination, 'replace': True}))
        self.assertEqual(copied, '000801:Patch.esp')

    def test_creates_a_plugin_in_the_origin_given_and_answers_its_address(self) -> None:
        with medit_answering(ADDRESS) as sent:
            created = medit.create_plugin(PLUGIN.name, PLUGIN.origin, flags=['Light'])
        self.assertEqual(sent, [Sent('POST', '/plugins/create-in-mod', {**ADDRESS, 'flags': ['Light']})])
        self.assertEqual(created, PLUGIN)

    def test_makes_a_patch_plugin_of_each_record_read_or_new_with_its_type_and_answers_compiles_diagnostics(self) -> None:
        made = {'plugin': ADDRESS, 'diagnostics': [{'formKey': FORM_KEY, 'message': 'Unresolved link.'}]}
        with medit_answering(made) as sent:
            patch = medit.make_patch_plugin(
                PLUGIN.name, PLUGIN.origin, [RECIPE, medit.NewRecord('cobj', RECIPE)], flags=[], replace=True)
        self.assertEqual(sent, [Sent('POST', '/plugins/make-patch', {
            **ADDRESS, 'flags': [], 'replace': True,
            'records': [{'text': json.dumps(RECIPE)}, {'text': json.dumps(RECIPE), 'recordType': 'cobj'}]})])
        self.assertEqual(patch, medit.Patch(PLUGIN, [medit.Diagnostic(FORM_KEY, 'Unresolved link.')]))

    def test_creates_a_record_in_the_plugin_resolved_at_its_container_and_grid_position_and_answers_its_form_key(self) -> None:
        with medit_answering(RESOLVED, {'formKey': FORM_KEY}) as sent:
            created = medit.create_record(PLUGIN.name, 'cell', container='000801:My Mod.esp', position=(1, -2))
        self.assertEqual(sent[1], Sent('POST', '/plugins/My%20Mod.esp/create-record', {
            'origin': PLUGIN.origin, 'recordType': 'cell', 'container': '000801:My Mod.esp', 'position': {'x': 1, 'y': -2}}))
        self.assertEqual(created, FORM_KEY)

    def test_deletes_the_record_of_the_plugin_resolved(self) -> None:
        with medit_answering(RESOLVED, None) as sent:
            medit.delete(PLUGIN.name, FORM_KEY)
        self.assertEqual(sent[1], Sent('POST', '/records/delete', {'formKey': FORM_KEY, 'plugin': ADDRESS}))


if __name__ == '__main__':
    unittest.main()
