import json
import os
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
    [named] = resolve(plugin)
    if named['plugin'] is None:
        raise MEditError(f'{plugin} is not a plugin.')
    name, origin = named['plugin'], named['origin']
    document = _call('GET', f'/plugins/{_quoted(name)}/records/{_quoted(form_key)}/rendered-document?origin={_quoted(origin)}')
    return json.loads(document['text'])


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
            return json.load(response)
    except urllib.error.HTTPError as refused:
        raise MEditError(json.load(refused).get('detail') or f'mEdit answered {refused.code}.') from None
    except urllib.error.URLError as unreachable:
        raise MEditError(f'mEdit does not answer on port {port}: {unreachable.reason}') from None
