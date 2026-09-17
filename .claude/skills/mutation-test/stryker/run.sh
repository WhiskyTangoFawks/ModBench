#!/usr/bin/env bash
# Run Stryker.NET, scoped to one box's production project against its own test project, and
# print only the parsed findings. Raw Stryker output goes to a log file, never to stdout — the
# caller sees scope, report path, and survivors.
#
# Usage (from MEditService/):
#   bash ../.claude/skills/mutation-test/stryker/run.sh --box <Box>                # vs since.target
#   bash ../.claude/skills/mutation-test/stryker/run.sh --box <Box> --since <ref>  # explicit target
#   bash ../.claude/skills/mutation-test/stryker/run.sh --box <Box> --all          # the whole box
#   bash ../.claude/skills/mutation-test/stryker/run.sh --box <Box> --file Foo.cs  # one file
#   bash ../.claude/skills/mutation-test/stryker/run.sh --box <Box> --diff-only    # narrow to diffed lines
#
# <Box> is one of the ten production projects (Codec, Commands, Http, Index, LoadOrder,
# PluginAdapter, Ports, Queries, SourceRepo, Watcher). The generated config names exactly one test
# project, MEditService.<Box>.Tests, and mutates exactly one production project, MEditService.<Box>.
#
# Exit: 0/1/2/3 — see stryker.md's table. 1 and 3 are not failures (survivors await
# disposition; nothing in scope is a clean skip).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_CONFIG="stryker-config.template.json"
RUN_CONFIG=".stryker-run.json"

# Box-specific mutate exclusions carried over from the pre-split config: files that yielded zero
# information (every tested mutant Timeout, nothing killed or survived) under Stryker's async
# deadlock-as-timeout behavior (stryker.md's cost model).
BOX_EXCLUSIONS_Queries='!**/MEditService.Queries/RecordQueryService.cs'
BOX_EXCLUSIONS_Ports='!**/MEditService.Ports/LoadOrderStatus.cs'

VALID_BOXES="Codec Commands Http Index LoadOrder PluginAdapter Ports Queries SourceRepo Watcher"

