"""Cleans a plugin as xEdit's Quick Auto Clean does. Arguments: the plugin's file name, then its mod's name."""
import json
import logging
import sys
from typing import NamedTuple

import medit

DELETED_FLAG = 0x20
PERSISTENT_FLAG = 0x400
INITIALLY_DISABLED_FLAG = 0x800
PLACED_REFERENCE_TYPES = ('refr', 'pgre', 'pmis', 'achr', 'acre', 'parw', 'pbar', 'pbea', 'pcon', 'pfla', 'phzd')
NAVMESH_TYPE = 'navm'
FLAGS_FIELD = 'MajorRecordFlagsRaw'
UNDERGROUND_POSITION = '0, 0, -30000'
OPPOSITE_OF_PARENT = ['SetEnableStateToOppositeOfParent']
PLAYER_REFERENCE = 'PlayerRef'
PASSES = 3

log = logging.getLogger('clean')


class Cleaned(NamedTuple):
    identical_to_master: list[str]
    undeleted_and_disabled: list[str]


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _in_plugin(plugin: medit.Plugin, alias: str = '') -> str:
    prefix = f'{alias}.' if alias else ''
    return f'{prefix}plugin = {_literal(plugin.name)} AND {prefix}origin = {_literal(plugin.origin)}'


def _position_path(record_type: str) -> str:
    columns = {row['column_name'] for row in medit.select(f'SELECT column_name FROM view_columns WHERE view_name = {_literal(record_type)}')}
    return 'Position' if 'Position' in columns else 'Placement.Position'


def _deleted_references(plugin: medit.Plugin) -> list[tuple[str, str, int]]:
    types = ', '.join(_literal(record_type) for record_type in PLACED_REFERENCE_TYPES)
    rows = medit.select(
        f'SELECT o.form_key, o.record_type, o.body FROM records o WHERE {_in_plugin(plugin, "o")} AND o.record_type IN ({types}) '
        'AND EXISTS (SELECT 1 FROM records m WHERE m.form_key = o.form_key AND lower(m.plugin) = lower(o.form_key_plugin) '
        "AND lower(m.plugin) <> lower(o.plugin) AND m.body LIKE '%\"Base\"%')")
    flags = [(row['form_key'], row['record_type'], int(json.loads(row['body']).get(FLAGS_FIELD, 0))) for row in rows]
    return [(form_key, record_type, raw) for form_key, record_type, raw in flags if raw & DELETED_FLAG]


def _warn_of_deleted_navmeshes(plugin: medit.Plugin) -> None:
    deleted = [
        row for row in medit.select(f'SELECT body FROM records WHERE {_in_plugin(plugin)} AND record_type = {_literal(NAVMESH_TYPE)}')
        if int(json.loads(row['body']).get(FLAGS_FIELD, 0)) & DELETED_FLAG]
    if deleted:
        log.warning('%s holds %d deleted navmeshes, which cannot be undeleted.', plugin.name, len(deleted))


def _undelete_and_disable(plugin: medit.Plugin) -> list[str]:
    deleted = _deleted_references(plugin)
    if not deleted:
        return []
    [player] = medit.resolve(PLAYER_REFERENCE)
    if not isinstance(player, medit.RecordName):
        raise medit.MEditError(f'{PLAYER_REFERENCE} is not a record, so a reference cannot be enabled opposite the player.')
    for form_key, record_type, raw in deleted:
        medit.edit(plugin, form_key, 'set', FLAGS_FIELD, (raw & ~DELETED_FLAG) | INITIALLY_DISABLED_FLAG)
        if not raw & PERSISTENT_FLAG:
            medit.edit(plugin, form_key, 'set', _position_path(record_type), UNDERGROUND_POSITION)
        medit.edit(plugin, form_key, 'set', 'EnableParent', {'Reference': player.form_key, 'Flags': OPPOSITE_OF_PARENT})
    return [form_key for form_key, _, _ in deleted]


def _identical_to_master(plugin: medit.Plugin) -> list[str]:
    rows = medit.select(
        f'SELECT o.form_key FROM records o JOIN records m ON m.form_key = o.form_key AND lower(m.plugin) = lower(o.form_key_plugin) '
        f"WHERE {_in_plugin(plugin, 'o')} AND o.record_type <> 'header' AND lower(o.form_key_plugin) <> lower(o.plugin) "
        'AND o.content_hash = m.content_hash')
    return [row['form_key'] for row in rows]


def clean(plugin: medit.Plugin) -> Cleaned:
    _warn_of_deleted_navmeshes(plugin)
    removed: list[str] = []
    undeleted: list[str] = []
    for _ in range(PASSES):
        undeleted_now = _undelete_and_disable(plugin)
        identical = _identical_to_master(plugin)
        for form_key in identical:
            medit.delete(plugin, form_key)
        removed += identical
        undeleted += undeleted_now
        if not (identical or undeleted_now):
            break
    return Cleaned(removed, undeleted)


def main(arguments: list[str]) -> None:
    if not 1 <= len(arguments) <= 2:
        raise SystemExit('Usage: clean.py PLUGIN [MOD]')
    [named] = medit.resolve(arguments[0] if len(arguments) == 1 else (arguments[0], arguments[1]))
    if not isinstance(named, medit.Plugin):
        raise SystemExit(f'{arguments[0]} is not a plugin.')
    cleaned = clean(named)
    log.info('%s: removed %d records identical to their master, undeleted and disabled %d references.',
             named.name, len(cleaned.identical_to_master), len(cleaned.undeleted_and_disabled))


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(message)s')
    main(sys.argv[1:])
