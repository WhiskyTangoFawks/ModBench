#!/usr/bin/env bash
# A throwaway Modbench instance, headless: up <game|folder> | call <dir> <tool> [json] | tools <dir> | down <dir> | seed <game>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
state="${MODBENCH_ACCEPT_HOME:-$HOME/.local/share/modbench-accept}"
mkdir -p "$state"

games="fallout skyrim starfield"

game_of() { case " $games " in *" $1 "*) echo "$1";; esac; }

usage() {
  echo "usage: accept.sh up <fallout|skyrim|starfield|instance folder> | call <dir> <tool> [json] | tools <dir> | down <dir> | seed <fallout|skyrim|starfield>" >&2
  exit 2
}

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
  local target="${1:-}" dir port display instance game
  [ -n "$target" ] || usage
  game="$(game_of "$target")"
  [ -n "$game" ] || [ -d "$target" ] || { echo "refused: not a game ($games) or an instance folder: $target" >&2; exit 1; }
  local others; others="$(live_runs)"
  [ -n "$others" ] && { echo "refused: a run is already up: $others" >&2; exit 1; }
  [ -f "$root/modbench/out/extension.js" ] && [ -x "$root/modbench/backend/MEditService.Http" ] || {
    echo "refused: build first, in modbench/ through slot-run: npm run build, npm run build:backend" >&2; exit 1; }

  dir="$(mktemp -d /tmp/modbench-accept.XXXX)"
  instance="$dir/instance"
  if [ -n "$game" ]; then
    local fixture; fixture="DevList$(tr '[:lower:]' '[:upper:]' <<< "${game:0:1}")${game:1}"
    mkdir -p "$instance" && (cd "$root/$fixture" && git ls-files -z | xargs -0 cp --parents -t "$instance")
  else cp -a "$target" "$instance"
  fi
  mkdir -p "$instance/.vscode" "$instance/modbench" "$dir/user/User" "$dir/ext"
  if [ ! -f "$instance/modbench/index.duckdb" ] && [ -n "$game" ] && [ -f "$state/seed/$game/index.duckdb" ]; then
    cp "$state/seed/$game"/index.duckdb* "$instance/modbench/"
  fi

  port="$(free_port)"
  echo "$port" > "$dir/port"
  python3 -I -c 'import json, sys
print(json.dumps({"modbench.agent.port": int(sys.argv[1])}))' "$port" > "$instance/.vscode/settings.json"
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

wait_gone() {
  local seconds="$1" p i; shift
  for ((i = 0; i < seconds * 10; i++)); do
    local alive=""
    for p in "$@"; do [ -d "/proc/$p" ] && alive=1; done
    [ -z "$alive" ] && return 0
    sleep 0.1
  done
  return 1
}

down() {
  local dir="$1" keep="${2:-}" seed="$state/seed/${3:-}"
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
  wait_gone 10 $pids || for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
  wait_gone 10 $pids || { echo "still running after SIGKILL:$pids" >&2; exit 1; }
  [ -f "$dir/xvfb.pid" ] && kill "$(cat "$dir/xvfb.pid")" 2>/dev/null || true
  local failed=0
  if [ "$keep" = "--keep-seed" ]; then
    mkdir -p "$seed" && rm -f "$seed"/index.duckdb* && cp "$dir"/instance/modbench/index.duckdb* "$seed/" || {
      failed=1;rm -rf "$seed" || true; echo "seed copy failed; no seed kept for ${seed##*/}" >&2; }
  fi
  rm -rf "$dir"
  echo "down: $dir"
  return "$failed"
}

port_of() { cat "$1/port"; }

case "${1:-}" in
  up) up "${2:-}" ;;
  down) down "${@:2}" ;;
  tools) python3 -I "$here/mcp.py" "$(port_of "$2")" tools ;;
  call) python3 -I "$here/mcp.py" "$(port_of "$2")" call "$3" "${4:-{\}}" ;;
  seed)
    [ -n "$(game_of "${2:-}")" ] || usage
    rm -rf "$state/seed/$2"
    line="$(up "$2" | tail -1)"; dir="${line#DIR=}"; dir="${dir%% *}"
    down "$dir" --keep-seed "$2"
    echo "seeded: $state/seed/$2" ;;
  *) usage ;;
esac
