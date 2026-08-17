#!/usr/bin/env bash
# Run Stryker.NET and print only the parsed findings. Raw Stryker output goes to a log
# file, never to stdout — the caller sees scope, report path, and survivors.
#
# Usage (from MEditService/):
#   bash ../.claude/skills/mutation-test/stryker/run.sh                    # vs since.target
#   bash ../.claude/skills/mutation-test/stryker/run.sh --since <ref>      # explicit target
#   bash ../.claude/skills/mutation-test/stryker/run.sh --all              # full corpus
#   bash ../.claude/skills/mutation-test/stryker/run.sh --file Foo.cs      # one file
#   bash ../.claude/skills/mutation-test/stryker/run.sh --diff-only        # narrow to diffed lines
#
# Exit: 0 all killed | 1 survivors await disposition | 2 tool error | 3 nothing in scope.
# Exit 1 means *survivors await disposition*, not *failure*. Exit 3 means the diff held no
# mutable C#, which is a clean skip, not a problem.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_CONFIG="stryker-config.json"
RUN_CONFIG=".stryker-run.json"

FILE_FILTER=""
SINCE_REF=""
ALL=false
DIFF_ONLY=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) ALL=true; shift ;;
        --file) shift; FILE_FILTER="$1"; shift ;;
        --since) shift; SINCE_REF="$1"; shift ;;
        --diff-only) DIFF_ONLY=true; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 2 ;;
    esac
done

# A second concurrent run contends for the same build output and one of the two dies with
# no report. Observed in the wild: a run started because the first looked hung.
if pgrep -f "dotnet-stryker" >/dev/null 2>&1; then
    echo "ERROR: a dotnet-stryker run is already in progress. Wait for it or kill it." >&2
    exit 2
fi

[[ -f "$BASE_CONFIG" ]] || { echo "ERROR: run from MEditService/ (no $BASE_CONFIG here)." >&2; exit 2; }

rm -f "$RUN_CONFIG"
trap 'rm -f "$RUN_CONFIG"' EXIT

# --- resolve scope, and refuse to spend the ~8min fixed cost on an empty one ---
#
# Diff scoping is computed *here*, with git, and handed to Stryker as an explicit mutate
# list. Stryker's own `since` is never enabled — #362: its GitInfoProvider derives the
# repository root as `Repository.Discover(projectPath).Split(".git")[0]`, which inside a
# linked worktree yields `<main-checkout>/` (the git dir is
# `<main>/.git/worktrees/<name>`). It then diffs *that* checkout's working directory, so a
# run in a detached review worktree scoped itself against the maintainer's unrelated
# ambient edits, filtered out all 5334 mutants, and exited 0. There is no config or CLI
# knob for the repository path. Computing the diff ourselves is also what run-js.sh has
# always done.
#
# The target ref is still resolved up front. That began as protection against Stryker
# validating its own `since` target only *after* building, mutating and capturing coverage
# — a bad ref cost ~8 minutes and left an output directory with no report at all. Stryker
# no longer sees the ref, but resolving it here is still what turns a typo into an instant
# message instead of a silently empty scope. Short SHAs do not resolve; a full SHA does.
MUTATE_JSON="null"
KEEP_NEGATIONS="true"

if $ALL; then
    SCOPE="all of MEditService.Core"
elif [[ -n "$FILE_FILTER" ]]; then
    # An explicit file request must run whether or not that file has a diff vs the target.
    # The base config's exclusions are dropped too — naming a file *is* the request to
    # mutate it.
    SCOPE="$FILE_FILTER (file requested explicitly)"
    MUTATE_JSON="[\"**/$FILE_FILTER\"]"
    KEEP_NEGATIONS="false"
