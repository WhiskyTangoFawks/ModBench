import json
import os
import urllib.error
import urllib.request


class MEditError(Exception):
    pass


def select(sql):
    """The rows of one SQL SELECT over the record views, each a dict of its columns."""
    return _post('/records/select', {'sql': sql})['rows']


def _post(path, body):
    port = os.environ.get('MEDIT_PORT')
    if port is None:
        raise MEditError('This script has no mEdit to reach: run it in a terminal of a Modbench window.')
    request = urllib.request.Request(
        f'http://localhost:{port}{path}', method='POST', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as refused:
        raise MEditError(json.load(refused).get('detail') or f'mEdit answered {refused.code}.') from None
    except urllib.error.URLError as unreachable:
        raise MEditError(f'mEdit does not answer on port {port}: {unreachable.reason}') from None
