# Sourced by a script: `start_own_backend <server command...>` starts the server with
# `--urls http://127.0.0.1:0`, waits for its /health, and sets OWN_BACKEND_URL to it. The caller's
# EXIT, INT, TERM and HUP traps then stop that server's process group and nothing else, because
# concurrent worktrees each run their own backend beside a developer's and a test run's.

OWN_BACKEND_BOOT_TIMEOUT_S=180
OWN_BACKEND_PGID=
OWN_BACKEND_LOG=
OWN_BACKEND_URL=

stop_own_backend() {
  if [[ -n $OWN_BACKEND_PGID ]]; then
    kill -TERM -- "-$OWN_BACKEND_PGID" 2>/dev/null
    for _ in $(seq 1 50); do
      kill -0 -- "-$OWN_BACKEND_PGID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$OWN_BACKEND_PGID" 2>/dev/null
    OWN_BACKEND_PGID=
  fi
  [[ -n $OWN_BACKEND_LOG ]] && rm -f "$OWN_BACKEND_LOG"
}

own_backend_ports() {
  local pids
  pids=$(pgrep -g "$OWN_BACKEND_PGID" | paste -sd '|')
  [[ -n $pids ]] || return 0
  ss -Hltnp 2>/dev/null | grep -E "pid=($pids)," | awk '{ n = split($4, a, ":"); print a[n] }'
}

start_own_backend() {
  # setsid execs in place only when its caller leads no process group. A background job of a
  # shell without job control never does, so there $! is the new group's id.
  if [[ $- == *m* ]]; then
    echo "--- own-backend.sh needs job control off: with it on, setsid forks the backend out of reach. Source it from a script. ---"
    return 1
  fi
  local tool
  for tool in setsid pgrep ss curl; do
    command -v "$tool" >/dev/null \
      || { echo "--- own-backend.sh needs \`$tool\` to start the backend and find its port; install it. ---"; return 1; }
  done

  trap stop_own_backend EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  OWN_BACKEND_LOG="$(mktemp /tmp/own-backend.XXXXXX.log)"
  setsid "$@" --urls http://127.0.0.1:0 >"$OWN_BACKEND_LOG" 2>&1 &
  OWN_BACKEND_PGID=$!

  local port deadline=$((SECONDS + OWN_BACKEND_BOOT_TIMEOUT_S))
  while :; do
    if ! kill -0 "$OWN_BACKEND_PGID" 2>/dev/null; then
      echo "--- backend exited before it answered /health; its output: ---"
      tail -50 "$OWN_BACKEND_LOG"
      return 1
    fi
    for port in $(own_backend_ports); do
      if curl -sf --max-time 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
        OWN_BACKEND_URL="http://127.0.0.1:$port"
        return 0
      fi
    done
    if [[ $SECONDS -ge $deadline ]]; then
      echo "--- backend did not answer /health within ${OWN_BACKEND_BOOT_TIMEOUT_S}s; its output: ---"
      tail -50 "$OWN_BACKEND_LOG"
      return 1
    fi
    sleep 0.1
  done
}
