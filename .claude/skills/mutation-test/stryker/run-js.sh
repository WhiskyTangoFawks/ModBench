#!/usr/bin/env bash
# Run StrykerJS on modbench and print only the parsed findings. Raw Stryker output —
# including its mutation-score table, which is Goodhart bait, not a result — goes to a
# log file, never to stdout. The caller sees scope, report path, and survivors.
#
# Usage (from modbench/):
#   bash ../.claude/skills/mutation-test/stryker/run-js.sh                 # changed files vs main
#   bash ../.claude/skills/mutation-test/stryker/run-js.sh --since <ref>   # explicit target
#   bash ../.claude/skills/mutation-test/stryker/run-js.sh --all           # full corpus + baseline snapshot
#   bash ../.claude/skills/mutation-test/stryker/run-js.sh --file deployer.ts
#
# Exit: 0/1/2/3, same contract as run.sh (stryker.md's table). 1 and 3 are not failures.
#
# Memory: concurrency and maxTestRunnerReuse are capped in stryker.config.json — the
# default (cpus-1 workers, unbounded reuse) OOMs the machine. Do not raise them; see
# stryker-js.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="stryker.config.json"
REPORT="reports/mutation/mutation.json"

FILE_FILTER=""
SINCE_REF="main"
ALL=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) ALL=true; shift ;;
        --file) shift; FILE_FILTER="$1"; shift ;;
        --since) shift; SINCE_REF="$1"; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 2 ;;
    esac
done

[[ -f "$CONFIG" ]] || { echo "ERROR: run from modbench/ (no $CONFIG here)." >&2; exit 2; }

# Never `npx stryker`: with no local match npx fetches a same-named package from the
# registry, and the package there is unrelated to this project's @stryker-mutator
# toolchain. A missing dependency fails loudly; a mismatched one produces a mutation
# report full of plausible garbage instead. Same pinning rule `npm run package`
# already applies to vsce. Detached review worktrees never carry node_modules, so
# install rather than fail.
STRYKER="node_modules/.bin/stryker"
if [[ ! -x "$STRYKER" ]]; then
    echo "No local Stryker binary — installing dependencies (npm ci)..."
    npm ci >/dev/null 2>&1 || { echo "ERROR: npm ci failed; cannot run Stryker." >&2; exit 2; }
    [[ -x "$STRYKER" ]] || { echo "ERROR: $STRYKER missing after npm ci." >&2; exit 2; }
fi

# One mutation run at a time, across both runtimes: a second run is what pushed the
# machine over the edge on Aug 14. Matches "stryker run" (JS) and "dotnet-stryker" (.NET).
# The match must be a real runner process: a shell whose command line merely quotes the
# pattern (a watcher/poll loop) must not trip this guard, so filter matches by comm.
if pgrep -f "stryker run|dotnet-stryker" 2>/dev/null | xargs -r ps -o comm= -p 2>/dev/null | grep -qvE '^(bash|sh|zsh)$'; then
    echo "ERROR: a mutation run is already in progress. Wait for it to finish." >&2
    exit 2
fi

MUTATE_CSV=""
if $ALL; then
    SCOPE="config scope (src/modmanager + src/medit)"
elif [[ -n "$FILE_FILTER" ]]; then
    # Config exclusions are not applied: naming a file *is* the request to mutate it.
    [[ "$FILE_FILTER" == */* ]] && MUTATE_CSV="$FILE_FILTER" || MUTATE_CSV="src/**/$FILE_FILTER"
    SCOPE="$MUTATE_CSV (file requested explicitly)"
else
    FULL_SHA=$(git rev-parse --verify --quiet "${SINCE_REF}^{commit}" || true)
    if [[ -z "$FULL_SHA" ]]; then
        echo "ERROR: since target '$SINCE_REF' does not resolve to a commit." >&2
        exit 2
    fi
    # Changed + untracked .ts under the mutated roots, minus the config's `!` exclusions
    # (providers/panels, generated code and test code stay out of scope even when dirty).
    # The pathspec is deliberately not `**/*.ts`: git's default matching needs a literal
    # `/` after `**`, which silently skips files at the top of the directory; a bare `*`
    # crosses slashes. Keep these roots in step with `mutate` in stryker.config.json — a
    # root listed there but missing here mutates on `--all` and never on a diff.
    CHANGED=$( { git diff --name-only --relative "$FULL_SHA" -- 'src/modmanager/*.ts' 'src/medit/*.ts' || true; \
                 git ls-files --others --exclude-standard -- 'src/modmanager/*.ts' 'src/medit/*.ts' || true; } | sort -u)
    MUTATE_LIST=$(printf '%s\n' "$CHANGED" | python3 -c '
import fnmatch, json, sys
neg = [p[1:] for p in json.load(open(sys.argv[1]))["mutate"] if p.startswith("!")]
for line in sys.stdin:
    f = line.strip()
    # fnmatch has no "zero directories" reading of "**/", so try each pattern both ways
    if f and not any(fnmatch.fnmatch(f, n) or fnmatch.fnmatch(f, n.replace("**/", ""))
                     for n in neg):
        print(f)
' "$CONFIG")
    if [[ -z "$MUTATE_LIST" ]]; then
        echo "Scope: nothing to mutate — no modmanager TypeScript changes vs ${SINCE_REF} (${FULL_SHA:0:8})."
        exit 3
    fi
    MUTATE_CSV=$(printf '%s\n' "$MUTATE_LIST" | paste -sd,)
    SCOPE="changed files vs ${SINCE_REF} (${FULL_SHA:0:8}): $MUTATE_CSV"
fi

echo "Scope: $SCOPE"

RUN_START=$(date +%s)
LOG=$(mktemp /tmp/stryker-js-run-XXXXXX.log)

set +e
if [[ -n "$MUTATE_CSV" ]]; then
    "$STRYKER" run --mutate "$MUTATE_CSV" >"$LOG" 2>&1
else
    "$STRYKER" run >"$LOG" 2>&1
fi
STRYKER_RC=$?
set -e

echo "Stryker finished (exit $STRYKER_RC). Log: $LOG"

if [[ ! -f "$REPORT" ]] || (( $(stat -c %Y "$REPORT") < RUN_START )); then
    echo "ERROR: Stryker produced no fresh report (exit $STRYKER_RC). Last lines of $LOG:" >&2
    tail -20 "$LOG" >&2
    exit 2
fi

echo "Report: $REPORT"

# Scoped runs overwrite mutation.json, so the full-corpus baseline lives under its own
# name; refreshing it here is what makes scoped runs safe to fire at will.
if $ALL; then
    cp "$REPORT" reports/mutation/baseline.json
    echo "Baseline refreshed: reports/mutation/baseline.json"
fi

python3 "$SCRIPT_DIR/parse-report.py" "$REPORT"
