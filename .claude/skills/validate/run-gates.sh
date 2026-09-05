#!/usr/bin/env bash

BACKEND=false
FRONTEND=false
API_DRIFT=false
FAILED=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --backend)   BACKEND=true;   shift ;;
    --frontend)  FRONTEND=true;  shift ;;
    --api-drift) API_DRIFT=true; shift ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "=== Gate 1: Comment discipline ==="
EXCLUDE_RE='^(references/|modbench/src/medit/generated/|tools/)|/(node_modules|bin|obj|dist|out)/'
COMMENT_CODE=$(cd "$ROOT" && git ls-files '*.cs' '*.ts' '*.tsx' \
  | grep -Ev "$EXCLUDE_RE" \
  | while read -r f; do [[ -f "$f" ]] && echo "$f"; done)
COMMENT_DOCS=$(cd "$ROOT" && git ls-files '*.md' \
  | grep -Ev "$EXCLUDE_RE" \
  | while read -r f; do [[ -f "$f" ]] && echo "$f"; done)
# Ticket numbers are checked in every tracked text file, not just the ones Vale's comment styles
# understand — comment-shape.py's ticket check runs on its own text, no comment syntax needed.
TICKET_SCAN_ONLY=$(cd "$ROOT" && git ls-files '*.py' '*.sh' '*.yml' '*.json' \
  | grep -Ev "$EXCLUDE_RE" \
  | grep -v '^package-lock\.json$' \
  | while read -r f; do [[ -f "$f" ]] && echo "$f"; done)
COMMENT_FILES=$(printf '%s\n%s\n' "$COMMENT_CODE" "$COMMENT_DOCS" | grep -v '^$')
SHAPE_FILES=$(printf '%s\n%s\n' "$COMMENT_FILES" "$TICKET_SCAN_ONLY" | grep -v '^$')
if [[ -n "$SHAPE_FILES" ]]; then
  COMMENT_OK=true
  if [[ -n "$COMMENT_FILES" ]]; then
    VALE="$(bash "$ROOT/.claude/skills/validate/install-vale.sh")" || COMMENT_OK=false
    (cd "$ROOT" && echo "$COMMENT_FILES" | xargs -d '\n' "$VALE" --config=.vale.ini) || COMMENT_OK=false
  fi
  (cd "$ROOT" && echo "$SHAPE_FILES" | xargs -d '\n' -r python3 .claude/hooks/comment-shape.py) || COMMENT_OK=false
  $COMMENT_OK || { echo "--- COMMENT GATE FAILED ---"; FAILED=true; }
fi

if $BACKEND; then
  echo "=== Gate 2: Backend format ==="
  (cd "$ROOT/MEditService" && dotnet format --verify-no-changes) && \
  echo "=== Gate 2: Backend build/lint ===" && \
  (cd "$ROOT/MEditService" && dotnet build -v minimal) && \
  echo "=== Gate 3: Backend tests ===" && \
  (cd "$ROOT/MEditService" && dotnet test -v minimal) \
  || { echo "--- BACKEND GATES FAILED ---"; FAILED=true; }
fi

# flock on the integration step: its mock backend binds a fixed port (15172), so concurrent
# gate runs (a second worktree, a pipelined orchestrate slot) serialize on that step only.
if $FRONTEND; then
  echo "=== Gate 4: Frontend lint ==="
  (cd "$ROOT/modbench" && npm run lint) && \
  echo "=== Gate 5: Frontend build (type-check) ===" && \
  (cd "$ROOT/modbench" && npm run build) && \
  echo "=== Gate 6: Frontend tests ===" && \
  (cd "$ROOT/modbench" && npm run test:unit && flock /tmp/modbench-itest.lock npm run test:integration) \
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
