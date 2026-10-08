# Sourced: `stop_group <pgid> <seconds>` sends the process group TERM, and KILL once it outlives
# the grace.
stop_group() {
  local group=$1 tenths=$(($2 * 10))
  kill -TERM -- "-$group" 2>/dev/null
  for _ in $(seq 1 "$tenths"); do
    kill -0 -- "-$group" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL -- "-$group" 2>/dev/null
}
