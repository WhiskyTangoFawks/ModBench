#!/usr/bin/env bash
# slot-run.sh <command...>: runs a build or test in the machine's build slot, in a scope of its own
# where systemd gives one. A run already in the slot, as a gate's build is, runs as it stands.
DIR=${BASH_SOURCE[0]%/*}
[[ -n ${BUILD_SLOT_HELD:-} ]] && exec "$@"

export BUILD_SLOT_HELD=1
# MSBuild's worker nodes otherwise idle on after the build, about 190 MB each, and serve the
# builds of other worktrees.
export MSBUILDDISABLENODEREUSE=1
# The slot stops a run whose tree is gone. That tree is the caller's, since a worktree's agent
# runs the main checkout's copy of this script.
ROOT=$PWD
source "$DIR/slot.sh"

unit=medit-build-$$
scope=()
if systemd-run --user --scope --quiet true 2>/dev/null; then
  scope=(systemd-run --user --scope --quiet --collect --unit="$unit")
  # The compiler server is shared by every build of the user, and compiles in the cgroup it
  # started in. One of the run's own compiles inside the scope, and the scope's stop ends it, where
  # it would otherwise idle on holding a GB or more.
  export SharedCompilationId=$unit
fi
in_slot build 1 "${scope[@]}" "$@"
status=$?
[[ ${#scope[@]} -gt 0 ]] && systemctl --user stop "$unit.scope" 2>/dev/null
exit "$status"
