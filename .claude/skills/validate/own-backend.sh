# Sourced, never run: `start_own_backend <server command...>` starts the server with
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

own_backend_port() {
  local pids
  pids=$(pgrep -g "$OWN_BACKEND_PGID" | paste -sd '|')
  [[ -n $pids ]] || return 0
  ss -Hltnp 2>/dev/null | grep -E "pid=($pids)," | awk '{ n = split($4, a, ":"); print a[n]; exit }'
}

start_own_backend() {
  trap stop_own_backend EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  OWN_BACKEND_LOG="$(mktemp /tmp/own-backend.XXXXXX.log)"
  # setsid execs in place only when its caller leads no process group, which holds for a
  # background job of a non-interactive shell: so $! is the new group's id.
  setsid "$@" --urls http://127.0.0.1:0 >"$OWN_BACKEND_LOG" 2>&1 &
  OWN_BACKEND_PGID=$!

  local port="" elapsed=0
  while :; do
    if ! kill -0 "$OWN_BACKEND_PGID" 2>/dev/null; then
      echo "--- backend exited before it answered /health; its output: ---"
      tail -50 "$OWN_BACKEND_LOG"
      return 1
    fi
    [[ -n $port ]] || port=$(own_backend_port)
    if [[ -n $port ]] && curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      OWN_BACKEND_URL="http://127.0.0.1:$port"
      return 0
    fi
    if [[ $elapsed -ge $((OWN_BACKEND_BOOT_TIMEOUT_S * 10)) ]]; then
      echo "--- backend did not answer /health within ${OWN_BACKEND_BOOT_TIMEOUT_S}s; its output: ---"
      tail -50 "$OWN_BACKEND_LOG"
      return 1
    fi
    sleep 0.1
    elapsed=$((elapsed + 1))
  done
}
