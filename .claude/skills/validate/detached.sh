#!/usr/bin/env bash
# A Bash tool call ends after 10 minutes, and a subagent that ends its turn to wait has reported
# instead.
set -u
DIR=/tmp/medit-detached
mkdir -p "$DIR"
mode=${1:-}
name=${2:-}
[[ -n $mode && -n $name ]] || { echo "usage: detached.sh start <name> <command...> | wait <name> [seconds]"; exit 1; }
shift 2
LOG="$DIR/$name.log"
PID="$DIR/$name.pid"

# The pid file carries the process start time, so a pid handed to a later process after a kill
# or a reboot is not mistaken for the run.
running() {
  [[ -f $PID ]] || return 1
  local pid start
  { read -r pid; read -r start; } < "$PID"
  [[ -n $start && $(ps -o lstart= -p "$pid" 2>/dev/null) == "$start" ]]
}

case $mode in
  start)
    if running; then
      echo "$name already running (pid $(head -n 1 "$PID")); log $LOG"
      exit 1
    fi
    nohup bash -c '"$@"; s=$?; echo; echo "EXIT=$s"' _ "$@" >"$LOG" 2>&1 &
    pid=$!
    printf '%s\n%s\n' "$pid" "$(ps -o lstart= -p "$pid")" >"$PID"
    echo "detached $name (pid $pid); log $LOG"
    ;;
  wait)
    seconds=${1:-540}
    if [[ ! -f $PID ]]; then
      echo "nothing detached as $name"
      [[ -f $LOG ]] && echo "last log: $LOG"
      exit 2
    fi
    if running; then
      timeout "$seconds" tail --pid="$(head -n 1 "$PID")" -f /dev/null
    fi
    if running; then
      echo "$name still running: $(tail -n 1 "$LOG")"
      exit 3
    fi
    rm -f "$PID"
    echo "--- last 40 lines of $LOG ---"
    tail -n 40 "$LOG"
    verdict=$(tail -n 1 "$LOG")
    [[ $verdict == EXIT=* ]] || { echo "$name died without a verdict"; exit 4; }
    [[ $verdict == EXIT=0 ]]
    ;;
  *)
    echo "usage: detached.sh start <name> <command...> | wait <name> [seconds]"
    exit 1
    ;;
esac
