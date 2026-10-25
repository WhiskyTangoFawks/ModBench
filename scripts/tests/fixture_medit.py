import contextlib
import http.server
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from collections.abc import Generator
from typing import Any, NamedTuple
from unittest import mock
from urllib.parse import urlparse

from medit import JsonRecord, Plugin

REPO = pathlib.Path(__file__).resolve().parents[2]
HTTP_PROJECT = REPO / 'MEditService' / 'MEditService.Http'
INSTANCE = REPO / 'DevListFallout'
CONDITIONS = Plugin('MBDevConditions.esp', 'MB-DEV Conditions')
LIGHT = Plugin('MBDevLight.esl', 'MB-DEV Light')
CONFLICT_A = Plugin('MBDevConflictA.esp', 'MB-DEV Conflict A')
CONFLICT_B = Plugin('MBDevConflictB.esp', 'MB-DEV Conflict B')
EMPTY_MOD = 'MB-DEV Scratch'
OVERWRITE = 'overwrite/'
# DevListFallout's plugins.txt in its order, each enabled.
PLUGINS = [
    Plugin('MBDevFixes.esm', 'MB-DEV Fixes'), Plugin('MBDevFixesAddon.esp', 'MB-DEV Fixes Addon'), CONFLICT_A, CONFLICT_B,
    LIGHT, CONDITIONS, Plugin('MBDevMissingMaster.esp', 'MB-DEV Missing Master'), Plugin('MBDevPatchAB.esp', 'MB-DEV Patch A+B')]
RECIPE = '000800:MBDevConditions.esp'
RECIPE_FILE = 'MBDevConditionedRecipe - *.json'
LIGHT_RECORD = '000800:MBDevLight.esl'
CONFLICTED_RECORD = '004822:Fallout4.esm'
BOOT_TIMEOUT_S = 180
LOAD_ORDER_TIMEOUT_S = 120
REQUEST_TIMEOUT_S = 10
STOP_GRACE_S = 5
POLL_S = 0.1


class Fixture(NamedTuple):
    url: str
    instance: pathlib.Path
    load_order: JsonRecord


def committable(folder: pathlib.Path) -> list[str]:
    in_a_repository = subprocess.run(
        ['git', 'rev-parse', '--is-inside-work-tree'], cwd=folder, capture_output=True, check=False).returncode == 0
    if in_a_repository:
        return subprocess.run(
            ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=folder, capture_output=True, encoding='utf-8', check=True).stdout.split('\0')[:-1]
    # The Windows VM runs the gates on a copy of what git would commit, and the copy has no repository to ask.
    return sorted(path.relative_to(folder).as_posix() for path in folder.rglob('*') if path.is_file())


def copy_committable(source: pathlib.Path, destination: pathlib.Path) -> None:
    for relative in committable(source):
        copy = destination / relative
        copy.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, copy)


@contextlib.contextmanager
def fixture_medit() -> Generator[Fixture]:
    executable = built_medit()
    with tempfile.TemporaryDirectory() as temporary:
        scratch = pathlib.Path(temporary)
        instance = scratch / 'instance'
        copy_committable(INSTANCE, instance)
        (instance / 'overwrite').mkdir()
        # DevListFallout has no game folder; an empty one stands in, so the game loads no plugin of its own.
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


def stop(process: subprocess.Popen[bytes]) -> None:
    process.terminate()
    try:
        process.wait(timeout=STOP_GRACE_S)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def built_medit() -> str:
    build = subprocess.run(
        ['dotnet', 'build', str(HTTP_PROJECT), '-nologo', '-v', 'quiet', '-t:Build', '-getProperty:TargetPath'],
        check=False, capture_output=True, text=True)
    if build.returncode != 0:
        raise RuntimeError(f'mEdit did not build:\n{build.stdout}{build.stderr}')
    return build.stdout.strip()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def await_health(process: subprocess.Popen[bytes], url: str, output: pathlib.Path) -> None:
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


def snapshot(instance: pathlib.Path, game: pathlib.Path) -> JsonRecord:
    return {
        'plugins': [plugin_entry(instance, plugin, line) for line, plugin in enumerate(PLUGINS)],
        'active': [plugin._asdict() for plugin in PLUGINS],
        'loadedWithNoLine': [],
        'archives': [],
        'stringsFiles': [],
        'places': places(instance),
        'mods': [],
        'statCache': str(instance / 'stat-cache'),
        'dataFolder': str(game),
        'instanceRoot': str(instance),
        'gameRelease': 'Fallout4',
        'stringsLanguage': 'English',
    }


