import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import NamedTuple


class MEditError(Exception):
    pass


class Plugin(NamedTuple):
    name: str
    origin: str


@dataclass(frozen=True)
class RecordName:
    form_key: str
    editor_id: str | None


@dataclass(frozen=True)
class Referrer:
    plugin: Plugin
    form_key: str
    field_path: str
    record_type: str
    editor_id: str | None


def select(sql):
    """The rows of one SQL SELECT over the record views, each a dict of its columns."""
    return _call('POST', '/records/select', {'sql': sql})['rows']


def resolve(*names):
    """What each name means: a plugin file name, or a record's EditorID or FormKey; (name, origin) picks a plugin."""
    queries = [{'name': name} if isinstance(name, str) else {'name': name[0], 'origin': name[1]} for name in names]
    return [_named(named) for named in _call('POST', '/names/resolve', {'names': queries})['named']]


def _named(named):
    plugin = named['plugin']
    if plugin is None:
        return RecordName(named['formKey'], named['editorId'])
    return Plugin(plugin['name'], plugin['origin'])


def read(plugin, form_key):
    """The plugin's copy of a record whole, as the document plugin source holds it; plugin is a file name or (name, origin)."""
    name, origin = _plugin(plugin)
    document = _call('GET', f'/plugins/{_quoted(name)}/records/{_quoted(form_key)}/rendered-document?origin={_quoted(origin)}')
    return json.loads(document['text'])


_NO_VALUE = object()


def edit(plugin, form_key, op, path, value=_NO_VALUE):
    """Writes set, add, remove or move to the plugin's copy of a record in its plugin source, at a field path spelled
    as references spells one, such as Conditions[0].ComparisonValue. A value of None clears a member."""
    name, origin = _plugin(plugin)
    body = {'plugin': name, 'origin': origin, 'op': op, 'path': _hops(path)}
    if value is not _NO_VALUE:
        body['value'] = value
    _call('POST', f'/records/{_quoted(form_key)}/edit', body)


def copy(plugin, form_key, destination, mode='override', replace=False):
    """Writes a copy of the plugin's record into the destination plugin's source, as an override or as new, and returns
    the FormKey the copy holds there. Replace lets an override copy over the record the destination holds."""
    name, origin = _plugin(plugin)
    into_name, into_origin = _plugin(destination)
    return _call('POST', '/records/copy', {
        'record': {'formKey': form_key, 'plugin': name, 'origin': origin},
        'mode': mode.capitalize(), 'destination': {'name': into_name, 'origin': into_origin}, 'replace': replace})['formKey']


def create_plugin(name, origin):
    """Writes an empty plugin, with its plugin source in a source mod, into the mod origin, which must hold a plugin
    already, and returns it. The plugin joins the load order disabled, once Modbench's watcher sees it."""
    _call('POST', '/plugins/create-in-mod', {'origin': origin, 'name': name})
    return Plugin(name, origin)


def create_record(plugin, record_type, container=None, position=None):
    """Writes a new record of a record type, such as npc_, into the plugin's source, in a container such as a cell, at
    a grid position (x, y) for a cell in a worldspace, and returns its FormKey."""
    name, origin = _plugin(plugin)
    body = {'origin': origin, 'recordType': record_type, 'container': container}
    if position is not None:
        body['position'] = {'x': position[0], 'y': position[1]}
    return _call('POST', f'/plugins/{_quoted(name)}/create-record', body)['formKey']


def delete(plugin, form_key):
    """Deletes the plugin's copy of a record from its plugin source."""
    name, origin = _plugin(plugin)
    _call('POST', '/records/delete', {'formKey': form_key, 'plugin': name, 'origin': origin})


def _plugin(plugin):
    [named] = resolve(plugin)
    if not isinstance(named, Plugin):
        raise MEditError(f'{plugin} is not a plugin.')
    return named


_FIELD_PATH = re.compile(r'[^.\[\]]+(\[\d+\])*(\.[^.\[\]]+(\[\d+\])*)*')
_HOP = re.compile(r'([^.\[\]]+)|\[(\d+)\]')


def _hops(path):
    if not _FIELD_PATH.fullmatch(path):
        raise MEditError(f'{path} is not a field path.')
    return [
        {'kind': 'member', 'name': member} if member else {'kind': 'index', 'index': int(index)}
        for member, index in _HOP.findall(path)]


def referenced_by(form_key):
    """The records that reference a record, each with its plugin and the field that holds the reference."""
    return [
        Referrer(
            Plugin(referrer['plugin'], referrer['origin']), referrer['formKey'], referrer['fieldPath'],
            referrer['recordType'], referrer['editorId'])
        for referrer in _call('GET', f'/records/{_quoted(form_key)}/references')]


def _quoted(segment):
    return urllib.parse.quote(segment, safe='')


def _call(method, path, body=None):
    port = os.environ.get('MEDIT_PORT')
    if port is None:
        raise MEditError('This script has no mEdit to reach: run it in a terminal of a Modbench window.')
    request = urllib.request.Request(
        f'http://localhost:{port}{path}', method=method, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request) as response:
            answer = response.read()
        return json.loads(answer) if answer else None
    except urllib.error.HTTPError as refused:
        raise MEditError(_detail(refused) or f'mEdit answered {refused.code}.') from None
    except urllib.error.URLError as unreachable:
        raise MEditError(f'mEdit does not answer on port {port}: {unreachable.reason}') from None


def _detail(refused):
    try:
        problem = json.load(refused)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return problem.get('detail') if isinstance(problem, dict) else None