else
    TARGET="${SINCE_REF:-$(python3 -c "import json;print(json.load(open('$BASE_CONFIG'))['stryker-config']['since']['target'])")}"
    FULL_SHA=$(git rev-parse --verify --quiet "${TARGET}^{commit}" || true)
    if [[ -z "$FULL_SHA" ]]; then
        echo "ERROR: diff target '$TARGET' does not resolve to a commit." >&2
        exit 2
    fi
    # Merge-base, so a target that has moved on since the branch was cut doesn't drag
    # everyone else's landed work into scope. `git diff <base>` spans committed *and*
    # uncommitted changes in one pass, which is the union the old two-branch form was
    # reaching for. `--diff-filter=d` drops deletions: a deleted file's glob would match
    # nothing and only make the scope line lie.
    BASE_SHA=$(git merge-base "$FULL_SHA" HEAD 2>/dev/null || echo "$FULL_SHA")
    CHANGED=$( { git diff --name-only --diff-filter=d "$BASE_SHA" -- "*.cs" || true; \
                 git ls-files --others --exclude-standard -- "*.cs" || true; } \
               | grep "MEditService.Core/.*\.cs$" | sort -u || true)
    if [[ -z "$CHANGED" ]]; then
        echo "Scope: nothing to mutate — no MEditService.Core C# changes vs ${TARGET} (${BASE_SHA:0:8})."
        exit 3
    fi
    SCOPE="Core changes vs ${TARGET} (${BASE_SHA:0:8}): $(printf '%s\n' "$CHANGED" | tr '\n' ' ')"
    MUTATE_JSON=$(printf '%s\n' "$CHANGED" | sed 's|.*/MEditService.Core/|**/|' \
                  | python3 -c "import json,sys;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
fi

echo "Scope: $SCOPE"

# --- generate the run config; never patch the checked-in one ---
# The previous version edited stryker-config.json in place and restored it from a trap, so
# a killed run left the repo's config mutated. A generated file cannot corrupt the original.
MUTATE_JSON="$MUTATE_JSON" KEEP_NEGATIONS="$KEEP_NEGATIONS" \
python3 - "$BASE_CONFIG" "$RUN_CONFIG" <<'PY'
import json, os, sys
base, out = sys.argv[1], sys.argv[2]
cfg = json.load(open(base))
sc = cfg["stryker-config"]

mutate = json.loads(os.environ["MUTATE_JSON"])

if mutate is not None:
    # An explicit mutate list replaces the base globs, but the base config's `!` exclusions
    # are policy (files whose mutants only ever time out) and must survive it — otherwise
    # merely having them uncommitted in the working tree puts them back in scope.
    if os.environ["KEEP_NEGATIONS"] == "true":
        mutate = mutate + [p for p in sc.get("mutate", []) if p.startswith("!")]
    sc["mutate"] = mutate

# Unconditional, and the point of #362: scope is already decided above, by git in *this*
# worktree. Leaving `since` in the generated config would hand that decision back to a
# resolver that reads the wrong checkout.
sc.pop("since", None)

# Dots is the only progress signal that survives redirection: plain characters, no ANSI
# repaint. The `progress` reporter draws a ShellProgressBar that throws
# ArgumentOutOfRangeException under a width-less pty, which is what the old pty wrapper made.
sc["reporters"] = ["json", "html", "dots"]
json.dump(cfg, open(out, "w"), indent=2)
PY

RUN_START=$(date +%s)
LOG=$(mktemp /tmp/stryker-run-XXXXXX.log)

# TERM=linux makes Stryker emit *nothing at all* — not even --help, exit code 0. Every other
# value, including unset and `dumb`, works. It is the ambient TERM in a non-interactive
# shell, so this assignment is what makes an unattended run observable. No pty is needed:
# Stryker writes to stdout perfectly well once TERM is anything else.
set +e
TERM=xterm dotnet-stryker --config-file "$RUN_CONFIG" --log-to-file >"$LOG" 2>&1
STRYKER_RC=$?
set -e

echo "Stryker finished (exit $STRYKER_RC). Log: $LOG"

REPORT=$(python3 - "$RUN_START" <<'PY'
import glob, os, sys
start = int(sys.argv[1])
fresh = [r for r in glob.glob("StrykerOutput/**/mutation-report.json", recursive=True)
         if os.path.getmtime(r) >= start]
print(max(fresh, key=os.path.getmtime) if fresh else "")
PY
)

if [[ -z "$REPORT" ]]; then
    echo "ERROR: Stryker produced no report (exit $STRYKER_RC). Last lines of $LOG:" >&2
    tail -20 "$LOG" >&2
    exit 2
fi

echo "Report: $REPORT"

PARSE_ARGS=("$REPORT")
$DIFF_ONLY && PARSE_ARGS+=(--diff-only)
python3 "$SCRIPT_DIR/parse-report.py" "${PARSE_ARGS[@]}"