BOX=""
FILE_FILTER=""
SINCE_REF=""
ALL=false
DIFF_ONLY=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --box) shift; [[ $# -gt 0 ]] || { echo "ERROR: --box needs a value." >&2; exit 2; }; BOX="$1"; shift ;;
        --all) ALL=true; shift ;;
        --file) shift; [[ $# -gt 0 ]] || { echo "ERROR: --file needs a value." >&2; exit 2; }; FILE_FILTER="$1"; shift ;;
        --since) shift; [[ $# -gt 0 ]] || { echo "ERROR: --since needs a value." >&2; exit 2; }; SINCE_REF="$1"; shift ;;
        --diff-only) DIFF_ONLY=true; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 2 ;;
    esac
done

[[ -n "$BOX" ]] || { echo "ERROR: --box <Box> is required. One of: $VALID_BOXES" >&2; exit 2; }
if ! grep -qw "$BOX" <<< "$VALID_BOXES"; then
    echo "ERROR: unknown box '$BOX'. One of: $VALID_BOXES" >&2
    exit 2
fi
PROD_PROJECT="MEditService.${BOX}"
TEST_PROJECT="MEditService.${BOX}.Tests"

# A second concurrent run contends for the same build output and one of the two dies with
# no report. Observed in the wild: a run started because the first looked hung.
# The match must be a real runner process: a shell whose command line merely quotes the
# pattern (a watcher/poll loop) must not trip this guard, so filter matches by comm.
if pgrep -f "dotnet-stryker" 2>/dev/null | xargs -r ps -o comm= -p 2>/dev/null | grep -qvE '^(bash|sh|zsh)$'; then
    echo "ERROR: a dotnet-stryker run is already in progress. Wait for it or kill it." >&2
    exit 2
fi

[[ -f "$TEMPLATE_CONFIG" ]] || { echo "ERROR: run from MEditService/ (no $TEMPLATE_CONFIG here)." >&2; exit 2; }
[[ -d "$TEST_PROJECT" ]] || { echo "ERROR: $TEST_PROJECT does not exist beside $TEMPLATE_CONFIG." >&2; exit 2; }

rm -f "$RUN_CONFIG"
trap 'rm -f "$RUN_CONFIG"' EXIT

# --- resolve scope, and refuse to spend the ~8min fixed cost on an empty one ---
#
# Diff scoping is computed *here*, with git, and handed to Stryker as an explicit mutate
# list. Stryker's own `since` is never enabled — it reads the wrong repository root
# inside a linked worktree, with no config/CLI knob to fix it (stryker.md §Guardrails).
# Computing the diff ourselves is also what run-js.sh has always done.
#
# The target ref is still resolved and verified up front, so a bad ref fails in under a
# second instead of after paying the full build+mutate+coverage cost. Short SHAs do not
# resolve; a full SHA does.
MUTATE_JSON="null"
KEEP_NEGATIONS="true"

if $ALL; then
    SCOPE="all of $PROD_PROJECT"
elif [[ -n "$FILE_FILTER" ]]; then
    # An explicit file request must run whether or not that file has a diff vs the target.
    # The base config's exclusions are dropped too — naming a file *is* the request to
    # mutate it.
    SCOPE="$FILE_FILTER (file requested explicitly)"
    MUTATE_JSON="[\"**/$FILE_FILTER\"]"
    KEEP_NEGATIONS="false"
else
    TARGET="${SINCE_REF:-$(python3 -c "import json;print(json.load(open('$TEMPLATE_CONFIG'))['stryker-config']['since']['target'])")}"
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
               | grep "${PROD_PROJECT}/.*\.cs$" | sort -u || true)
    if [[ -z "$CHANGED" ]]; then
        echo "Scope: nothing to mutate — no $PROD_PROJECT C# changes vs ${TARGET} (${BASE_SHA:0:8})."
        exit 3
    fi
    SCOPE="${BOX} changes vs ${TARGET} (${BASE_SHA:0:8}): $(printf '%s\n' "$CHANGED" | tr '\n' ' ')"
    MUTATE_JSON=$(printf '%s\n' "$CHANGED" | sed "s|.*/${PROD_PROJECT}/|**/|" \
                  | python3 -c "import json,sys;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
fi

echo "Scope: $SCOPE"

# --- generate the run config from the template; never patch a checked-in one ---
# The template names no box — this fills it in for exactly one box's production project and
# exactly that box's own test project, so a run can never reach another box's tests.
# Bash indirect expansion: the box-specific exclusion variable declared above (or empty).
BOX_EXCLUSION_VAR="BOX_EXCLUSIONS_${BOX}"
BOX_EXCLUSION="${!BOX_EXCLUSION_VAR:-}"

PROD_PROJECT="$PROD_PROJECT" TEST_PROJECT="$TEST_PROJECT" \
MUTATE_JSON="$MUTATE_JSON" KEEP_NEGATIONS="$KEEP_NEGATIONS" BOX_EXCLUSION="$BOX_EXCLUSION" \
python3 - "$TEMPLATE_CONFIG" "$RUN_CONFIG" <<'PY'
import json, os, sys
tmpl, out = sys.argv[1], sys.argv[2]
prod = os.environ["PROD_PROJECT"]
test = os.environ["TEST_PROJECT"]

cfg = json.load(open(tmpl))
sc = cfg["stryker-config"]
sc["test-projects"] = [f"{test}/{test}.csproj"]
# Disambiguates the mutated project among the test project's own references — without it,
# Stryker enumerates every csproj the solution can build and baselines each one's tests in
# turn, which is correct but runs the whole suite once per production project.
sc["project"] = f"{prod}.csproj"

mutate = json.loads(os.environ["MUTATE_JSON"])
box_exclusion = os.environ.get("BOX_EXCLUSION") or None

if mutate is not None:
    # An explicit mutate list replaces the base glob, but a box-specific `!` exclusion (a file
    # that yielded zero information last time, stryker.md's cost model) is policy and must
    # survive it — otherwise merely having it uncommitted in the working tree puts it back in
    # scope. `--file` drops it: naming a file *is* the request to mutate it.
    negations = [box_exclusion] if (os.environ["KEEP_NEGATIONS"] == "true" and box_exclusion) else []
    sc["mutate"] = mutate + negations
else:
    sc["mutate"] = [f"**/{prod}/**/*.cs"] + ([box_exclusion] if box_exclusion else [])

# Unconditional: scope is already decided above, by git in *this* worktree. Leaving
# `since` in the generated config would hand that decision back to a resolver that
# reads the wrong checkout (stryker.md §Guardrails).
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
