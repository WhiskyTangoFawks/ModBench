import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Literal, NamedTuple

JsonRecord = dict[str, Any]
Name = str | tuple[str, str]
EditOp = Literal['set', 'add', 'remove', 'move']
CopyMode = Literal['override', 'new']


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


def select(sql: str) -> list[JsonRecord]:
    """The rows of one SQL SELECT over the views of every plugin the index holds, each a dict of its columns; view_columns lists them."""
    return _call('POST', '/records/select', {'sql': sql})['rows']


def resolve(*names: Name) -> list[Plugin | RecordName]:
    """What each name means: a plugin file name, or a record's EditorID or FormKey; (name, origin) picks a plugin."""
    queries = [{'name': name} if isinstance(name, str) else {'name': name[0], 'origin': name[1]} for name in names]
    return [_named(named) for named in _call('POST', '/names/resolve', {'names': queries})]


def read(plugin: Name, form_key: str) -> JsonRecord:
    """The plugin's copy of a record whole, as the document plugin source holds it."""
    name, origin = _plugin(plugin)
    document = _call('GET', f'/plugins/{_quoted(name)}/records/{_quoted(form_key)}/rendered-document?origin={_quoted(origin)}')
    return json.loads(document['text'])


def referenced_by(form_key: str) -> list[Referrer]:
    """The records that reference a record, each with its plugin and the field that holds the reference."""
    return [
        Referrer(
            plugin=Plugin(referrer['plugin'], referrer['origin']), form_key=referrer['formKey'],
            field_path=referrer['fieldPath'], record_type=referrer['recordType'], editor_id=referrer['editorId'])
        for referrer in _call('GET', f'/records/{_quoted(form_key)}/references')]


_NO_VALUE = object()


def edit(plugin: Name, form_key: str, op: EditOp, path: str, value: object = _NO_VALUE) -> None:
    """Writes op to the plugin's copy of a record in its plugin source, at a field path spelled as referenced_by
    spells one, such as Conditions[0].ComparisonValue. A value of None clears a member."""
    hops = _hops(path)
    name, origin = _plugin(plugin)
    body: JsonRecord = {'plugin': name, 'origin': origin, 'op': op, 'path': hops}
    if value is not _NO_VALUE:
        body['value'] = value
    _call('POST', f'/records/{_quoted(form_key)}/edit', body)


def copy(plugin: Name, form_key: str, destination: Name, mode: CopyMode = 'override', replace: bool = False) -> str:
    """Writes a copy of the plugin's record into the destination plugin's source and returns the FormKey the copy
    holds there. Replace lets an override copy over the record the destination holds."""
    name, origin = _plugin(plugin)
    into_name, into_origin = _plugin(destination)
    return _call('POST', '/records/copy', {
        'record': {'formKey': form_key, 'plugin': {'name': name, 'origin': origin}},
        'mode': mode, 'destination': {'name': into_name, 'origin': into_origin}, 'replace': replace})['formKey']


def create_plugin(name: str, origin: str) -> Plugin:
    """Writes an empty plugin into an enabled mod or Overwrite. It has plugin source only in a mod that is already a
    source mod; elsewhere a write is refused until its mod is decompiled and committed."""
    _call('POST', '/plugins/create-in-mod', {'origin': origin, 'name': name})
    return Plugin(name, origin)


def create_record(
        plugin: Name, record_type: str, container: str | None = None, position: tuple[int, int] | None = None) -> str:
    """Writes a new record of a record type, such as npc_, into the plugin's source, in a container such as a cell, at
    a grid position for a cell in a worldspace, and returns its FormKey."""
    name, origin = _plugin(plugin)
    body: JsonRecord = {'origin': origin, 'recordType': record_type, 'container': container}
    if position is not None:
        body['position'] = {'x': position[0], 'y': position[1]}
    return _call('POST', f'/plugins/{_quoted(name)}/create-record', body)['formKey']


def delete(plugin: Name, form_key: str) -> None:
    """Deletes the plugin's copy of a record from its plugin source."""
    name, origin = _plugin(plugin)
    _call('POST', '/records/delete', {'formKey': form_key, 'plugin': {'name': name, 'origin': origin}})


def _named(named: JsonRecord) -> Plugin | RecordName:
    plugin = named['plugin']
    if plugin is None:
        return RecordName(form_key=named['formKey'], editor_id=named['editorId'])
    return Plugin(plugin['name'], plugin['origin'])


def _plugin(plugin: Name) -> Plugin:
    [named] = resolve(plugin)
    if not isinstance(named, Plugin):
        raise MEditError(f'{plugin} is not a plugin.')
    return named


_FIELD_PATH = re.compile(r'[^.\[\]]+(\[\d+\])*(\.[^.\[\]]+(\[\d+\])*)*')
_HOP = re.compile(r'([^.\[\]]+)|\[(\d+)\]')


def _hops(path: str) -> list[JsonRecord]:
    if not _FIELD_PATH.fullmatch(path):
        raise MEditError(f'{path} is not a field path.')
    return [
        {'kind': 'member', 'name': member} if member else {'kind': 'index', 'index': int(index)}
        for member, index in _HOP.findall(path)]


def _quoted(segment: str) -> str:
    return urllib.parse.quote(segment, safe='')


def _call(method: str, path: str, body: JsonRecord | None = None) -> Any:
    port = os.environ.get('MEDIT_PORT')
    if port is None:
        raise MEditError('This script has no mEdit to reach: run it in a terminal, a notebook or a Run and Debug launch of a Modbench window.')
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


def _detail(refused: urllib.error.HTTPError) -> str | None:
    try:
        problem = json.load(refused)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return problem.get('detail') if isinstance(problem, dict) else None
