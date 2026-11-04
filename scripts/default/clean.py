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
TELEPORT_FIELD = 'TeleportDestination'
UNDERGROUND_Z = '-30000'
OPPOSITE_OF_PARENT = ['SetEnableStateToOppositeOfParent']
PLAYER_REFERENCE = 'PlayerRef'

log = logging.getLogger('clean')


class Cleaned(NamedTuple):
    identical_to_master: list[str]
    undeleted_and_disabled: list[str]


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _in_plugin(plugin: medit.Plugin, alias: str = '') -> str:
    prefix = f'{alias}.' if alias else ''
    return f'{prefix}plugin = {_literal(plugin.name)} AND {prefix}origin = {_literal(plugin.origin)}'


def _flags_of(body: str) -> int:
    return int(json.loads(body).get(FLAGS_FIELD, 0))


def _member(record: medit.JsonRecord, path: str) -> object:
    value: object = record
    for hop in path.split('.'):
        value = value.get(hop) if isinstance(value, dict) else None
    return value


def _position_path(record_type: str) -> str:
    columns = {row['column_name'] for row in medit.select(f'SELECT column_name FROM view_columns WHERE view_name = {_literal(record_type)}')}
    return 'Position' if 'Position' in columns else 'Placement.Position'


def _underground(position: object) -> str:
    x, y, _ = (position if isinstance(position, str) else '0, 0, 0').split(', ')
    return f'{x}, {y}, {UNDERGROUND_Z}'


def _player_reference() -> str:
    [player] = medit.resolve(PLAYER_REFERENCE)
    if not isinstance(player, medit.RecordName):
        raise medit.MEditError(f'{PLAYER_REFERENCE} is not a record, so a reference cannot be enabled opposite the player.')
    return player.form_key


def _master_places_a_base(form_key: str) -> bool:
    masters = medit.select(
        f'SELECT m.plugin, m.origin FROM records m WHERE m.form_key = {_literal(form_key)} AND m.is_active '
        'AND lower(m.plugin) = lower(m.form_key_plugin)')
    return any(medit.read(medit.Plugin(master['plugin'], master['origin']), form_key).get('Base') for master in masters)


def _deleted_references(plugin: medit.Plugin) -> list[tuple[str, str, int]]:
    types = ', '.join(_literal(record_type) for record_type in PLACED_REFERENCE_TYPES)
    rows = medit.select(f'SELECT form_key, record_type, body FROM records WHERE {_in_plugin(plugin)} AND record_type IN ({types})')
    return [(row['form_key'], row['record_type'], flags) for row in rows if (flags := _flags_of(row['body'])) & DELETED_FLAG]


def _warn_of_deleted_navmeshes(plugin: medit.Plugin) -> None:
    rows = medit.select(f'SELECT body FROM records WHERE {_in_plugin(plugin)} AND record_type = {_literal(NAVMESH_TYPE)}')
    deleted = [row for row in rows if _flags_of(row['body']) & DELETED_FLAG]
    if deleted:
        log.warning('<Warning: Plugin contains %d deleted NavMeshes which can not be undeleted>', len(deleted))


def _undelete_and_disable(plugin: medit.Plugin) -> list[str]:
    deleted = _deleted_references(plugin)
    undeletable = [reference for reference in deleted if _master_places_a_base(reference[0])]
    skipped = [reference for reference in deleted if reference not in undeletable]
    for form_key, _, _ in skipped:
        log.info('Skipping: %s', form_key)
    if skipped:
        log.warning('<Warning: Plugin contains %d deleted references which can not be undeleted>', len(skipped))
    if not undeletable:
        return []
    player = _player_reference()
    for form_key, record_type, raw in undeletable:
        medit.edit(plugin, form_key, 'set', FLAGS_FIELD, (raw & ~DELETED_FLAG) | INITIALLY_DISABLED_FLAG)
        record = medit.read(plugin, form_key)
        if not raw & PERSISTENT_FLAG:
            position_path = _position_path(record_type)
            medit.edit(plugin, form_key, 'set', position_path, _underground(_member(record, position_path)))
        if TELEPORT_FIELD in record:
            medit.edit(plugin, form_key, 'set', TELEPORT_FIELD, None)
        medit.edit(plugin, form_key, 'set', 'EnableParent', {'Reference': player, 'Flags': OPPOSITE_OF_PARENT})
    return [form_key for form_key, _, _ in undeletable]


def _identical_to_master(plugin: medit.Plugin) -> set[str]:
    rows = medit.select(
        'WITH copies AS MATERIALIZED (SELECT form_key, form_key_plugin, record_type, body, parse_diagnosis FROM records '
        f'WHERE {_in_plugin(plugin)} AND lower(form_key_plugin) <> lower(plugin)), '
        'masters AS MATERIALIZED (SELECT m.form_key, m.record_type, m.body, m.parse_diagnosis FROM records m JOIN copies c '
        'ON m.form_key = c.form_key AND lower(m.plugin) = lower(c.form_key_plugin) WHERE m.is_active) '
        'SELECT c.form_key FROM copies c JOIN masters m ON m.form_key = c.form_key '
        'WHERE compared_hash(c.record_type, c.body, c.parse_diagnosis) = compared_hash(m.record_type, m.body, m.parse_diagnosis)')
    return {row['form_key'] for row in rows}


def _removed_with_their_references(plugin: medit.Plugin, identical: set[str]) -> list[str]:
    holdings = medit.select(f'SELECT parent, child FROM holdings WHERE {_in_plugin(plugin)}')
    children: dict[str, list[str]] = {}
    parents: dict[str, str] = {}
    for holding in holdings:
        children.setdefault(holding['parent'], []).append(holding['child'])
        parents[holding['child']] = holding['parent']

    def is_emptied(form_key: str) -> bool:
        return form_key in identical and all(is_emptied(child) for child in children.get(form_key, []))

    return sorted(form_key for form_key in identical if is_emptied(form_key) and not (form_key in parents and is_emptied(parents[form_key])))


def clean(plugin: medit.Plugin) -> Cleaned:
    if not medit.select(f"SELECT 1 FROM records WHERE {_in_plugin(plugin)} AND record_type = 'header' AND is_active"):
        raise medit.MEditError(f'{plugin.name} is not active, so no record of it has a master to compare with.')
    _warn_of_deleted_navmeshes(plugin)
    undeleted = _undelete_and_disable(plugin)
    removed = _removed_with_their_references(plugin, _identical_to_master(plugin))
    for form_key in removed:
        medit.delete(plugin, form_key)
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
