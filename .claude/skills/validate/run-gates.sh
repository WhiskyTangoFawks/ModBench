#!/usr/bin/env bash

BACKEND=false
FRONTEND=false
API_DRIFT=false
DOCS=false
SCRIPTS=false
DETACH=false
WAIT=false
FAILED=false
# The merge-to-main tier is paused until epic #2450 lands: a merge run runs the branch gates. #2466 resumes
# the tier by deleting this switch and PAUSED_NOTICE.
MERGE_TIER_PAUSED=true
PAUSED_NOTICE="The merge-to-main tier is paused until epic #2450 lands: these are the branch gates."
# The mode survives each re-exec in the environment, as BUILD_SLOT_HELD does.
MERGE_TO_MAIN=false
[[ ${MEDIT_MERGE_TO_MAIN:-} == true ]] && MERGE_TO_MAIN=true
GATE_ARGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --backend)   BACKEND=true;   GATE_ARGS+=("$1"); shift ;;
    --frontend)  FRONTEND=true;  GATE_ARGS+=("$1"); shift ;;
    --api-drift) API_DRIFT=true; GATE_ARGS+=("$1"); shift ;;
    --docs)      DOCS=true;      GATE_ARGS+=("$1"); shift ;;
    --scripts)   SCRIPTS=true;   GATE_ARGS+=("$1"); shift ;;
    --comments)                  GATE_ARGS+=("$1"); shift ;;
    --merge-to-main) export MEDIT_MERGE_TO_MAIN=true; MERGE_TO_MAIN=true; shift ;;
    --detach)    DETACH=true;    shift ;;
    --wait)      WAIT=true;      shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

MERGE_REQUESTED=$MERGE_TO_MAIN
! $MERGE_TIER_PAUSED || MERGE_TO_MAIN=false
! $MERGE_TO_MAIN || BACKEND=true
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DETACHED_SH="$ROOT/.claude/skills/validate/detached.sh"
GATE_NAME="gates.$(basename "$ROOT")"
$WAIT && exec bash "$DETACHED_SH" wait "$GATE_NAME"
$DETACH && exec bash "$DETACHED_SH" start "$GATE_NAME" bash "$0" "${GATE_ARGS[@]}"

