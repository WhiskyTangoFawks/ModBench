#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
export VM_HOME="${MODBENCH_WINDOWS_HOME:-$HOME/.local/share/modbench-windows}"
KEY="$VM_HOME/id_ed25519"
STAGE='C:\work\stage'
WORK='C:\work\modbench'
FEED='C:\work\mutagen-feed'
COMPOSE=(docker compose -f "$HERE/compose.yml")
SSH_OPTS=(-i "$KEY" -o UserKnownHostsFile="$VM_HOME/known_hosts" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5)

case "${1:-}" in
  up)
    mkdir -p "$VM_HOME/disk" "$VM_HOME/oem"
    [[ -f $KEY ]] || ssh-keygen -q -t ed25519 -N '' -C modbench-windows -f "$KEY"
    cp "$HERE"/oem/* "$VM_HOME/oem/"
    cp "$KEY.pub" "$VM_HOME/oem/authorized_keys"
    # A Windows installed afresh answers SSH with a host key of its own.
    [[ -f $VM_HOME/disk/data.img ]] || rm -f "$VM_HOME/known_hosts"
    "${COMPOSE[@]}" up -d
    deadline=$((SECONDS + 5400))
    until "$HERE/vm.sh" ssh -o BatchMode=yes exit 2>/dev/null; do
      (( SECONDS < deadline )) || { echo "No SSH after 90 minutes; vm.sh screen shows where the install stopped." >&2; exit 1; }
      sleep 30
    done
    exec "$HERE/vm.sh" run "$HERE/provision.ps1"
    ;;
  down) "${COMPOSE[@]}" down ;;
  logs) "${COMPOSE[@]}" logs -f ;;
  screen)
    "${COMPOSE[@]}" exec windows sh -c \
      '(echo screendump /run/shm/screen.png -f png; sleep 2) | nc -U -q 3 /run/shm/monitor.sock >/dev/null && cat /run/shm/screen.png' \
      > "${2:-/tmp/modbench-windows.png}"
    ;;
  sync)
    feed="$(sed -n 's/.*key="modbench-stack" value="\([^"]*\)".*/\1/p' "$HOME/.nuget/NuGet/NuGet.Config")"
    [[ -d $feed ]] || { echo "No modbench-stack feed: declare it with dotnet nuget add source <folder> -n modbench-stack." >&2; exit 1; }
    tar -C "$feed" -cf - . \
      | "$HERE/vm.sh" ssh "New-Item -ItemType Directory -Force $FEED | Out-Null; tar -xf - -C $FEED; dotnet nuget remove source modbench-stack *> \$null; dotnet nuget add source $FEED -n modbench-stack | Out-Null"
    root="$(git -C "$HERE" rev-parse --show-toplevel)"
    (cd "$root" && git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do if [[ -f $f ]]; then printf '%s\0' "$f"; fi; done | tar --format=pax --null -cf - -T -) \
      | "$HERE/vm.sh" ssh "Remove-Item -Recurse -Force $STAGE -ErrorAction SilentlyContinue; New-Item -ItemType Directory $STAGE | Out-Null; tar -xf - -C $STAGE"
    # Mirroring keeps the excluded folders, so dependencies and build output survive between runs.
    exec "$HERE/vm.sh" ssh "robocopy $STAGE $WORK /MIR /XD node_modules bin obj out .vscode-test backend /NFL /NDL /NJH /NJS /NP | Out-Null; exit [int](\$LASTEXITCODE -ge 8)"
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
