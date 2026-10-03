#!/usr/bin/env bash

BACKEND=false
FRONTEND=false
API_DRIFT=false
DOCS=false
DETACH=false
WAIT=false
FAILED=false
GATE_ARGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --backend)   BACKEND=true;   GATE_ARGS+=("$1"); shift ;;
    --frontend)  FRONTEND=true;  GATE_ARGS+=("$1"); shift ;;
    --api-drift) API_DRIFT=true; GATE_ARGS+=("$1"); shift ;;
    --docs)      DOCS=true;      GATE_ARGS+=("$1"); shift ;;
    --comments)                  GATE_ARGS+=("$1"); shift ;;
    --detach)    DETACH=true;    shift ;;
    --wait)      WAIT=true;      shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DETACHED_SH="$ROOT/.claude/skills/validate/detached.sh"
GATE_NAME="gates.$(basename "$ROOT")"
$WAIT && exec bash "$DETACHED_SH" wait "$GATE_NAME"
$DETACH && exec bash "$DETACHED_SH" start "$GATE_NAME" bash "$0" "${GATE_ARGS[@]}"

changed_since_main() {
  local base
  base=$(git -C "$ROOT" merge-base main HEAD) || return
  git -C "$ROOT" diff --name-only --no-renames "$base" && git -C "$ROOT" ls-files --others --exclude-standard
}

if [[ ${GATE_ARGS[*]} != --comments ]] && ! git -C "$ROOT" merge-base --is-ancestor main HEAD; then
  echo "Refused: HEAD is behind main. Merge main first, so the gates test the tree that will land."
  exit 1
fi

if [[ ${#GATE_ARGS[@]} -eq 0 ]]; then
  changed=$(changed_since_main) || exit 1
  selection=$(python3 "$ROOT/.claude/skills/validate/select_gates.py" <<< "$changed") || exit 1
  echo "=== Gates the change since main can break ==="
  echo "${selection:-none beyond Gate 1}"
  flags=$(cut -d' ' -f1 <<< "$selection")
  exec bash "$0" ${flags:---comments}
fi

# Runs a command in one of a machine-wide count of slots. -o keeps the lock out of child
# processes, so a lingering build server cannot hold it. A waiter queues on the first slot rather
# than whichever frees first, which costs a wait, never correctness.
in_slot() {
  local kind=$1 slots=$2 slot status
  shift 2
  for slot in $(seq 1 "$slots"); do
    flock -n -E 99 -o "/tmp/medit-$kind-gate.$slot.lock" "$@"
    status=$?
    [[ $status -ne 99 ]] && return $status
  done
  echo "=== Waiting for a $kind gate slot ==="
  flock -o "/tmp/medit-$kind-gate.1.lock" "$@"
}

# Two backend gate runs per machine, measured: a third leaves no memory headroom. api-drift
# builds and boots a backend, and docs builds the backend tests, so each takes a slot too.
if { $BACKEND || $API_DRIFT || $DOCS; } && [[ -z ${GATE_SLOT:-} ]]; then
  GATE_SLOT=held in_slot backend 2 "$0" "${GATE_ARGS[@]}"
  exit
fi

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
(cd "$ROOT" && python3 -m unittest discover -q -s .claude/hooks -p 'test_*.py') || COMMENT_OK=false
$COMMENT_OK || { echo "--- COMMENT GATE FAILED ---"; FAILED=true; }

echo "=== Gate 1: Architecture diagrams ==="
D2="$(bash "$ROOT/.claude/skills/validate/install-d2.sh")"
DIAGRAM_OK=true
D2_BUILD="$ROOT/tools/d2-build"
rm -rf "$D2_BUILD" && mkdir -p "$D2_BUILD"
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  rel="${f#docs/architecture/}"
  out="$D2_BUILD/${rel%.d2}.svg"
  mkdir -p "$(dirname "$out")"
  (cd "$ROOT" && "$D2" "$f" "$out") || DIAGRAM_OK=false
done <<< "$(tracked '*.d2')"
(cd "$ROOT" && python3 .claude/skills/validate/check_layers.py) || DIAGRAM_OK=false
$DIAGRAM_OK || { echo "--- ARCHITECTURE DIAGRAM GATE FAILED ---"; FAILED=true; }

echo "=== Gate runner tests ==="
(cd "$ROOT" && python3 -m unittest discover -q -s .claude/skills/validate -p 'test_*.py') \
  || { echo "--- GATE RUNNER TESTS FAILED ---"; FAILED=true; }

ARCHITECTURE_SCANS=(MEditService.Http.Tests --filter "FullyQualifiedName~MEditService.Http.Tests.Architecture.")

backend_tests() {
  local results="/tmp/medit-test-results.$(basename "$ROOT")" changed selected
  rm -rf "$results" && mkdir -p "$results" || return
  changed=$(changed_since_main) || return
  selected=$(python3 "$ROOT/.claude/skills/validate/select_backend_tests.py" \
    "$ROOT/MEditService" "$results/selected.slnf" <<< "$changed") || return
  echo "Test projects: ${selected:-none, no backend change since main}" | paste -sd ' '
  local dotnet_test=(dotnet test --no-build -v minimal --logger trx --results-directory "$results")
  if [[ -n $selected ]]; then
    (cd "$ROOT/MEditService" && "${dotnet_test[@]}" "$results/selected.slnf") || return
  fi
  # The architecture scans read every project's source, so a change to any project can fail one.
  if { [[ -n $selected ]] || $DOCS; } && ! grep -qx MEditService.Http.Tests <<< "$selected"; then
    (cd "$ROOT/MEditService" && "${dotnet_test[@]}" "${ARCHITECTURE_SCANS[@]}") || return
  fi
  echo "=== Gate 3: Backend test times ==="
  python3 "$ROOT/.claude/skills/validate/check_test_times.py" "$results"
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

# The tests that read docs/ and CONTEXT.md: the backend's architecture scans, and the frontend's
# check of every Command ID against commands.md. The backend and frontend runs already hold them.
if $DOCS; then
  echo "=== Gate 3: Docs scans ==="
  if ! $BACKEND; then
    (cd "$ROOT/MEditService" && dotnet test -v minimal "${ARCHITECTURE_SCANS[@]}") \
    || { echo "--- DOCS SCAN GATE FAILED ---"; FAILED=true; }
  fi
  if ! $FRONTEND; then
    (cd "$ROOT/modbench" && npm run test:unit -- src/test/packageJson.test.ts) \
    || { echo "--- DOCS SCAN GATE FAILED ---"; FAILED=true; }
  fi
fi

# Two frontend gate runs per machine, measured: a run peaks near 3 GB, and a third slows the
# slowest unit test past its ceiling.
if $FRONTEND; then
  in_slot frontend 2 python3 "$ROOT/.claude/skills/validate/frontend_gates.py" "$ROOT" \
  || { echo "--- FRONTEND GATES FAILED ---"; FAILED=true; }
fi

if $API_DRIFT; then
  bash "$ROOT/.claude/skills/validate/check-api-drift.sh" \
  || { echo "--- API DRIFT GATE FAILED ---"; FAILED=true; }
fi

if $FAILED; then
  exit 1
fi

echo ""
echo "=== All mechanical gates passed ==="
