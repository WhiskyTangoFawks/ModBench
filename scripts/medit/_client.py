import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request


class MEditError(Exception):
    pass


def select(sql):
    """The rows of one SQL SELECT over the record views, each a dict of its columns."""
    return _call('POST', '/records/select', {'sql': sql})['rows']


def resolve(*names):
    """What each name means: a plugin file name, or a record's EditorID or FormKey; (name, origin) picks a plugin."""
    queries = [{'name': name} if isinstance(name, str) else {'name': name[0], 'origin': name[1]} for name in names]
    return [_resolved(named) for named in _call('POST', '/names/resolve', {'names': queries})['named']]


def _resolved(named):
    plugin = named['plugin'] or {'name': None, 'origin': None}
    return {'plugin': plugin['name'], 'origin': plugin['origin'], 'form_key': named['formKey'], 'editor_id': named['editorId']}


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


def _plugin(plugin):
    [named] = resolve(plugin)
    if named['plugin'] is None:
        raise MEditError(f'{plugin} is not a plugin.')
    return named['plugin'], named['origin']


def _hops(path):
    return [
        {'kind': 'member', 'name': member} if member else {'kind': 'index', 'index': int(index)}
        for member, index in re.findall(r'([^.\[\]]+)|\[(\d+)\]', path)]


def references(form_key):
    """The records that reference a record, each with its plugin and the field that holds the reference."""
    return [
        {
            'form_key': referrer['formKey'], 'plugin': referrer['plugin'], 'origin': referrer['origin'],
            'field_path': referrer['fieldPath'], 'record_type': referrer['recordType'], 'editor_id': referrer['editorId']}
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
        raise MEditError(json.load(refused).get('detail') or f'mEdit answered {refused.code}.') from None
    except urllib.error.URLError as unreachable:
        raise MEditError(f'mEdit does not answer on port {port}: {unreachable.reason}') from None
