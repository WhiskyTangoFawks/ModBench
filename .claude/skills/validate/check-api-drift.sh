#!/usr/bin/env bash
# Fails if modbench/src/wire/generated/api.ts has drifted from the live OpenAPI spec of a
# backend built from this checkout. openapi-typescript's --check is a pure read/compare against
# the committed api.ts. `--write` regenerates api.ts from the same backend instead.

set -u

MODE=--check
case ${1:-} in
  "") ;;
  --write) MODE=--write ;;
  *) echo "usage: check-api-drift.sh [--write]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
API_TS="$ROOT/modbench/src/wire/generated/api.ts"
PROJECT="$ROOT/MEditService/MEditService.Http"
source "$ROOT/.claude/skills/validate/own-backend.sh"

[[ $MODE == --check ]] && echo "=== Gate 7: API drift (api.ts vs live OpenAPI spec) ==="

# Never `npx openapi-typescript`: with no local match npx fetches a same-named package
# from the registry — an unpinned version whose generator output can differ from the
# repo's pinned one, producing generator-version-driven false positives/negatives
# instead of a loud clear failure. Same pinning rule `npm run package` already applies
# to vsce, and the mutation-test JS runner (run-js.sh) applies to Stryker. Detached
# review worktrees never carry node_modules, so install rather than fail.
OPENAPI_TS="$ROOT/modbench/node_modules/.bin/openapi-typescript"
if [[ ! -x "$OPENAPI_TS" ]]; then
  echo "No local openapi-typescript binary — installing dependencies (npm ci)..."
  (cd "$ROOT/modbench" && npm ci >/dev/null 2>&1) || { echo "ERROR: npm ci failed; cannot run openapi-typescript." >&2; exit 1; }
  [[ -x "$OPENAPI_TS" ]] || { echo "ERROR: $OPENAPI_TS missing after npm ci." >&2; exit 1; }
fi

# The build runs outside the backend's process group: the MSBuild and compiler servers it
# leaves behind are shared with every other build on the machine.
dotnet build "$PROJECT" -nologo -v quiet \
  || { echo "--- API DRIFT GATE FAILED: backend build failed ---"; exit 1; }
BACKEND_DLL="$(dotnet msbuild "$PROJECT" -nologo -getProperty:TargetPath)"

start_own_backend dotnet "$BACKEND_DLL" \
  || { echo "--- API DRIFT GATE FAILED: backend did not boot ---"; exit 1; }
SPEC_URL="$OWN_BACKEND_URL/swagger/v1/swagger.json"

if [[ $MODE == --write ]]; then
  "$OPENAPI_TS" "$SPEC_URL" -o "$API_TS" || { echo "--- api.ts regeneration FAILED ---"; exit 1; }
  echo "=== api.ts regenerated from $SPEC_URL ==="
elif "$OPENAPI_TS" "$SPEC_URL" -o "$API_TS" --check; then
  echo "=== api.ts is up-to-date with the live OpenAPI spec ==="
else
  echo "--- API DRIFT GATE FAILED: api.ts is stale — run check-api-drift.sh --write (see /regenerate-api) and commit the result ---"
  exit 1
fi
