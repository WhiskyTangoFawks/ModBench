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
EXCLUDE_RE='^(references/|modbench/src/medit/generated/|tools/|styles/)|/(node_modules|bin|obj|dist|out|TestData)/|package-lock\.json$'
tracked() { (cd "$ROOT" && git ls-files "$@" | grep -Ev "$EXCLUDE_RE" | while read -r f; do [[ -f "$f" ]] && echo "$f"; done); }
COMMENT_CODE=$(tracked '*.cs' '*.ts' '*.tsx' '*.py')
COMMENT_DOCS=$(tracked '*.md')
MJS=$(tracked '*.mjs')
RAW_FILES=$(printf '%s\n%s\n%s\n' "$COMMENT_CODE" "$MJS" "$(tracked '*.sh' '*.yml' '*.json' '*.csproj' '*.props')" | grep -v '^$')
# Code gets two passes: comments as code, then the whole file as raw text, which reaches string
# literals. History and Ticket are left to the raw pass so a comment hit is reported once.
NOT_RAW='.Name!="Repo.History" && .Name!="Repo.Ticket"'
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
