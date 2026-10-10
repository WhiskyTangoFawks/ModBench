#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/vm.sh" sync
exec "$HERE/vm.sh" ssh 'Set-Location C:\work\modbench; & .claude/skills/windows-vm/gates.ps1'
