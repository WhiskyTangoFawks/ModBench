#!/usr/bin/env python3
"""Reads changed repo paths on stdin and prints each gate they can break, one `<flag> <path>` line
per gate, naming the first path that selected it. Gate 1 runs on every invocation, so a path that
selects no gate is still checked."""
import sys


def gates(path):
    if path == 'CONTEXT.md' or path.startswith('docs/'):
        return ['--docs']
    if path.endswith('.md'):
        return []
    if path.startswith('MEditService/'):
        return ['--backend', '--api-drift']
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
