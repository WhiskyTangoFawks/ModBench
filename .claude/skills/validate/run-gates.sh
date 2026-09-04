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

# Gate 1 runs on every invocation: comments are checked on the files changed against main.
echo "=== Gate 1: Comment discipline ==="
COMMENT_FILES=$(cd "$ROOT" && git diff --name-only --diff-filter=AM main -- '*.cs' '*.ts' '*.tsx' '*.md' \
  | grep -Ev '^(references/|modbench/src/medit/generated/|tools/)|/(node_modules|bin|obj|dist|out)/' \
  | while read -r f; do [[ -f "$f" ]] && echo "$f"; done)
if [[ -n "$COMMENT_FILES" ]]; then
  VALE="$(bash "$ROOT/.claude/skills/validate/install-vale.sh")" && \
  (cd "$ROOT" && echo "$COMMENT_FILES" | xargs "$VALE" --config=.vale.ini) && \
  (cd "$ROOT" && echo "$COMMENT_FILES" | grep -Ev '\.md$' | xargs -r python3 .claude/hooks/comment-shape.py) \
  || { echo "--- COMMENT GATE FAILED ---"; FAILED=true; }
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
