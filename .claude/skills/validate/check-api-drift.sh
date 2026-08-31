#!/usr/bin/env bash
# Fails if modbench/src/medit/generated/api.ts has drifted from the live
# OpenAPI spec. Boots a fresh backend, then uses openapi-typescript's own
# --check flag (a pure read/compare — it never writes to the destination file,
# verified empirically) against the committed api.ts in place. No temp file,
# no diff/restore dance needed.

set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
API_TS="$ROOT/modbench/src/medit/generated/api.ts"
BOOT_LOG="$(mktemp /tmp/api-drift-boot.XXXXXX.log)"
STATUS=1

cleanup() {
  pkill -f "MEditService.Api" 2>/dev/null
  rm -f "$BOOT_LOG"
}
trap cleanup EXIT

echo "=== Gate 7: API drift (api.ts vs live OpenAPI spec) ==="

pkill -f "MEditService.Api" 2>/dev/null
sleep 1

(cd "$ROOT/MEditService/MEditService.Api" && exec dotnet run >"$BOOT_LOG" 2>&1) &

BOOT_TIMEOUT_S=180
elapsed=0
until curl -sf http://localhost:5172/health >/dev/null 2>&1; do
  sleep 2
  elapsed=$((elapsed + 2))
  if [ "$elapsed" -ge "$BOOT_TIMEOUT_S" ]; then
    echo "--- API DRIFT GATE FAILED: backend did not boot within ${BOOT_TIMEOUT_S}s ---"
    echo "--- last 50 lines of backend output ($BOOT_LOG) ---"
    tail -50 "$BOOT_LOG"
    exit 1
  fi
done

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

if "$OPENAPI_TS" http://localhost:5172/swagger/v1/swagger.json -o "$API_TS" --check; then
  echo "=== api.ts is up-to-date with the live OpenAPI spec ==="
  STATUS=0
else
  echo "--- API DRIFT GATE FAILED: api.ts is stale — run npm run generate-api (see /regenerate-api) and commit the result ---"
  STATUS=1
fi

exit "$STATUS"
