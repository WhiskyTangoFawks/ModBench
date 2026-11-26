#!/usr/bin/env python3
"""Reads changed repo paths on stdin and prints each gate they can break, one `<flag> <path>` line
per gate, naming the first path that selected it. Gate 1 runs on every invocation, so a path that
selects no gate is still checked."""
import re
import sys

API_TS = 'modbench/src/wire/generated/api.ts'
TEST_PROJECT_RE = re.compile(r'MEditService/(?:[^/]+\.Tests|MEditService\.TestSupport)/')


def gates(path: str) -> list[str]:
    if path.startswith(('docs/', 'spec/')):
        return ['--docs']
    if path.endswith('.md'):
        return []
    if TEST_PROJECT_RE.match(path):
        # No production box references a test project, so nothing beyond the backend reaches one.
        return ['--backend']
    if path.startswith('MEditService/'):
        # The client reaches Http through the wire, and Http references every mEdit box.
        return ['--backend', '--api-drift', '--frontend']
    if path.startswith('scripts/'):
        return ['--scripts']
    if path == API_TS:
        return ['--scripts', '--frontend']
    if path.startswith('modbench/'):
        return ['--frontend']
    return []


def main(stdin=None):
    stdin = sys.stdin if stdin is None else stdin
    reasons = {}
    for path in [line.strip() for line in stdin if line.strip()]:
        for gate in gates(path):
            reasons.setdefault(gate, path)
    for gate, path in reasons.items():
        print(gate, path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
