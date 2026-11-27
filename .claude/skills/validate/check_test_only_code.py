#!/usr/bin/env python3
"""Names each production member that no production code names but a test project uses: a type, method,
property or field declared public, internal or protected, found by its name in the source text, so a
name shared with other code is never named. A static class is reached through its members, and reflection
may find a type whose base production tests assignability to, so neither is named. It over-reports a
framework interface's implementation that a test calls. Exits 1 when it names any member."""
import re
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

TEST_SIDE = {'Tests', 'TestSupport'}
BUILD_FOLDERS = {'bin', 'obj'}
COMMENT = re.compile(r'//[^\n]*|/\*.*?\*/', re.DOTALL)
IDENTIFIER = re.compile(r'(?<![\w@])[A-Za-z_]\w*')
MODIFIER_WORDS = 'public|internal|protected|static|virtual|abstract|sealed|async|readonly|new|required|partial|unsafe|extern|override'
TYPE_WORDS = 'class|record|struct|interface|enum'
MODIFIERS = rf'(?:(?:{MODIFIER_WORDS}) +)+'
NOT_A_TYPE_HEAD = rf'(?!(?:{MODIFIER_WORDS}|{TYPE_WORDS})\b)'
DECLARATION = re.compile(
    r'^[ \t]*(?:\[[^\]\n]*\] *)*(?P<modifiers>' + MODIFIERS + r')'
    r'(?:(?:class|record(?: struct)?|struct|interface|enum) +(?P<type>[A-Za-z_]\w*)\b(?: *(?:<[^>\n]*>)? *(?:\([^)\n]*\))? *:(?P<bases>[^{\n]*))?'
    r'|' + NOT_A_TYPE_HEAD + r'[\w<>\[\],.?() ]+? +(?P<member>[A-Za-z_]\w*) *(?:<[^>\n]*>)? *(?:\(|\{|=>|=|;))', re.MULTILINE)
ASSIGNABLE_TO = re.compile(r'\btypeof\( *([A-Za-z_]\w*) *\)\.IsAssignableFrom\b|\bIsAssignableTo\( *typeof\( *([A-Za-z_]\w*)')


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


def is_reached_without_its_name(declaration: re.Match[str], reflected: set[str]) -> bool:
    modifiers = declaration['modifiers'].split()
    if 'override' in modifiers:
        return True
    return bool(declaration['type']) and (
        'static' in modifiers or bool(reflected.intersection(IDENTIFIER.findall(declaration['bases'] or ''))))


def test_only_members(root: Path) -> list[Member]:
    files = sources(root)
    reflected = {name for test_side, text in files.values() if not test_side
                 for found in ASSIGNABLE_TO.findall(text) for name in found if name}
    names = {False: Counter(), True: Counter()}
    declared: dict[str, list[str]] = {}
    for path, (test_side, text) in files.items():
        names[test_side].update(IDENTIFIER.findall(text))
        for declaration in DECLARATION.finditer(text):
            name = declaration['type'] or declaration['member']
            if test_side:
                names[True][name] -= 1
            elif not is_reached_without_its_name(declaration, reflected):
                declared.setdefault(name, []).append(path)
    return [Member(name, sorted(set(paths))) for name, paths in sorted(declared.items())
            if names[False][name] == len(paths) and names[True][name] > 0]


def main(argv: list[str] | None = None) -> int:
    members = test_only_members(Path((sys.argv[1:] if argv is None else argv)[0]))
    for member in members:
        print(f'{member.name}  {", ".join(member.files)}')
    print(f'--- {len(members)} MEMBERS ONLY TESTS REACH ---')
    return int(bool(members))


if __name__ == '__main__':
    sys.exit(main())