# A branch lands on the local branch it tracks, such as a ticket's integration branch, and any
# other branch lands on main. Its change is the diff since where it lands. A merge to main lands on
# main, whatever the branch tracks.
BASE=main
if ! $MERGE_TO_MAIN && head=$(git -C "$ROOT" symbolic-ref -q HEAD); then
  upstream=$(git -C "$ROOT" for-each-ref --format='%(upstream)' "$head")
  [[ $upstream == refs/heads/* ]] && BASE=${upstream#refs/heads/}
fi

# On the base itself the diff is empty, so the change is the whole tree. core.quotePath=false keeps
# non-ASCII paths unquoted, so they match the selectors' prefixes.
changed_since_base() {
  local base git=(git -C "$ROOT" -c core.quotePath=false)
  base=$(git -C "$ROOT" merge-base "$BASE" HEAD) || return
  if [[ $base == "$(git -C "$ROOT" rev-parse HEAD)" ]]; then
    "${git[@]}" ls-files
  else
    "${git[@]}" diff --name-only --no-renames "$base"
  fi && "${git[@]}" ls-files --others --exclude-standard
}

if [[ ${GATE_ARGS[*]} != --comments ]] && ! git -C "$ROOT" merge-base --is-ancestor "$BASE" HEAD; then
  echo "Refused: HEAD is behind $BASE. Merge $BASE first, so the gates test the tree that will land."
  exit 1
fi

if [[ ${#GATE_ARGS[@]} -eq 0 ]]; then
  changed=$(changed_since_base) || exit 1
  selection=$(python3 "$ROOT/.claude/skills/validate/select_gates.py" <<< "$changed") || exit 1
  echo "=== Gates the change since $BASE can break ==="
  echo "${selection:-none beyond Gate 1}"
  flags=$(cut -d' ' -f1 <<< "$selection")
  exec bash "$0" ${flags:---comments}
fi

# Every gate but the comment gate builds or tests: api-drift and scripts build and boot a backend,
# and docs runs both stacks' scans.
HOLDS_SLOT=false
{ $BACKEND || $FRONTEND || $API_DRIFT || $DOCS || $SCRIPTS; } && HOLDS_SLOT=true
if $HOLDS_SLOT && [[ -z ${BUILD_SLOT_HELD:-} ]]; then
  exec bash "$ROOT/.claude/skills/validate/slot-run.sh" bash "$0" "${GATE_ARGS[@]}"
fi

# The logs and reports the time report reads, and a merge to main's skips. A run beside the comment
# gate's own would delete them, so only a run in the slot clears them. SECONDS counts from here, in
# the process that holds the slot, so the wait for the slot is not in it.
REPORTS="/tmp/medit-reports.$(basename "$ROOT")"
SKIP_LOGS=$REPORTS/logs BACKEND_RESULTS=$REPORTS/backend UNIT_RESULTS=$REPORTS/unit
! $HOLDS_SLOT || { rm -rf "$REPORTS" && mkdir -p "$SKIP_LOGS"; } || exit 1
BUDGET_SECONDS=300
! $MERGE_TO_MAIN || BUDGET_SECONDS=600
SECONDS=0

# Each unittest run in the slot leaves its verbose log, with every test's time, for skips.py and
# check_test_times.py. The console shows what neither reads: the failures.
unittest_discover() {
  local log=$1 status
  shift
  $HOLDS_SLOT || { python3 -m unittest discover -q "$@"; return; }
  python3 -m unittest discover -v --durations 0 "$@" > "$SKIP_LOGS/$log.unittest" 2>&1
  status=$?
  grep -Ev ' \.\.\. ok$|^Slowest test durations$|^[0-9]+\.[0-9]+s ' "$SKIP_LOGS/$log.unittest"
  return $status
}

! { $MERGE_REQUESTED && $MERGE_TIER_PAUSED; } || echo "$PAUSED_NOTICE"
echo "=== Gate 1: Comment discipline ==="
EXCLUDE_RE='^(references/|modbench/src/wire/generated/|tools/|styles/)|/(node_modules|bin|obj|dist|out|TestData)/|package-lock\.json$'
tracked() { (cd "$ROOT" && git ls-files "$@" | grep -Ev "$EXCLUDE_RE" | while read -r f; do [[ -f "$f" ]] && echo "$f"; done); }
COMMENT_CODE=$(tracked '*.cs' '*.ts' '*.tsx' '*.py')
COMMENT_DOCS=$(tracked '*.md')
MJS=$(tracked '*.mjs')
RAW_FILES=$(printf '%s\n%s\n%s\n' "$COMMENT_CODE" "$MJS" "$(tracked '*.sh' '*.yml' '*.json' '*.csproj' '*.props')" | grep -v '^$')
# Code gets two passes: comments as code, then the whole file as raw text, which reaches string
# literals. History and AdrLine are left to the raw pass so a comment hit is reported once.
NOT_RAW='.Name!="Repo.History" && .Name!="Repo.AdrLine"'
COMMENT_OK=true
VALE="$(bash "$ROOT/.claude/skills/validate/install-vale.sh")" || COMMENT_OK=false
(cd "$ROOT" && echo "$COMMENT_DOCS" | xargs -d '\n' -r "$VALE" --config=.vale.ini) || COMMENT_OK=false
(cd "$ROOT" && echo "$COMMENT_CODE" | xargs -d '\n' -r "$VALE" --config=.vale.ini --filter="$NOT_RAW") || COMMENT_OK=false
# Vale has no .mjs format and no alias into one, so each goes through stdin as JavaScript.
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  (cd "$ROOT" && "$VALE" --config=.vale.ini --filter="$NOT_RAW" --output=line --ext=.js < "$f" | sed "s|^stdin\.js|$f|"; exit "${PIPESTATUS[0]}") || COMMENT_OK=false
done <<< "$MJS"
(cd "$ROOT" && echo "$RAW_FILES" | xargs -d '\n' -r "$VALE" --config=.vale-raw.ini) || COMMENT_OK=false
(cd "$ROOT" && echo "$COMMENT_CODE" | xargs -d '\n' -r python3 .claude/hooks/comment-shape.py) || COMMENT_OK=false
(cd "$ROOT" && unittest_discover hooks -s .claude/hooks -p 'test_*.py') || COMMENT_OK=false
$COMMENT_OK || { echo "--- COMMENT GATE FAILED ---"; FAILED=true; }

echo "=== Gate 1: Architecture diagrams ==="
D2="$(bash "$ROOT/.claude/skills/validate/install-d2.sh")"
DIAGRAM_OK=true
D2_BUILD="$ROOT/tools/d2-build"
rm -rf "$D2_BUILD" && mkdir -p "$D2_BUILD"
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  rel="${f#spec/architecture/}"
  rel="${rel#docs/}"
  out="$D2_BUILD/${rel%.d2}.svg"
  mkdir -p "$(dirname "$out")"
  (cd "$ROOT" && "$D2" "$f" "$out") || DIAGRAM_OK=false
done <<< "$(tracked '*.d2')"
(cd "$ROOT" && python3 .claude/skills/validate/check_layers.py) || DIAGRAM_OK=false
$DIAGRAM_OK || { echo "--- ARCHITECTURE DIAGRAM GATE FAILED ---"; FAILED=true; }

echo "=== Gate runner tests ==="
# The gate's own tests start runs of it, which are branch runs.
(cd "$ROOT" && unset MEDIT_MERGE_TO_MAIN && unittest_discover validate -s .claude/skills/validate -p 'test_*.py') \
  || { echo "--- GATE RUNNER TESTS FAILED ---"; FAILED=true; }

ARCHITECTURE_SCANS=(MEditService.Architecture.Tests)

# A bare dotnet test runs a branch's tests: MEditService/Directory.Build.props holds their filter, and a
# filter on the command line would replace it.
backend_tests() {
  local results=$BACKEND_RESULTS changed selected
  rm -rf "$results" && mkdir -p "$results" || return
  changed=$(changed_since_base) || return
  selected=$(python3 "$ROOT/.claude/skills/validate/select_backend_tests.py" \
    "$ROOT/MEditService" "$results/selected.slnf" <<< "$changed") || return
  echo "Test projects: ${selected:-none, no backend change since $BASE}" | paste -sd ' '
  local dotnet_test=(dotnet test --no-build -v minimal --logger trx --results-directory "$results")
  if [[ -n $selected ]]; then
    (cd "$ROOT/MEditService" && "${dotnet_test[@]}" "$results/selected.slnf") || return
  fi
  # The architecture scans read every project's source, so a change to any project can fail one.
  if { [[ -n $selected ]] || $DOCS; } && ! grep -qx MEditService.Architecture.Tests <<< "$selected"; then
    (cd "$ROOT/MEditService" && "${dotnet_test[@]}" "${ARCHITECTURE_SCANS[@]}") || return
  fi
}

if $BACKEND; then
  echo "=== Gate 2: Backend format ==="
  (cd "$ROOT/MEditService" && dotnet format --verify-no-changes) && \
  echo "=== Gate 2: Backend build/lint ===" && \
  (cd "$ROOT/MEditService" && dotnet build -v minimal) && \
  echo "=== Gate 3: Backend tests ===" && \
  backend_tests \
  || { echo "--- BACKEND GATES FAILED ---"; FAILED=true; }
fi

# The tests that read docs/ and spec/: the backend's architecture scans, and every frontend test
# importing one of the two modules that read spec/. The backend and frontend runs already hold them.
if $DOCS; then
  echo "=== Gate 3: Docs scans ==="
  if ! $BACKEND; then
    (cd "$ROOT/MEditService" && dotnet test -v minimal "${ARCHITECTURE_SCANS[@]}") \
    || { echo "--- DOCS SCAN GATE FAILED ---"; FAILED=true; }
  fi
  if ! $FRONTEND; then
    [[ -x "$ROOT/modbench/node_modules/.bin/vitest" ]] || (cd "$ROOT/modbench" && npm ci >/dev/null 2>&1)
    (cd "$ROOT/modbench" && npx vitest related --run --reporter=basic --reporter=json --outputFile.json="$SKIP_LOGS/docs.json" eslint-rules/boxes.mjs src/test/commandsCatalog.ts) \
    || { echo "--- DOCS SCAN GATE FAILED ---"; FAILED=true; }
  fi
fi

if $FRONTEND; then
  python3 "$ROOT/.claude/skills/validate/frontend_gates.py" "$ROOT" "$UNIT_RESULTS" \
  || { echo "--- FRONTEND GATES FAILED ---"; FAILED=true; }
fi

if $SCRIPTS; then
  echo "=== Gate 3: Scripts lint, types and tests ==="
  (cd "$ROOT/scripts" && uvx ruff@0.17.0 check . && uvx ty@0.0.88 check . && unittest_discover scripts) \
  || { echo "--- SCRIPTS GATE FAILED ---"; FAILED=true; }
fi

if $API_DRIFT; then
  bash "$ROOT/.claude/skills/validate/check-api-drift.sh" \
  || { echo "--- API DRIFT GATE FAILED ---"; FAILED=true; }
fi

if $MERGE_TO_MAIN; then
  echo "=== Skipped tests ==="
  python3 "$ROOT/.claude/skills/validate/skips.py" "$REPORTS" || FAILED=true
fi

if $HOLDS_SLOT; then
  echo "=== Test times and budget ==="
  python3 "$ROOT/.claude/skills/validate/check_test_times.py" "$REPORTS" "$SECONDS" "$BUDGET_SECONDS"
fi

if $FAILED; then
  exit 1
fi

echo ""
echo "=== All mechanical gates passed ==="
