"""Cleans a plugin as xEdit's Quick Auto Clean does. Arguments: the plugin's file name, then its mod's name."""
import json
import logging
import sys
from typing import NamedTuple

import medit

DELETED_FLAG = 0x20
INITIALLY_DISABLED_FLAG = 0x800
REFERENCE_TYPES = ('refr', 'achr', 'acre', 'pgre', 'pmis', 'pbea', 'pfla', 'phzd')
FLAGS_FIELD = 'MajorRecordFlagsRaw'

log = logging.getLogger('clean')


class Cleaned(NamedTuple):
    identical_to_master: list[str]
    undeleted_and_disabled: list[str]


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _identical_to_the_record_they_override(plugin: medit.Plugin) -> list[str]:
    placed = medit.select(
        f"SELECT load_order_idx FROM records WHERE record_type = 'header' AND plugin = {_literal(plugin.name)} "
        f'AND origin = {_literal(plugin.origin)}')
    if not placed or placed[0]['load_order_idx'] is None:
        raise medit.MEditError(f'{plugin.name} has no place in the load order, so no record of it has a master to compare with.')
    rows = medit.select(
        f'SELECT o.form_key FROM records o WHERE o.plugin = {_literal(plugin.name)} AND o.origin = {_literal(plugin.origin)} '
        'AND lower(o.form_key_plugin) <> lower(o.plugin) AND o.content_hash = ('
        'SELECT p.content_hash FROM records p WHERE p.form_key = o.form_key AND p.load_order_idx < o.load_order_idx '
        'ORDER BY p.load_order_idx DESC LIMIT 1)')
    return [row['form_key'] for row in rows]


def _deleted_references(plugin: medit.Plugin) -> list[tuple[str, int]]:
    types = ', '.join(_literal(record_type) for record_type in REFERENCE_TYPES)
    rows = medit.select(
        f'SELECT form_key, body FROM records WHERE plugin = {_literal(plugin.name)} AND origin = {_literal(plugin.origin)} '
        f'AND record_type IN ({types})')
    flags = [(row['form_key'], int(json.loads(row['body']).get(FLAGS_FIELD, 0))) for row in rows]
    return [(form_key, raw) for form_key, raw in flags if raw & DELETED_FLAG]


def clean(plugin: medit.Plugin) -> Cleaned:
    identical = _identical_to_the_record_they_override(plugin)
    deleted = _deleted_references(plugin)
    for form_key in identical:
        medit.delete(plugin, form_key)
    for form_key, raw in deleted:
        medit.edit(plugin, form_key, 'set', FLAGS_FIELD, (raw & ~DELETED_FLAG) | INITIALLY_DISABLED_FLAG)
    return Cleaned(identical, [form_key for form_key, _ in deleted])


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
