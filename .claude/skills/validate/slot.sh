# Sourced, it gives in_slot. Run by in_slot, it waits for a slot and owns the run in it.

source "${BASH_SOURCE[0]%/*}/stop-group.sh"
SLOT_SH=${BASH_SOURCE[0]}

# Longer than own-backend.sh's, so a run that owns a backend stops it first.
RUN_GRACE_S=10

# Runs a command in one of a machine-wide count of slots, the first that frees. The slot's lock and
# its owner sit in a session of their own, so a kill of the caller's process group leaves the owner
# to clean up. A job of a shell without job control ignores INT, so the owner starts with it
# restored and gets the caller's INT and TERM. Where setsid is missing, the command runs unowned,
# and where flock is missing, unslotted.
in_slot() {
  local caller=$BASHPID owner status
  if ! command -v flock >/dev/null; then
    "${@:3}"
    return
  fi
  if ! command -v setsid >/dev/null; then
    wait_for_slot "$1" "$2"
    "${@:3}" {SLOT_FD}>&-
    status=$?
    exec {SLOT_FD}>&-
    return "$status"
  fi
  (trap - INT QUIT; exec setsid bash "$SLOT_SH" "$caller" "$ROOT" "$@") &
  owner=$!
  trap 'kill -INT "$owner"' INT
  trap 'kill -TERM "$owner"' TERM
  wait "$owner"
  status=$?
  while kill -0 "$owner" 2>/dev/null; do
    wait "$owner"
    status=$?
  done
  trap - INT TERM
  return "$status"
}

# The runs that keep the slot taken for as long as they are up, one line each, where a caller asks
# for them with SLOT_YIELDS_TO_HEAVY: the Windows VM's container, and an acceptance run's Xvfb.
# A run named in SLOT_INSIDE, a comma list, is the caller's own and does not count.
heavy_runs() {
  [[ -n ${SLOT_YIELDS_TO_HEAVY:-} ]] || return 0
  local dir
  if [[ ,${SLOT_INSIDE:-}, != *,windows-vm,* ]] && command -v docker >/dev/null \
    && [[ -n $(docker ps -q --filter label=com.docker.compose.project=modbench-windows 2>/dev/null) ]]; then
    echo "    held by the Windows VM, until vm.sh down"
  fi
  [[ ,${SLOT_INSIDE:-}, != *,acceptance,* ]] || return 0
  for dir in "${SLOT_ACCEPT_PREFIX:-/tmp/modbench-accept.}"*; do
    [[ -n $(run_pids "$dir") ]] && echo "    held by the acceptance run $dir, until accept.sh down"
  done
  return 0
}

# The live processes of an acceptance run: its pids file holds a "pid starttime" line for each
# process the run started, and a pid that has since gone to another process does not match.
run_pids() {
  local pid start
  [[ -f $1/pids ]] || return 0
  while read -r pid start; do
    [[ -n $start && $(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | awk '$1 != "Z" { print $20 }') == "$start" ]] && echo "$pid"
  done <"$1/pids" 2>/dev/null
  return 0
}

# Polls every slot until one frees, and holds its lock on SLOT_FD. Given a caller and a worktree
# root, it gives up once either is gone.
wait_for_slot() {
  local kind=$1 slots=$2 caller=${3:-} root=${4:-} slot waiting=false reason blockers=
  while :; do
    for slot in $(seq 1 "$slots"); do
      exec {SLOT_FD}>"/tmp/medit-$kind-slot.$slot.lock"
      if flock -n "$SLOT_FD"; then
        blockers=$(heavy_runs)
        [[ -z $blockers ]] && return 0
        exec {SLOT_FD}>&-
        break
      fi
      exec {SLOT_FD}>&-
    done
    if [[ -n $caller ]] && reason=$(orphaned "$caller" "$root"); then
      echo "--- run abandoned, $reason ---" >&2
      return 1
    fi
    $waiting || { echo "=== Waiting for a $kind slot ==="; [[ -z $blockers ]] || echo "$blockers"; }
    waiting=true
    sleep 1
  done
}

orphaned() {
  if [[ ! -d $2 ]]; then
    echo "worktree gone: $2"
  elif [[ $(ps -o stat= -p "$1") != [^Z]* ]]; then
    echo "caller gone: pid $1"
  else
    return 1
  fi
}

# A run whose worktree or caller is gone would hold its slot for hours, so the owner stops the
# run's whole process group, and the slot frees as the owner exits. The run gets the slot's lock
# closed, so a lingering build server cannot hold it.
own_slot() {
  local caller=$1 root=$2 kind=$3 slots=$4 group= reason
  shift 4
  trap '[[ -n $group ]] && kill -INT -- "-$group" || exit 130' INT
  trap '[[ -n $group ]] && kill -TERM -- "-$group" || exit 143' TERM
  wait_for_slot "$kind" "$slots" "$caller" "$root" || return
  (trap - INT QUIT; exec setsid "$@" {SLOT_FD}>&-) &
  group=$!
  while kill -0 "$group" 2>/dev/null; do
    if reason=$(orphaned "$caller" "$root"); then
      stop_group "$group" "$RUN_GRACE_S"
      echo "--- run killed, $reason ---" >&2
      return 1
    fi
    sleep 1
  done
  wait "$group"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  own_slot "$@"
fi
