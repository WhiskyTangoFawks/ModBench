import collections
import contextlib
import json
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

REPO = pathlib.Path(__file__).resolve().parents[2]
HTTP_PROJECT = REPO / 'MEditService' / 'MEditService.Http'
INSTANCE = REPO / 'DevList'
# DevList's plugins.txt in its order, each enabled, with the mod that provides it.
PLUGINS = [
    ('MBDevConflictB.esp', 'MB-DEV Conflict B'),
    ('MBDevConflictA.esp', 'MB-DEV Conflict A'),
    ('MBDevLight.esl', 'MB-DEV Light'),
    ('MBDevConditions.esp', 'MB-DEV Conditions'),
    ('MBDevMissingMaster.esp', 'MB-DEV Missing Master'),
]
BOOT_TIMEOUT_S = 180
LOAD_ORDER_TIMEOUT_S = 120
REQUEST_TIMEOUT_S = 10
STOP_GRACE_S = 5
POLL_S = 0.1

Fixture = collections.namedtuple('Fixture', 'url instance load_order')


@contextlib.contextmanager
def fixture_medit():
    executable = built_medit()
    with tempfile.TemporaryDirectory() as scratch:
        scratch = pathlib.Path(scratch)
        instance = scratch / 'instance'
        shutil.copytree(INSTANCE, instance)
        # DevList has no game folder; an empty one stands in, so the game loads no plugin of its own.
        game = scratch / 'game'
        game.mkdir()
        url = f'http://127.0.0.1:{free_port()}'
        output = scratch / 'output.log'
        with output.open('wb') as sink:
            process = subprocess.Popen(
                ['dotnet', executable, '--urls', url, '--LogDirectory', str(scratch / 'logs')],
                stdout=sink, stderr=subprocess.STDOUT)
            try:
                await_health(process, url, output)
                load_order = snapshot(instance, game)
                hand_load_order(url, load_order)
                yield Fixture(url, instance, load_order)
            finally:
                stop(process)


def stop(process):
    process.terminate()
    try:
        process.wait(timeout=STOP_GRACE_S)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def built_medit():
    build = subprocess.run(
        ['dotnet', 'build', str(HTTP_PROJECT), '-nologo', '-v', 'quiet', '-t:Build', '-getProperty:TargetPath'],
        capture_output=True, text=True)
    if build.returncode != 0:
        raise RuntimeError(f'mEdit did not build:\n{build.stdout}{build.stderr}')
    return build.stdout.strip()


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def await_health(process, url, output):
    deadline = time.monotonic() + BOOT_TIMEOUT_S
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f'mEdit exited before it answered /health:\n{output.read_text(errors="replace")}')
        try:
            call('GET', url + '/health', timeout=within(deadline))
            return
        except OSError:
            time.sleep(POLL_S)
    raise TimeoutError(f'mEdit did not answer /health within {BOOT_TIMEOUT_S}s:\n{output.read_text(errors="replace")}')


def snapshot(instance, game):
    plugins = []
    for line, (name, mod) in enumerate(PLUGINS):
        folder = instance / 'mods' / mod
        plugins.append({
            'name': name, 'path': str(folder / name), 'origin': mod,
            'provider': {'kind': 'Mod', 'mod': mod, 'folder': str(folder), 'sourceFolder': str(source_folder(instance, mod))},
            'line': line, 'lineNamesIt': True, 'archives': [], 'stringsFiles': [],
        })
    return {
        'plugins': plugins,
        'active': [{'name': name, 'origin': mod} for name, mod in PLUGINS],
        'loadedWithNoLine': [],
        'archives': [],
        'stringsFiles': [],
        'gameDirectory': str(game),
        'instanceRoot': str(instance),
        'gameRelease': 'Fallout4',
    }


def source_folder(instance, mod):
    return instance / 'source' / mod


def track(fixture, mod):
    call('POST', fixture.url + '/init', {'mods': [
        {'name': mod, 'sourceFolder': str(source_folder(fixture.instance, mod)), 'installationFiles': [], 'modManagerFiles': []}]})


def watcher_resends_load_order(fixture):
    call('PUT', fixture.url + '/load-order', fixture.load_order)


def hand_load_order(url, body):
    deadline = time.monotonic() + LOAD_ORDER_TIMEOUT_S
    version = call('PUT', url + '/load-order', body, timeout=deadline - time.monotonic())['version']
    while time.monotonic() < deadline:
        status = call('GET', url + '/load-order/status', timeout=within(deadline))
        if status['version'] >= version and status['state'] not in ('None', 'Reconciling'):
            if status['state'] != 'Ready':
                raise RuntimeError(f'mEdit did not take the load order: {status}')
            return
        time.sleep(POLL_S)
    raise TimeoutError(f'mEdit did not index the load order within {LOAD_ORDER_TIMEOUT_S}s')


def within(deadline):
    return max(POLL_S, min(REQUEST_TIMEOUT_S, deadline - time.monotonic()))


def call(method, url, body=None, timeout=REQUEST_TIMEOUT_S):
    request = urllib.request.Request(
        url, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        answer = response.read()
    return json.loads(answer) if answer else None
