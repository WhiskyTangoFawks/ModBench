#!/usr/bin/env python3
"""Reads changed repo paths on stdin and prints the backend test projects they can break: each
test project that references a changed project, directly or through other projects. A file a
csproj links from another project counts as a reference. A changed path under MEditService/ but
outside every project selects every test project. Writes the selection as a solution filter for
`dotnet test`."""
import json
import re
import sys
from pathlib import Path

REFERENCE_RE = re.compile(r'Include="\.\.[\\/](?P<project>[^\\/"]+)[\\/]')
TEST_SDK = 'Microsoft.NET.Test.Sdk'
SERVICE = 'MEditService/'


def load_projects(service: Path):
    references, tests = {}, []
    for path in sorted(service.glob('*/*.csproj')):
        text = path.read_text()
        references[path.parent.name] = set(REFERENCE_RE.findall(text))
        if TEST_SDK in text:
            tests.append(path.parent.name)
    return references, tests


def select(service: Path, changed):
    references, tests = load_projects(service)
    changed_projects = set()
    for path in changed:
        if not path.startswith(SERVICE) or path.endswith('.md'):
            continue
        project = path[len(SERVICE):].split('/')[0]
        if project not in references:
            return tests
        changed_projects.add(project)

    def reached_from(name):
        reached, todo = set(), [name]
        while todo:
            project = todo.pop()
            if project not in reached:
                reached.add(project)
                todo.extend(references.get(project, ()))
        return reached

    return [name for name in tests if reached_from(name) & changed_projects]


def main(argv=None, stdin=None):
    argv = sys.argv[1:] if argv is None else argv
    stdin = sys.stdin if stdin is None else stdin
    service, slnf = Path(argv[0]).resolve(), Path(argv[1])
    selected = select(service, [line.strip() for line in stdin if line.strip()])
    if selected:
        slnf.write_text(json.dumps({'solution': {
            'path': str(service / 'MEditService.sln'),
            'projects': [f'{name}/{name}.csproj' for name in selected],
        }}))
    for name in selected:
        print(name)
    return 0


if __name__ == '__main__':
    sys.exit(main())
