#!/usr/bin/env bash
# A throwaway Modbench instance, headless: up [instance] | call <dir> <tool> [json] | tools <dir> | down <dir> | seed
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
state="${MODBENCH_ACCEPT_HOME:-$HOME/.local/share/modbench-accept}"
seed="$state/seed"
mkdir -p "$state"

live_runs() {
  for d in /tmp/modbench-accept.*; do
    [ -f "$d/xvfb.pid" ] && kill -0 "$(cat "$d/xvfb.pid")" 2>/dev/null && echo "$d"
  done
  return 0
}

free_port() { python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }

free_display() {
  local n=120
  while [ -e "/tmp/.X11-unix/X$n" ] || [ -e "/tmp/.X$n-lock" ]; do n=$((n + 1)); done
  echo "$n"
}

ready() { python3 -I "$here/mcp.py" "$1" call select_rows '{"sql":"SELECT 1 AS one"}' >/dev/null 2>&1; }

up() {
  local others; others="$(live_runs)"
  [ -n "$others" ] && { echo "refused: a run is already up: $others" >&2; exit 1; }
  [ -f "$root/modbench/out/extension.js" ] && [ -x "$root/modbench/backend/MEditService.Http" ] || {
    echo "refused: build first, in modbench/ through slot-run: npm run build, npm run build:backend" >&2; exit 1; }

  local source="${1:-}" dir port display instance
  dir="$(mktemp -d /tmp/modbench-accept.XXXX)"
  instance="$dir/instance"
  if [ -n "$source" ]; then cp -a "$source" "$instance"
  else mkdir -p "$instance" && (cd "$root/DevListFallout" && git ls-files -z | xargs -0 cp --parents -t "$instance")
  fi
  mkdir -p "$instance/.vscode" "$instance/modbench" "$dir/user/User" "$dir/ext"
  if [ ! -f "$instance/modbench/index.duckdb" ] && [ -f "$seed/index.duckdb" ]; then cp "$seed"/index.duckdb* "$instance/modbench/"; fi

  port="$(free_port)"
  echo "$port" > "$dir/port"
  printf '{"modbench.agent.port": %s}\n' "$port" > "$instance/.vscode/settings.json"
  # Modbench loads nothing in Restricted Mode, and a headless window cannot answer the trust prompt.
  printf '{"security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none"}\n' \
    > "$dir/user/User/settings.json"

  display="$(free_display)"
  Xvfb ":$display" -screen 0 1280x1024x24 -nolisten tcp >/dev/null 2>&1 &
  echo $! > "$dir/xvfb.pid"
  # Electron leaves Xvfb for the desktop's compositor while a Wayland session is in its environment.
  # Git refuses a file:// submodule remote by default; a fixture's remote is a bare repository on disk.
  env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE DISPLAY=":$display" \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.file.allow GIT_CONFIG_VALUE_0=always setsid code \
    --extensionDevelopmentPath="$root/modbench" --user-data-dir "$dir/user" --extensions-dir "$dir/ext" \
    --disable-workspace-trust "$instance" > "$dir/code.log" 2>&1 &

  local waited=0
  until python3 -I "$here/mcp.py" "$port" tools >/dev/null 2>&1; do
    sleep 2; waited=$((waited + 2))
    [ "$waited" -ge 120 ] && { echo "MCP did not answer in 120s; see $dir/code.log" >&2; down "$dir"; exit 1; }
  done
  until ready "$port"; do
    sleep 5; waited=$((waited + 5))
    [ "$waited" -ge 900 ] && { echo "the index was not ready in 900s" >&2; down "$dir"; exit 1; }
  done
  echo "DIR=$dir PORT=$port ready after ${waited}s"
}

down() {
  local dir="$1" keep="${2:-}"
  case "$dir" in /tmp/modbench-accept.*) ;; *) echo "refused: not a run folder: $dir" >&2; exit 1;; esac
  # The backend's command line does not name the folder; its open files do.
  local pids="" self=" $$ $PPID "
  for p in $(ls /proc | grep -E '^[0-9]+$'); do
    case "$self" in *" $p "*) continue;; esac
    if tr '\0' ' ' 2>/dev/null < "/proc/$p/cmdline" | grep -qF "$dir/" || ls -l "/proc/$p/fd" 2>/dev/null | grep -qF "$dir/"; then
      tr '\0' ' ' 2>/dev/null < "/proc/$p/cmdline" | grep -q "accept.sh" || pids="$pids $p"
    fi
  done
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 3
  for p in $pids; do [ -d "/proc/$p" ] && kill -9 "$p" 2>/dev/null || true; done
  [ -f "$dir/xvfb.pid" ] && kill "$(cat "$dir/xvfb.pid")" 2>/dev/null || true
  if [ "$keep" = "--keep-seed" ]; then
    mkdir -p "$seed" && rm -f "$seed"/index.duckdb* && cp "$dir"/instance/modbench/index.duckdb* "$seed/"
  fi
  rm -rf "$dir"
  echo "down: $dir"
}

port_of() { cat "$1/port"; }

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down "$2" "${3:-}" ;;
  tools) python3 -I "$here/mcp.py" "$(port_of "$2")" tools ;;
  call) python3 -I "$here/mcp.py" "$(port_of "$2")" call "$3" "${4:-{\}}" ;;
  seed)
    rm -rf "$seed"
    line="$(up | tail -1)"; dir="${line#DIR=}"; dir="${dir%% *}"
    down "$dir" --keep-seed
    echo "seeded: $seed" ;;
  *) echo "usage: accept.sh up [instance] | call <dir> <tool> [json] | tools <dir> | down <dir> | seed" >&2; exit 2 ;;
esac
