---
name: regenerate-api
description: How to regenerate TypeScript API client api.ts from OpenAPI spec. Use when you need to regenerate the API.
---

# Regenerate api.ts

`npm run generate-api` scrapes the spec from a running backend at `:5172`. A
running one is likely stale. Always kill → fresh start → regen → stop; never skip
the restart because a backend "looks up".

```bash
# kill stale backend
pkill -f "MEditService.Api" 2>/dev/null; sleep 1

# fresh start — no args needed; the web host + /health boot regardless.
# Run this one with Bash run_in_background: true, from the repo root:
dotnet run --project MEditService/MEditService.Api

# wait for boot (rebuilds, so slow)
until curl -sf http://localhost:5172/health >/dev/null 2>&1; do sleep 1; done

# regen, then stop
cd modbench && npm run generate-api
pkill -f "MEditService.Api"
```

Paths are relative to the repo root (`git rev-parse --show-toplevel`).

- `until` hangs → compile error; check backend output.
- Leaves backend stopped. Commit api.ts with the C# changes.