def places(instance: pathlib.Path) -> list[JsonRecord]:
    mods = [*dict.fromkeys(plugin.origin for plugin in PLUGINS), EMPTY_MOD]
    return [
        *({'name': mod, 'folder': str(instance / 'mods' / mod), 'sourceFolder': str(source_folder(instance, mod))} for mod in mods),
        {'name': OVERWRITE, 'folder': str(instance / 'overwrite')}]


def plugin_entry(instance: pathlib.Path, plugin: Plugin, line: int | None) -> JsonRecord:
    folder = instance / 'mods' / plugin.origin
    return {
        'name': plugin.name, 'path': str(folder / plugin.name), 'origin': plugin.origin,
        'provider': {
            'kind': 'Mod', 'mod': plugin.origin, 'folder': str(folder),
            'sourceFolder': str(source_folder(instance, plugin.origin))},
        'line': line, 'lineNamesIt': line is not None, 'archives': [], 'stringsFiles': [],
    }


def source_folder(instance: pathlib.Path, mod: str) -> pathlib.Path:
    return instance / 'source' / mod


def decompile_and_commit_mod(fixture: Fixture, mod: str) -> None:
    call('POST', fixture.url + '/decompile-and-commit', {'mods': [
        {'name': mod, 'sourceFolder': str(source_folder(fixture.instance, mod)), 'installationFiles': [], 'metadataFiles': []}]})


def watcher_resends_load_order(fixture: Fixture, *created: Plugin) -> None:
    """Modbench's watcher, which sends the load order again once the instance changed; a created plugin joins it with no line."""
    plugins = fixture.load_order['plugins'] + [plugin_entry(fixture.instance, plugin, None) for plugin in created]
    call('PUT', fixture.url + '/load-order', {**fixture.load_order, 'plugins': plugins})


@contextlib.contextmanager
def holding_unsaved(fixture: Fixture, path: pathlib.Path) -> Generator[None]:
    call('PUT', fixture.url + '/unsaved-documents', {'documents': [{'path': str(path), 'text': path.read_text() + ' '}]})
    try:
        yield
    finally:
        call('PUT', fixture.url + '/unsaved-documents', {'documents': []})


def hand_load_order(url: str, body: JsonRecord) -> None:
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


def within(deadline: float) -> float:
    return max(POLL_S, min(REQUEST_TIMEOUT_S, deadline - time.monotonic()))


def call(method: str, url: str, body: JsonRecord | None = None, timeout: float = REQUEST_TIMEOUT_S) -> Any:
    request = urllib.request.Request(
        url, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        answer = response.read()
    return json.loads(answer) if answer else None


@contextlib.contextmanager
def window_of(url: str) -> Generator[None]:
    with mock.patch.dict(os.environ, {'MEDIT_PORT': str(urlparse(url).port)}):
        yield


@contextlib.contextmanager
def medit_answering(status: int, body: object, put_delay_s: float = 0) -> Generator[str]:
    payload = body if isinstance(body, bytes) else json.dumps(body).encode()
    stopped = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.answer()

        def do_POST(self) -> None:
            self.rfile.read(int(self.headers['Content-Length']))
            self.answer()

        def do_PUT(self) -> None:
            self.rfile.read(int(self.headers['Content-Length']))
            if not stopped.wait(put_delay_s):
                self.answer()

        def answer(self) -> None:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        stopped.set()
        server.shutdown()
        server.server_close()


class FileStamp(NamedTuple):
    path: str
    size: int
    modified_ns: int


def file_stamps(folder: pathlib.Path) -> list[FileStamp]:
    return sorted(
        FileStamp(relative, (folder / relative).stat().st_size, (folder / relative).stat().st_mtime_ns)
        for relative in committable(folder))


def changed(folder: pathlib.Path) -> list[str]:
    return subprocess.run(
        ['git', 'status', '--porcelain', '-z'], cwd=folder, capture_output=True, encoding='utf-8', check=True).stdout.split('\0')[:-1]
