#!/usr/bin/env python3
"""Reads changed repo paths on stdin and prints the backend test projects they can break: each
test project that includes a changed project's files, directly or through other projects. A
changed path under MEditService/ but outside every project selects every test project. Writes
the selection as a solution filter for `dotnet test`."""
import json
import re
import sys
from pathlib import Path

INCLUDE_RE = re.compile(r'Include="\.\.[\\/](?P<project>[^\\/"]+)[\\/]')
TEST_SDK = 'Microsoft.NET.Test.Sdk'
SERVICE = 'MEditService/'


def load_projects(service: Path):
    """Each project's name mapped to the projects it includes from, and whether it is a test
    project."""
    projects = {}
    for path in service.glob('*/*.csproj'):
        text = path.read_text()
        projects[path.parent.name] = (set(INCLUDE_RE.findall(text)), TEST_SDK in text)
    return projects


def select(service: Path, changed):
    projects = load_projects(service)
    tests = sorted(name for name, (_, is_test) in projects.items() if is_test)
    changed_projects = set()
    for path in changed:
        if not path.startswith(SERVICE) or path.endswith('.md'):
            continue
        project = path[len(SERVICE):].split('/')[0]
        if project not in projects:
            return tests
        changed_projects.add(project)

    def reached_from(name):
        reached, todo = set(), [name]
        while todo:
            project = todo.pop()
            if project not in reached:
                reached.add(project)
                todo.extend(projects.get(project, (set(), False))[0])
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
