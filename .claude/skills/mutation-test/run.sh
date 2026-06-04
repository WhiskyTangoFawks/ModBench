#!/usr/bin/env bash
# Run Stryker.NET and parse the results. Stryker output goes to a developer-visible
# terminal window only — nothing is piped to the agent's context.
#
# Usage (from MEditService/):
#   bash ../.claude/skills/mutation-test/run.sh
#   bash ../.claude/skills/mutation-test/run.sh --all              # same scope (since disabled)
#   bash ../.claude/skills/mutation-test/run.sh --file ConflictClassifier.cs
#   bash ../.claude/skills/mutation-test/run.sh --mutant-ids 42 57
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="stryker-config.json"
PARSE="python3 $SCRIPT_DIR/parse-report.py"

# --- arg parsing ---
MUTANT_IDS=()
FILE_FILTER=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) shift ;;  # no-op: since is already disabled in committed config
        --file) shift; FILE_FILTER="$1"; shift ;;
        --mutant-ids)
            shift
            while [[ $# -gt 0 && "$1" != --* ]]; do
                MUTANT_IDS+=("$1"); shift
            done
            ;;
        *) shift ;;
    esac
done

# --- optional config patch for --mutant-ids ---
ORIGINAL_CONFIG=""
restore_config() {
    if [[ -n "$ORIGINAL_CONFIG" ]]; then
        echo "$ORIGINAL_CONFIG" > "$CONFIG"
    fi
}
trap restore_config EXIT

if [[ ${#MUTANT_IDS[@]} -gt 0 ]]; then
    echo "Targeted run — mutant IDs: ${MUTANT_IDS[*]}"
    ORIGINAL_CONFIG=$(cat "$CONFIG")
    # Inject mutant-id array into config
    ID_JSON=$(printf '%s\n' "${MUTANT_IDS[@]}" | python3 -c "import json,sys; print(json.dumps([int(l) for l in sys.stdin]))")
    python3 -c "
import json, sys
cfg = json.load(open('$CONFIG'))
cfg['stryker-config']['mutant-id'] = $ID_JSON
with open('$CONFIG', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
"
elif [[ -n "$FILE_FILTER" ]]; then
    echo "Scope: $FILE_FILTER"
else
    echo "Scope: all of MEditService.Core (since disabled)"
fi

# --- build stryker args ---
STRYKER_ARGS=(--config-file "$CONFIG")
if [[ -n "$FILE_FILTER" ]]; then
    STRYKER_ARGS+=(--mutate "**/$FILE_FILTER")
fi

# --- run stryker, send output to a temp log; open a developer-visible terminal ---
LOG=$(mktemp /tmp/stryker_XXXXXX.log)
trap 'restore_config; rm -f "$LOG"' EXIT

dotnet stryker "${STRYKER_ARGS[@]}" >"$LOG" 2>&1 &
STRYKER_PID=$!

# Open a terminal showing the full log from the start and following new output.
# No --pid: we append a completion banner so the terminal stays open until the user closes it.
TAIL_CMD="tail -n +1 -f '$LOG'"
if command -v cosmic-term &>/dev/null; then
    cosmic-term -- bash -c "$TAIL_CMD" 2>/dev/null &
elif command -v gnome-terminal &>/dev/null; then
    gnome-terminal --title="Stryker Mutation Test" -- bash -c "$TAIL_CMD" 2>/dev/null &
elif command -v xterm &>/dev/null; then
    xterm -T "Stryker Mutation Test" -e "bash -c \"$TAIL_CMD\"" 2>/dev/null &
fi

# Wait for stryker; capture exit code without failing the script
wait "$STRYKER_PID" && STRYKER_RC=0 || STRYKER_RC=$?

# Append completion banner so the open terminal shows it and the user knows it's done
printf '\n================================================================\n' >> "$LOG"
printf '  Stryker complete (exit %s) — safe to close this window\n' "$STRYKER_RC" >> "$LOG"
printf '================================================================\n' >> "$LOG"

echo "Stryker finished (exit $STRYKER_RC)."

# --- parse and print filtered results ---
$PARSE
