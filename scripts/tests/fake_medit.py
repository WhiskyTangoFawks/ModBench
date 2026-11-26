import contextlib
import http.server
import json
import os
import pathlib
import re
import socket
import threading
import urllib.parse
from collections.abc import Generator, Iterator
from typing import Any, NamedTuple
from unittest import mock

# The API as the api-drift gate holds it to a backend built from this checkout.
API_TS = pathlib.Path(__file__).resolve().parents[2] / 'modbench' / 'src' / 'wire' / 'generated' / 'api.ts'
SCHEMA_REF = re.compile(r'components\["schemas"\]\["(\w+)"\]')
# medit reaches localhost, where mEdit listens on every loopback address. Windows resolves localhost to ::1 first,
# and tries the next address only after a refused connection has waited 2 s.
LOCALHOST_FAMILY, *_, LOCALHOST_ADDRESS = socket.getaddrinfo('localhost', 0, type=socket.SOCK_STREAM)[0]


class LocalhostServer(http.server.ThreadingHTTPServer):
    address_family = LOCALHOST_FAMILY


class Member(NamedTuple):
    required: bool
    type: str


class Operation(NamedTuple):
    query: frozenset[str]
    request: str | None
    answer: str | None


class Route(NamedTuple):
    method: str
    template: str
    operation: Operation


class Api(NamedTuple):
    routes: list[Route]
    objects: dict[str, dict[str, Member]]
    enums: dict[str, frozenset[str]]


def _blocks(text: str, indent: str) -> Iterator[tuple[str, str]]:
    for block in re.finditer(rf'^{indent}"?([^":\s]+)"?: \{{\n(.*?)^{indent}\}}', text, re.MULTILINE | re.DOTALL):
        yield block[1], block[2]


def _json_type(block: str) -> str | None:
    content = re.search(r'"application/json": (.+);$', block, re.MULTILINE)
    return content[1] if content else None


def _operation(block: str) -> Operation:
    query = re.search(r'^            query\??: \{\n(.*?)^            \};', block, re.MULTILINE | re.DOTALL)
    request = re.search(r'^        requestBody\??: \{\n(.*?)^        \};', block, re.MULTILINE | re.DOTALL)
    answer = re.search(r'^            200: \{\n(.*?)^            \};', block, re.MULTILINE | re.DOTALL)
    return Operation(
        frozenset(re.findall(r'^                (\w+)\??:', query[1], re.MULTILINE) if query else ()),
        _json_type(request[1]) if request else None,
        _json_type(answer[1]) if answer else None)


def _api(text: str) -> Api:
    paths, rest = text.split('export interface components {')
    components, operations = rest.split('export interface operations {')
    operation = {name: _operation(block) for name, block in _blocks(operations, ' ' * 4)}
    return Api(
        sorted(
            (
                Route(method.upper(), template, operation[name])
                for template, block in _blocks(paths, ' ' * 4)
                for method, name in re.findall(r'^        (\w+): operations\["(\w+)"\];$', block, re.MULTILINE)),
            key=lambda route: route.template.count('{')),
        {
            name: {member: Member(not optional, type) for member, optional, type in re.findall(r'^ {12}(\w+)(\??): (.+);$', block, re.MULTILINE)}
            for name, block in _blocks(components, ' ' * 8)},
        {
            name: frozenset(re.findall(r'"([^"]*)"', values))
            for name, values in re.findall(r'^ {8}(\w+): ((?:"[^"]*"(?: \| )?)+);$', components, re.MULTILINE)})


API = _api(API_TS.read_text(encoding='utf-8'))


def _mismatches(value: object, type: str, where: str) -> list[str]:
    ref = SCHEMA_REF.search(type)
    if ref is None or value is None:
        return []
    if isinstance(value, list):
        return [mismatch for at, item in enumerate(value) for mismatch in _mismatches(item, type, f'{where}[{at}]')]
    name = ref[1]
    if name in API.enums:
        # mEdit binds an enum's name in any case, and medit sends them in lower case.
        return [] if str(value).lower() in {member.lower() for member in API.enums[name]} else [f'{where} {value!r} is no {name}']
    members = API.objects[name]
    if not isinstance(value, dict):
        return [f'{where} {value!r} is no {name}']
    return [
        *(f'{where}.{key} is no member of {name}' for key in value if key not in members),
        *(f'{where}.{key} is missing, and {name} requires it' for key, member in members.items() if member.required and key not in value),
        *(mismatch for key, item in value.items() if key in members for mismatch in _mismatches(item, members[key].type, f'{where}.{key}'))]


def _drift_of(value: object, type: str | None, where: str) -> list[str]:
    if type is None:
        return [] if value is None else [f'{where} is JSON where api.ts has none']
    return _mismatches(value, type, where)


def _route(method: str, path: str) -> Route | None:
    return next((
        route for route in API.routes
        if route.method == method and re.fullmatch(re.sub(r'\\\{\w+\\\}', '[^/]+', re.escape(route.template)), path)), None)


class Sent(NamedTuple):
    method: str
    path: str
    body: object


class Reply(NamedTuple):
    body: object
    status: int = 200


def drift(sent: Sent, reply: Reply) -> list[str]:
    """How a request and the answer a test gives it differ from the API, as api.ts holds it."""
    path, _, query = sent.path.partition('?')
    route = _route(sent.method, path)
    if route is None:
        return [f'{sent.method} {path} is no route of api.ts']
    return [
        *(f'{path} takes no query parameter {key}' for key in urllib.parse.parse_qs(query) if key not in route.operation.query),
        *_drift_of(sent.body, route.operation.request, 'the body'),
        *(_drift_of(reply.body, route.operation.answer, 'the answer') if reply.status == 200 and not isinstance(reply.body, bytes) else [])]


@contextlib.contextmanager
def medit_answering(*replies: object) -> Generator[list[Sent]]:
    """An mEdit on the window's port that gives each request the next reply, a Reply or a body answered 200, and
    fails the test on exit for each request or reply that has drifted from the API."""
    sent: list[Sent] = []
    drifted: list[str] = []
    pending = iter(reply if isinstance(reply, Reply) else Reply(reply) for reply in replies)

    class Handler(http.server.BaseHTTPRequestHandler):
        def answer(self) -> None:
            length = int(self.headers.get('Content-Length', 0))
            request = Sent(self.command, self.path, json.loads(self.rfile.read(length)) if length else None)
            sent.append(request)
            reply = next(pending, None)
            if reply is None:
                past_the_last = f'{request.method} {request.path} came after the last reply'
                drifted.append(past_the_last)
                reply = Reply({'detail': past_the_last}, 500)
            drifted.extend(drift(request, reply))
            payload = (
                reply.body if isinstance(reply.body, bytes) else b'' if reply.body is None else json.dumps(reply.body).encode())
            self.send_response(reply.status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = answer

        def log_message(self, format: str, *args: Any) -> None:
            pass

    with LocalhostServer((str(LOCALHOST_ADDRESS[0]), 0), Handler) as server:
        threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True).start()
        try:
            with mock.patch.dict(os.environ, {'MEDIT_PORT': str(server.server_port)}):
                yield sent
        finally:
            server.shutdown()
    if drifted:
        raise AssertionError('\n'.join(drifted))
