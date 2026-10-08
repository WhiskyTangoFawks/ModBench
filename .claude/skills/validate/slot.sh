# Sourced, it gives in_slot. Run by in_slot under a slot's lock, it owns the gate run in that slot.

SLOT_SH=${BASH_SOURCE[0]}

# Runs a command in one of a machine-wide count of slots, the first that frees. -o keeps the lock
# out of child processes, so a lingering build server cannot hold it. The lock and its owner run in
# a session of their own, so a kill of the caller's process group leaves the owner to clean up.
# Where setsid is missing, the command runs unowned.
in_slot() {
  local kind=$1 slots=$2 slot status waiting=false session=() owner=()
  shift 2
  command -v setsid >/dev/null && session=(setsid -w) owner=(bash "$SLOT_SH" "$BASHPID" "$ROOT")
  while :; do
    for slot in $(seq 1 "$slots"); do
      "${session[@]}" flock -n -E 99 -o "/tmp/medit-$kind-gate.$slot.lock" "${owner[@]}" "$@"
      status=$?
      [[ $status -ne 99 ]] && return $status
    done
    $waiting || echo "=== Waiting for a $kind gate slot ==="
    waiting=true
    sleep 1
  done
}

# A run whose worktree or caller is gone would hold its slot for hours, so the owner kills the
# run's whole process group, and the slot frees as the owner exits.
own_slot() {
  local caller=$1 root=$2 group reason
  shift 2
  setsid "$@" &
  group=$!
  while kill -0 "$group" 2>/dev/null; do
    if [[ ! -d $root ]]; then
      reason="worktree gone: $root"
    elif [[ $(ps -o stat= -p "$caller") != [^Z]* ]]; then
      reason="caller gone: pid $caller"
    else
      sleep 1
      continue
    fi
    kill -TERM -- "-$group" 2>/dev/null
    for _ in $(seq 1 100); do
      kill -0 -- "-$group" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$group" 2>/dev/null
    echo "--- gate run killed, $reason ---" >&2
    return 1
  done
  wait "$group"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  own_slot "$@"
fi
