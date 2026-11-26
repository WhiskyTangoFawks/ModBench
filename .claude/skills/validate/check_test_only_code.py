#!/usr/bin/env python3
"""Names each production member that no production code names but a test project does: a type, method,
property or field declared public, internal or protected, found by its name in the source text, so a
name shared with other code is never named, nor a type with a base list. It over-reports where nothing
names a member in text: an extension method's class, a framework interface's implementation. Reports only:
exit 0."""
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

FAILS_THE_RUN = False
TEST_SIDE = {'Tests', 'TestSupport'}
BUILD_FOLDERS = {'bin', 'obj'}
COMMENT = re.compile(r'//[^\n]*|/\*.*?\*/', re.DOTALL)
IDENTIFIER = re.compile(r'(?<![\w@])[A-Za-z_]\w*')
MODIFIERS = r'(?:(?:public|internal|protected|static|virtual|abstract|sealed|async|readonly|new|required|partial|unsafe|extern|override) +)+'
DECLARATION = re.compile(
    r'^[ \t]*(?:\[[^\]\n]*\] *)*(?P<modifiers>' + MODIFIERS + r')'
    r'(?:(?:class|record(?: struct)?|struct|interface|enum) +(?P<type>[A-Za-z_]\w*)\b(?! *(?:<[^>\n]*>)? *(?:\([^)\n]*\))? *:)'
    r'|(?!(?:public|internal|protected|static|virtual|abstract|sealed|async|readonly|new|required|partial|unsafe|extern|override|class|record|struct|interface|enum)\b)[\w<>\[\],.?() ]+? +(?P<member>[A-Za-z_]\w*) *(?:<[^>\n]*>)? *(?:\(|\{|=>|=|;))', re.MULTILINE)


@dataclass
class Member:
    name: str
    files: list[str]


def is_test_side(project: str) -> bool:
    return bool(TEST_SIDE.intersection(project.split('.')))


def sources(root: Path) -> dict[str, tuple[bool, str]]:
    """Comments go and strings stay: an interpolated string holds code."""
    return {file.relative_to(root).as_posix(): (is_test_side(project.name), COMMENT.sub(' ', file.read_text(errors='replace')))
            for project in sorted(root.iterdir()) if (project / f'{project.name}.csproj').is_file()
            for file in project.rglob('*.cs') if not BUILD_FOLDERS.intersection(file.relative_to(project).parts)}


def test_only_members(root: Path) -> list[Member]:
    files = sources(root)
    names = {False: Counter(), True: Counter()}
    declared: dict[str, list[str]] = {}
    for path, (test_side, text) in files.items():
        names[test_side].update(IDENTIFIER.findall(text))
        if test_side:
            continue
        for declaration in DECLARATION.finditer(text):
            name = declaration['type'] or declaration['member']
            if 'override' not in declaration['modifiers']:
                declared.setdefault(name, []).append(path)
    return [Member(name, sorted(set(paths))) for name, paths in sorted(declared.items())
            if names[False][name] == len(paths) and names[True][name]]


def main(argv: list[str] | None = None) -> int:
    members = test_only_members(Path((sys.argv[1:] if argv is None else argv)[0]))
    for member in members:
        print(f'{member.name}  {", ".join(member.files)}')
    print(f'--- {len(members)} MEMBERS ONLY TESTS REACH ---')
    return int(FAILS_THE_RUN and bool(members))


if __name__ == '__main__':
    sys.exit(main())
