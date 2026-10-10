#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/vm.sh" ssh -o BatchMode=yes exit 2>/dev/null || { echo "The Windows VM does not answer; start it with vm.sh up." >&2; exit 2; }
"$HERE/vm.sh" sync
exec "$HERE/vm.sh" ssh 'Set-Location C:\work\modbench; & .claude/skills/windows-vm/gates.ps1'
