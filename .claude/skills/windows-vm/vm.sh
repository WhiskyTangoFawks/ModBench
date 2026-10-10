#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export VM_HOME="${MODBENCH_WINDOWS_HOME:-$HOME/.local/share/modbench-windows}"
KEY="$VM_HOME/id_ed25519"
STAGE='C:\work\stage'
WORK='C:\work\modbench'
COMPOSE=(docker compose -f "$HERE/compose.yml")
SSH_OPTS=(-i "$KEY" -o UserKnownHostsFile="$VM_HOME/known_hosts" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5)

case "${1:-}" in
  up)
    mkdir -p "$VM_HOME/disk" "$VM_HOME/oem"
    [[ -f $KEY ]] || ssh-keygen -q -t ed25519 -N '' -C modbench-windows -f "$KEY"
    cp "$HERE"/oem/* "$VM_HOME/oem/"
    cp "$KEY.pub" "$VM_HOME/oem/authorized_keys"
    "${COMPOSE[@]}" up -d
    ;;
  down) "${COMPOSE[@]}" down ;;
  logs) "${COMPOSE[@]}" logs -f ;;
  screen)
    "${COMPOSE[@]}" exec windows sh -c \
      '(echo screendump /run/shm/screen.png -f png; sleep 2) | nc -U -q 3 /run/shm/monitor.sock >/dev/null && cat /run/shm/screen.png' \
      > "${2:-/tmp/modbench-windows.png}"
    ;;
  sync)
    root="$(git -C "$HERE" rev-parse --show-toplevel)"
    (cd "$root" && git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do if [[ -f $f ]]; then printf '%s\0' "$f"; fi; done | tar --format=pax --null -cf - -T -) \
      | "$0" ssh "Remove-Item -Recurse -Force $STAGE -ErrorAction SilentlyContinue; New-Item -ItemType Directory $STAGE | Out-Null; tar -xf - -C $STAGE"
    # Mirroring keeps the excluded folders, so dependencies and build output survive between runs.
    exec "$0" ssh "robocopy $STAGE $WORK /MIR /XD node_modules bin obj out .vscode-test backend /NFL /NDL /NJH /NJS /NP | Out-Null; exit [int](\$LASTEXITCODE -ge 8)"
    ;;
  ssh)
    shift
    exec ssh "${SSH_OPTS[@]}" -p 2222 modbench@127.0.0.1 "$@"
    ;;
  run)
    script="$2"
    shift 2
    scp -q "${SSH_OPTS[@]}" -P 2222 "$script" modbench@127.0.0.1:C:/Windows/Temp/
    exec ssh "${SSH_OPTS[@]}" -p 2222 modbench@127.0.0.1 \
      powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Windows/Temp/$(basename "$script")" "$@"
    ;;
  *) echo "usage: $0 up|down|logs|screen [png]|sync|ssh [command]|run script.ps1 [args]" >&2; exit 2 ;;
esac
